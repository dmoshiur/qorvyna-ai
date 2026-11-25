// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const confirm = vi.hoisted(() => vi.fn(async () => true));
vi.mock("@/components/dialogs", () => ({ useDialogs: () => ({ confirm, element: null }) }));
import { GithubPullRequest } from "@/components/github-pull-request";
let container: HTMLDivElement; let root: ReturnType<typeof createRoot>; let fetcher: ReturnType<typeof vi.fn>;
const button = (text: string) => [...container.querySelectorAll("button")].find((el) => el.textContent?.trim() === text)!;
function change(input: HTMLInputElement, value: string) { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); }
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container); confirm.mockClear();
  fetcher = vi.fn(async (url: string) => url.endsWith("/preview") ? Response.json({ baseSha: "a".repeat(40), headSha: "b".repeat(40), totalCommits: 1, files: [{ filename: "a.txt", status: "modified", additions: 1, deletions: 1, patch: "-old\n+new" }], expiresAt: Date.now() + 60000, reviewToken: "token" }) : Response.json({ number: 8, url: "https://github.com/owner/repo/pull/8" }));
  vi.stubGlobal("fetch", fetcher);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
describe("pull request UI", () => {
  it("requires a fresh comparison, separate approval and confirmation", async () => {
    await act(async () => root.render(<GithubPullRequest repository="owner/repo" defaultBranch="main" sourceBranch="feature" />));
    const inputs = container.querySelectorAll("input");
    await act(async () => change(inputs[1], "Test PR"));
    await act(async () => button("Compare branches").click());
    expect(container.textContent).toContain("a.txt");
    expect(container.textContent).toContain("Branches can change");
    expect(button("Create pull request").disabled).toBe(true);
    await act(async () => (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click());
    await act(async () => button("Create pull request").click());
    expect(confirm).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Pull request #8 created");
  });
  it("invalidates approval when a source branch changes and returns", async () => {
    const render = (branch: string) => root.render(<GithubPullRequest repository="owner/repo" defaultBranch="main" sourceBranch={branch} />);
    await act(async () => render("feature"));
    await act(async () => change(container.querySelectorAll("input")[1], "Title"));
    await act(async () => button("Compare branches").click());
    await act(async () => (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click());
    await act(async () => render("other"));
    await act(async () => render("feature"));
    expect(button("Create pull request").disabled).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
