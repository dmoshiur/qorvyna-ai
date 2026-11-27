// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const confirm = vi.hoisted(() => vi.fn(async () => true));
vi.mock("@/components/dialogs", () => ({ useDialogs: () => ({ confirm, element: null }) }));
vi.mock("@/components/github-pull-request", () => ({ GithubPullRequest: () => null }));
vi.mock("@/components/github-pull-request-browser", () => ({ GithubPullRequestBrowser: () => null }));

import { GithubConnection } from "../src/components/github-connection";

const head = "a".repeat(40);
const file = { path: "src/feature.ts", content: "export const ok = true;\n", language: "typescript" };
const findButton = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll("button")].find((el) => el.textContent?.includes(text)) as HTMLButtonElement;

let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;

async function flush() {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function setNativeInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("GithubConnection — PAT save, AI repo creation, and Create Pull Request button", () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    confirm.mockClear();
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  it("saves a Personal Access Token without page reload and transitions to connected state", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/github/status" && (!init?.method || init.method === "GET")) {
        return Response.json({ configured: true, connected: false, connection: null });
      }
      if (url === "/api/github/status" && init?.method === "POST") {
        return Response.json({
          configured: true,
          connected: true,
          connection: { login: "saved-user", name: "Saved User", avatarUrl: "", connectedAt: "" },
        });
      }
      if (url === "/api/github/repos") {
        return Response.json({ repositories: [] });
      }
      throw new Error(`Unexpected ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => {
      root.render(<GithubConnection showPush files={[file]} />);
    });
    await flush();
    expect(container.textContent).toContain("Connect GitHub");

    await act(async () => {
      findButton(container, "Save token").click();
    });
    const patInput = container.querySelector("#github-pat-input") as HTMLInputElement;
    await act(async () => {
      setNativeInputValue(patInput, "ghp_synthetic_test_token_000000000000");
    });
    await act(async () => {
      findButton(container, "Save GitHub connection").click();
    });
    await flush();

    expect(container.textContent).toContain("@saved-user");
    expect(container.textContent).toContain("Saved GitHub connection for @saved-user");
  });

  it("creates a repository from AI suggestion and pushes code via Create Pull Request button", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/github/status") {
        return Response.json({ configured: true, connected: true, connection: { login: "octocat" } });
      }
      if (url === "/api/github/repos" && (!init?.method || init.method === "GET")) {
        return Response.json({ repositories: [] });
      }
      if (url === "/api/github/repos" && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        return Response.json(
          {
            repository: {
              id: 77,
              fullName: `octocat/${body.name}`,
              htmlUrl: `https://github.com/octocat/${body.name}`,
              private: true,
              defaultBranch: "main",
              permissions: { push: true },
            },
          },
          { status: 201 },
        );
      }
      if (url === "/api/github/preview" && init?.method === "POST") {
        return Response.json({
          head,
          expiresAt: Date.now() + 60_000,
          reviewToken: "signed-review-token",
          files: [{ path: file.path, before: null, after: file.content, status: "new" }],
        });
      }
      if (url === "/api/github/pull-requests/push" && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        expect(body).toMatchObject({
          source: "agent",
          repository: "octocat/stellar-ai-app",
          baseBranch: "main",
          headBranch: "qorvyna/agent-changes",
          reviewToken: "signed-review-token",
        });
        return Response.json(
          {
            commitSha: "b".repeat(40),
            commitUrl: "https://github.com/octocat/stellar-ai-app/commit/bbbb",
            branch: "qorvyna/agent-changes",
            baseBranch: "main",
            prNumber: 42,
            prUrl: "https://github.com/octocat/stellar-ai-app/pull/42",
          },
          { status: 201 },
        );
      }
      throw new Error(`Unexpected ${url} ${init?.method ?? "GET"}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => {
      root.render(
        <GithubConnection
          showPush
          files={[file]}
          suggestedRepoName="Stellar AI App"
          autoOpenCreateRepo
        />,
      );
    });
    await flush();

    expect(container.textContent).toContain("@octocat");
    const repoNameInput = container.querySelector("#new-repo-name") as HTMLInputElement;
    expect(repoNameInput.value).toBe("stellar-ai-app");

    await act(async () => {
      findButton(container, "Create repository on GitHub").click();
    });
    await flush();
    expect(container.textContent).toContain("Created repository octocat/stellar-ai-app");

    const createPrBtn = findButton(container, "Create Pull Request");
    expect(createPrBtn.disabled).toBe(true);

    await act(async () => {
      findButton(container, "Compare with GitHub").click();
    });
    await flush();
    expect(container.textContent).toContain("Remote HEAD:");

    const checkboxes = [...container.querySelectorAll('input[type="checkbox"]')];
    const reviewBox = checkboxes.find((cb) =>
      cb.parentElement?.textContent?.includes("I reviewed the comparison"),
    ) as HTMLInputElement;
    await act(async () => {
      reviewBox.click();
    });
    expect(createPrBtn.disabled).toBe(false);

    await act(async () => {
      createPrBtn.click();
    });
    await flush();
    expect(confirm).toHaveBeenCalledOnce();

    const links = [...container.querySelectorAll("a")];
    const prLink = links.find((a) => a.textContent?.includes("View PR #42"));
    const commitLink = links.find((a) => a.textContent?.includes("View commit"));
    expect(prLink?.getAttribute("href")).toBe("https://github.com/octocat/stellar-ai-app/pull/42");
    expect(commitLink?.getAttribute("href")).toBe("https://github.com/octocat/stellar-ai-app/commit/bbbb");
  });
});
