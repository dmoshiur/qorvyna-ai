// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GithubPullRequestBrowser } from "@/components/github-pull-request-browser";
let container: HTMLDivElement; let root: ReturnType<typeof createRoot>; let fetcher: ReturnType<typeof vi.fn>;
const pr = { number: 8, title: "Example", state: "open", draft: false, merged: false, url: "https://github.com/owner/repo/pull/8", author: "author", base: "main", baseSha: "a".repeat(40), head: "work", headSha: "b".repeat(40), headRepository: "owner/repo" };
const button = (text: string) => [...container.querySelectorAll("button")].find((el) => el.textContent?.includes(text))!;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  fetcher = vi.fn(async (input: string) => input.includes("/inspect?") ? Response.json({ pullRequest: { ...pr, body: "<img src=x onerror=alert(1)>", bodyTruncated: false, changedFiles: 1 }, files: [{ filename: "a.txt", previousFilename: "", status: "modified", additions: 1, deletions: 1, patch: "+new", patchTruncated: false }], page: 1, hasMore: false, patchesIncomplete: false }) : Response.json({ pullRequests: [pr], page: 1, hasMore: false }));
  vi.stubGlobal("fetch", fetcher);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
describe("read-only PR browser", () => {
  it("loads a list, displays untrusted details as text, and offers no merge action", async () => {
    await act(async () => root.render(<GithubPullRequestBrowser repository="owner/repo" />));
    expect(fetcher).not.toHaveBeenCalled();
    await act(async () => button("Load pull requests").click());
    expect(container.textContent).toContain("#8 Example");
    await act(async () => button("#8 Example").click());
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("a.txt");
    expect(container.textContent).toContain("not a frozen review");
    expect([...container.querySelectorAll("button")].some((el) => el.textContent?.includes("Merge"))).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("tells the user to refresh when inspection races with a branch change", async () => {
    fetcher.mockImplementation(async (input: string) => input.includes("/inspect?") ? Response.json({ error: "GITHUB_HEAD_CHANGED" }, { status: 409 }) : Response.json({ pullRequests: [pr], page: 1, hasMore: false }));
    await act(async () => root.render(<GithubPullRequestBrowser repository="owner/repo" />));
    await act(async () => button("Load pull requests").click());
    await act(async () => button("#8 Example").click());
    expect(container.textContent).toContain("changed during inspection");
  });
});
