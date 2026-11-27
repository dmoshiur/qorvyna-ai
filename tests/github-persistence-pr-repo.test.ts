import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
  env: {
    github: {
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      tokenEncryptionKey: "test-key-that-is-longer-than-32-characters",
      callbackUrl: "http://localhost:3000/api/github/callback",
    },
  },
  isGithubConfigured: () => true,
  daytonaConfig: () => ({ apiKey: "", target: "" }),
  isDaytonaConfigured: () => false,
}));

vi.mock("@/lib/firebase/admin", async () => {
  const { sharedFirestoreStub, makeAdminModule } = await import("./helpers/firestore-stub");
  return makeAdminModule(sharedFirestoreStub());
});

const getSessionUserMock = vi.fn();
vi.mock("@/lib/firebase/session", () => ({
  getSessionUser: (...args: unknown[]) => getSessionUserMock(...args),
}));

import { sharedFirestoreStub } from "./helpers/firestore-stub";
import {
  createGithubRepo,
  encryptGithubToken,
  previewGithubPush,
  pushAgentFilesViaPullRequest,
  verifyAndSaveGithubToken,
  verifyGithubConnectionStatus,
} from "../src/lib/server/github";
import { GET as statusGet, POST as statusPost } from "../src/app/api/github/status/route";
import { POST as reposPost, GET as reposGet } from "../src/app/api/github/repos/route";
import { POST as pushPrPost } from "../src/app/api/github/pull-requests/push/route";
import { GET as connectGet } from "../src/app/api/github/connect/route";
import { GET as callbackGet } from "../src/app/api/github/callback/route";
import { toolRegistry } from "../src/lib/ai/tools/registry";
import "../src/lib/ai/tools/index";

const stub = sharedFirestoreStub();
const HEAD = "a".repeat(40);
const TREE = "b".repeat(40);
const COMMIT = "e".repeat(40);

beforeEach(() => {
  stub._state.docs.clear();
  getSessionUserMock.mockReset();
  getSessionUserMock.mockResolvedValue({ uid: "user-1", email: "u@example.com", emailVerified: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GitHub connection persistence, repo creation, and PR code push", () => {
  it("saves encrypted PAT, passes request to getSessionUser, and preserves connection on transient 503", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/user") {
        return Response.json({ login: "octocat", name: "Octo Cat", avatar_url: "https://avatars.githubusercontent.com/u/1" });
      }
      throw new Error(`Unexpected ${path}`);
    });

    const saveReq = new NextRequest("http://localhost:3000/api/github/status", {
      method: "POST",
      headers: {
        Origin: "http://localhost:3000",
        Authorization: "Bearer synthetic-firebase-id-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ token: "ghp_synthetic_test_token_000000000000" }),
    });

    const saveRes = await statusPost(saveReq);
    expect(saveRes.status).toBe(200);
    expect(getSessionUserMock).toHaveBeenCalledWith(saveReq);
    const savedJson = await saveRes.json();
    expect(savedJson.connected).toBe(true);
    expect(savedJson.connection.login).toBe("octocat");
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Subsequent GET within TTL uses cached verified_at_ms without hitting GitHub /user again
    const getReq = new NextRequest("http://localhost:3000/api/github/status", {
      headers: { Authorization: "Bearer synthetic-firebase-id-token" },
    });
    const getRes = await statusGet(getReq);
    expect(getRes.status).toBe(200);
    expect(getSessionUserMock).toHaveBeenLastCalledWith(getReq);
    expect((await getRes.json()).connected).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Expire TTL and simulate transient GitHub 503 outage: connection MUST stay connected
    const existingDoc = stub._state.docs.get("github_connections/user-1") as Record<string, unknown>;
    stub._state.docs.set("github_connections/user-1", { ...existingDoc, verified_at_ms: 0 });
    fetchSpy.mockImplementationOnce(async () => new Response("Service Unavailable", { status: 503 }));

    const degraded = await verifyGithubConnectionStatus("user-1");
    expect(degraded.connected).toBe(true);
    expect(degraded.upstreamDegraded).toBe(true);
    expect(degraded.connection?.login).toBe("octocat");

    // Genuine 401 marks connection for reauthorization
    fetchSpy.mockImplementationOnce(async () => new Response("Unauthorized", { status: 401 }));
    const revoked = await verifyGithubConnectionStatus("user-1");
    expect(revoked.connected).toBe(false);
    expect(revoked.reauthorize).toBe(true);
  });

  it("supports popup OAuth flow without full-page redirect loop", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const target = String(url);
      if (target.includes("login/oauth/access_token")) {
        return Response.json({ access_token: "gho_synthetic_oauth_token_000000" });
      }
      if (target.endsWith("/user")) {
        return Response.json({ login: "popup-user", name: "Popup User" });
      }
      throw new Error(`Unexpected ${target}`);
    });

    const startRes = await connectGet(
      new NextRequest("http://localhost:3000/api/github/connect?next=%2Fsettings&mode=popup"),
    );
    expect(startRes.status).toBe(307);
    const state = startRes.cookies.get("matrix_github_oauth")?.value ?? "";
    const owner = startRes.cookies.get("matrix_github_oauth_owner")?.value ?? "";
    const ret = startRes.cookies.get("matrix_github_oauth_return")?.value ?? "";
    const mode = startRes.cookies.get("matrix_github_oauth_mode")?.value ?? "";
    expect(mode).toBe("popup");
    expect(ret).toBe("/settings?tab=integrations");

    const cbReq = new NextRequest(
      `http://localhost:3000/api/github/callback?code=temp-code&state=${encodeURIComponent(state)}`,
      {
        headers: {
          cookie: `matrix_github_oauth=${state}; matrix_github_oauth_owner=${owner}; matrix_github_oauth_return=${encodeURIComponent(ret)}; matrix_github_oauth_mode=${mode}`,
        },
      },
    );
    const cbRes = await callbackGet(cbReq);
    expect(cbRes.status).toBe(200);
    expect(cbRes.headers.get("content-type")).toContain("text/html");
    const html = await cbRes.text();
    expect(html).toContain("qorvyna:github-oauth");
    expect(html).toContain('"connected"');
  });

  it("creates a GitHub repository via API route & approval-gated AI tool and binds project target", async () => {
    stub._state.docs.set("github_connections/user-1", {
      access_token_encrypted: encryptGithubToken("ghp_synthetic_test_token_000000000000"),
      login: "octocat",
      verified_at_ms: Date.now(),
    });
    stub._state.docs.set("projects/proj-1", {
      owner_id: "user-1",
      title: "AI Demo",
    });

    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === "/user/repos" && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        return Response.json({
          id: 9001,
          full_name: `octocat/${body.name}`,
          html_url: `https://github.com/octocat/${body.name}`,
          private: body.private,
          default_branch: "main",
        });
      }
      if (path === "/user/repos") {
        return Response.json([
          {
            id: 9001,
            full_name: "octocat/ai-demo",
            private: true,
            default_branch: "main",
            permissions: { push: true },
          },
        ]);
      }
      throw new Error(`Unexpected ${path}`);
    });

    const createReq = new NextRequest("http://localhost:3000/api/github/repos", {
      method: "POST",
      headers: {
        Origin: "http://localhost:3000",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "ai-demo",
        description: "Created from QORVYNA AI",
        private: true,
        autoInit: true,
        projectId: "proj-1",
      }),
    });
    const createRes = await reposPost(createReq);
    expect(createRes.status).toBe(201);
    const createdJson = await createRes.json();
    expect(createdJson.repository.fullName).toBe("octocat/ai-demo");
    expect(createdJson.savedBinding).toEqual({ repository: "octocat/ai-demo", branch: "main" });

    // Saved binding is returned on GET /api/github/repos?projectId=proj-1
    const listRes = await reposGet(
      new NextRequest("http://localhost:3000/api/github/repos?projectId=proj-1"),
    );
    const listJson = await listRes.json();
    expect(listJson.savedBinding).toEqual({ repository: "octocat/ai-demo", branch: "main" });

    // Registered AI tool github.create_repo enforces approval gate before executing
    const toolSpec = toolRegistry.get("github.create_repo");
    expect(toolSpec).toBeDefined();
    expect(toolSpec?.approvalRequired).toBe(true);
    const ctx = { db: stub, uid: "user-1", email: "u@example.com", requestId: "req-1" };
    const unapproved = await toolRegistry.call(ctx, "github.create_repo", { name: "tool-repo" }, async () => true);
    expect(unapproved.ok).toBe(false);
    expect(unapproved.error).toBe("APPROVAL_REQUIRED");

    const approved = await toolRegistry.call(
      { ...ctx, approvalId: "approved-1" },
      "github.create_repo",
      { name: "tool-repo", description: "From tool" },
      async () => true,
      async () => true,
    );
    expect(approved.ok).toBe(true);
    expect((approved.data?.repository as { fullName?: string })?.fullName).toBe("octocat/tool-repo");
  });

  it("pushes reviewed code files onto a new branch and opens a Pull Request atomically", async () => {
    stub._state.docs.set("github_connections/user-1", {
      access_token_encrypted: encryptGithubToken("ghp_synthetic_test_token_000000000000"),
      login: "octocat",
      verified_at_ms: Date.now(),
    });

    const files = [
      { path: "src/index.ts", content: 'export const ready = true;\n', language: "typescript" },
    ];
    let createdBranchRef = false;

    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === "/repos/octocat/demo") return Response.json({ permissions: { push: true } });
      if (path === "/repos/octocat/demo/git/ref/heads/main") return Response.json({ object: { sha: HEAD } });
      if (path === "/repos/octocat/demo/git/ref/heads/qorvyna/feat-pr") {
        if (!createdBranchRef) return new Response("Not Found", { status: 404 });
        return Response.json({ object: { sha: HEAD } });
      }
      if (path === "/repos/octocat/demo/git/ref/heads/qorvyna/feat-pr-2") {
        return new Response("Not Found", { status: 404 });
      }
      if (path === `/repos/octocat/demo/git/commits/${HEAD}`) return Response.json({ tree: { sha: TREE } });
      if (path === `/repos/octocat/demo/git/trees/${TREE}`) return Response.json({ tree: [] });
      if (path === "/repos/octocat/demo/git/refs" && init?.method === "POST") {
        const payload = JSON.parse(String(init.body));
        expect(payload).toEqual({ ref: "refs/heads/qorvyna/feat-pr", sha: HEAD });
        createdBranchRef = true;
        return Response.json({ ref: payload.ref, object: { sha: HEAD } }, { status: 201 });
      }
      if (path === "/graphql" && init?.method === "POST") {
        const gql = JSON.parse(String(init.body));
        expect(gql.variables.input.branch).toEqual({
          repositoryNameWithOwner: "octocat/demo",
          branchName: "qorvyna/feat-pr",
        });
        expect(gql.variables.input.expectedHeadOid).toBe(HEAD);
        return Response.json({
          data: {
            createCommitOnBranch: {
              commit: {
                oid: COMMIT,
                url: `https://github.com/octocat/demo/commit/${COMMIT}`,
              },
            },
          },
        });
      }
      if (path === "/repos/octocat/demo/pulls" && init?.method === "POST") {
        const prBody = JSON.parse(String(init.body));
        expect(prBody).toMatchObject({
          title: "Add TypeScript entrypoint",
          base: "main",
          head: "qorvyna/feat-pr",
        });
        return Response.json({
          number: 17,
          html_url: "https://github.com/octocat/demo/pull/17",
        }, { status: 201 });
      }
      throw new Error(`Unexpected ${path} ${init?.method ?? "GET"}`);
    });

    const preview = await previewGithubPush("user-1", {
      repository: "octocat/demo",
      branch: "main",
      files,
    });

    const prReq = new NextRequest("http://localhost:3000/api/github/pull-requests/push", {
      method: "POST",
      headers: {
        Origin: "http://localhost:3000",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        source: "agent",
        repository: "octocat/demo",
        baseBranch: "main",
        headBranch: "qorvyna/feat-pr",
        title: "Add TypeScript entrypoint",
        body: "Automated PR from QORVYNA AI",
        message: "feat: add entrypoint",
        files,
        reviewToken: preview.reviewToken,
      }),
    });

    const prRes = await pushPrPost(prReq);
    expect(prRes.status).toBe(201);
    const prData = await prRes.json();
    expect(prData).toEqual({
      commitSha: COMMIT,
      commitUrl: `https://github.com/octocat/demo/commit/${COMMIT}`,
      branch: "qorvyna/feat-pr",
      baseBranch: "main",
      prNumber: 17,
      prUrl: "https://github.com/octocat/demo/pull/17",
    });

    // Replaying the consumed reviewToken must fail closed
    await expect(
      pushAgentFilesViaPullRequest("user-1", {
        repository: "octocat/demo",
        baseBranch: "main",
        headBranch: "qorvyna/feat-pr-2",
        title: "Replay attempt",
        message: "feat: replay",
        files,
        reviewToken: preview.reviewToken,
      }),
    ).rejects.toThrow("GITHUB_REVIEW_REQUIRED");
  });

  it("validates createGithubRepo and verifyAndSaveGithubToken inputs strictly", async () => {
    await expect(createGithubRepo("user-1", { name: "../bad-name" })).rejects.toThrow("REPO_NAME_INVALID");
    await expect(verifyAndSaveGithubToken("user-1", "short")).rejects.toThrow("GITHUB_TOKEN_INVALID");
  });
});
