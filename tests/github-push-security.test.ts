import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({ env: { github: { tokenEncryptionKey: "test-key-that-is-longer-than-32-characters" } }, isGithubConfigured: () => true }));
vi.mock("@/lib/firebase/admin", async () => {
  const { sharedFirestoreStub, makeAdminModule } = await import("./helpers/firestore-stub");
  return makeAdminModule(sharedFirestoreStub());
});
import { sharedFirestoreStub } from "./helpers/firestore-stub";
import { encryptGithubToken, decryptGithubToken, previewGithubPush, pushAgentFiles, validatePushFiles, verifyGithubReview } from "../src/lib/server/github";

const HEAD = "a".repeat(40);
const TREE = "b".repeat(40);
const DIR = "c".repeat(40);
const BLOB = "d".repeat(40);
const COMMIT = "e".repeat(40);
const input = { repository: "owner/repo", branch: "feature/test", message: "Review changes", files: [{ path: "src/a.ts", content: "new", language: "typescript" }, { path: "src/new.ts", content: "hello", language: "typescript" }] };

function mockGithub(options: { permission?: boolean; head?: string; mode?: string; graphError?: boolean; graphFailure?: boolean } = {}) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === "/repos/owner/repo") return Response.json({ permissions: { push: options.permission ?? true } });
    if (path.includes("/git/ref/heads/")) return Response.json({ object: { sha: options.head ?? HEAD } });
    if (path.endsWith(`/git/commits/${HEAD}`)) return Response.json({ tree: { sha: TREE } });
    if (path.endsWith(`/git/trees/${TREE}`)) return Response.json({ tree: [{ path: "src", type: "tree", mode: "040000", sha: DIR }] });
    if (path.endsWith(`/git/trees/${DIR}`)) return Response.json({ tree: [{ path: "a.ts", type: "blob", mode: options.mode ?? "100644", sha: BLOB, size: 3 }] });
    if (path.endsWith(`/git/blobs/${BLOB}`)) return Response.json({ encoding: "base64", size: 3, content: Buffer.from("old").toString("base64") });
    if (path === "/graphql") {
      if (options.graphFailure) return Response.json({ errors: [{ message: "Protected branch update failed" }] });
      if (options.graphError) return Response.json({ errors: [{ message: "expected head oid did not match" }] });
      return Response.json({ data: { createCommitOnBranch: { commit: { oid: COMMIT, url: `https://github.com/owner/repo/commit/${COMMIT}` } } } });
    }
    throw new Error(`Unexpected request ${path} ${init?.method}`);
  });
}
const stub = sharedFirestoreStub();
beforeEach(() => { stub._state.docs.clear(); stub._state.docs.set("github_connections/user", { access_token_encrypted: encryptGithubToken("fake-github-test-token") }); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("GitHub reviewed push", () => {
  it("encrypts tokens with authenticated encryption", () => {
    const encrypted = String(stub._state.docs.get("github_connections/user")?.access_token_encrypted);
    expect(encrypted).not.toContain("fake-github-test-token");
    expect(decryptGithubToken(encrypted)).toBe("fake-github-test-token");
    const parts = encrypted.split(".");
    parts[1] = Buffer.alloc(16).toString("base64url");
    expect(() => decryptGithubToken(parts.join("."))).toThrow();
  });
  it("fails closed when GitHub does not explicitly grant push permission", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({}));
    await expect(previewGithubPush("user", input)).rejects.toThrow("GITHUB_PUSH_FORBIDDEN");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("previews changed and new files at an immutable HEAD without exposing credentials", async () => {
    const fetch = mockGithub();
    const result = await previewGithubPush("user", input);
    expect(result.head).toBe(HEAD);
    expect(result.files).toEqual([{ path: "src/a.ts", before: "old", after: "new", status: "changed" }, { path: "src/new.ts", before: null, after: "hello", status: "new" }]);
    expect(JSON.stringify(result)).not.toContain("fake-github-test-token");
    expect(fetch.mock.calls.every(([url]) => String(url).startsWith("https://api.github.com/"))).toBe(true);
  });
  it("binds the review to the owner, exact target and files and expires it", async () => {
    mockGithub();
    const preview = await previewGithubPush("user", input);
    expect(verifyGithubReview(preview.reviewToken, "user", input).head).toBe(HEAD);
    expect(() => verifyGithubReview(preview.reviewToken, "other", input)).toThrow("GITHUB_REVIEW_REQUIRED");
    expect(() => verifyGithubReview(preview.reviewToken, "user", { ...input, branch: "main" })).toThrow("GITHUB_REVIEW_REQUIRED");
    expect(() => verifyGithubReview(preview.reviewToken, "user", { ...input, files: [{ ...input.files[0], content: "tampered" }] })).toThrow("GITHUB_REVIEW_REQUIRED");
    expect(() => verifyGithubReview(`${preview.reviewToken}x`, "user", input)).toThrow("GITHUB_REVIEW_REQUIRED");
    expect(() => verifyGithubReview(preview.reviewToken, "user", input, preview.expiresAt)).toThrow("GITHUB_REVIEW_REQUIRED");
  });
  it("uses GitHub's atomic expectedHeadOid mutation with exact reviewed files", async () => {
    const fetch = mockGithub();
    const preview = await previewGithubPush("user", input);
    const result = await pushAgentFiles("user", { ...input, reviewToken: preview.reviewToken });
    expect(result.commitSha).toBe(COMMIT);
    await expect(pushAgentFiles("user", { ...input, reviewToken: preview.reviewToken })).rejects.toThrow("GITHUB_REVIEW_REQUIRED");
    const [url, init] = fetch.mock.calls.findLast(([url]) => String(url).endsWith("/graphql"))!;
    expect(String(url)).toBe("https://api.github.com/graphql");
    const mutation = JSON.parse(String(init?.body));
    expect(mutation.variables.input).toMatchObject({ branch: { repositoryNameWithOwner: "owner/repo", branchName: "feature/test" }, expectedHeadOid: HEAD, message: { headline: "Review changes" } });
    expect(mutation.variables.input.fileChanges.additions).toEqual(input.files.map((file) => ({ path: file.path, contents: Buffer.from(file.content).toString("base64") })));
  });
  it("rejects a changed HEAD before any mutation and reports atomic-race conflicts", async () => {
    let fetch = mockGithub();
    const preview = await previewGithubPush("user", input);
    fetch.mockRestore();
    fetch = mockGithub({ head: "f".repeat(40) });
    await expect(pushAgentFiles("user", { ...input, reviewToken: preview.reviewToken })).rejects.toThrow("GITHUB_HEAD_CHANGED");
    expect(fetch.mock.calls.some(([url]) => String(url).endsWith("/graphql"))).toBe(false);
    fetch.mockRestore();
    mockGithub({ graphError: true });
    await expect(pushAgentFiles("user", { ...input, reviewToken: preview.reviewToken })).rejects.toThrow("GITHUB_HEAD_CHANGED");
  });
  it("never reports a GraphQL rejection as a successful commit", async () => {
    let fetch = mockGithub();
    const preview = await previewGithubPush("user", input);
    fetch.mockRestore();
    fetch = mockGithub({ graphFailure: true });
    await expect(pushAgentFiles("user", { ...input, reviewToken: preview.reviewToken })).rejects.toThrow("GITHUB_COMMIT_REJECTED");
  });
  it("rejects remote symlinks and executable files instead of changing their modes", async () => {
    mockGithub({ mode: "120000" });
    await expect(previewGithubPush("user", input)).rejects.toThrow("GITHUB_REMOTE_FILE_UNSUPPORTED");
  });
  it("rejects unsafe, duplicate and binary files", () => {
    expect(() => validatePushFiles([{ path: "../secret", content: "x" }])).toThrow();
    expect(() => validatePushFiles([{ path: "src/.env.local", content: "x" }])).toThrow("FILES_SENSITIVE");
    expect(() => validatePushFiles([{ path: "settings.txt", content: "-----BEGIN PRIVATE KEY-----" }])).toThrow("FILES_SENSITIVE");
    expect(() => validatePushFiles([{ path: "a.txt", content: "x" }, { path: "a.txt", content: "y" }])).toThrow("FILES_INVALID");
    expect(() => validatePushFiles([{ path: "img.png", content: "AAAA", encoding: "base64" }])).toThrow("FILES_BINARY_UNSUPPORTED");
    expect(() => validatePushFiles(Array.from({ length: 41 }, () => ({ path: "x", content: "x" })))).toThrow();
  });
});
