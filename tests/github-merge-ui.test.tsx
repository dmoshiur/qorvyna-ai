// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const confirm = vi.hoisted(() => vi.fn(async () => true));
vi.mock("@/components/dialogs", () => ({ useDialogs: () => ({ confirm, element: null }) }));
import { GithubMergeReview } from "@/components/github-merge-review";
let container: HTMLDivElement; let root: ReturnType<typeof createRoot>; let fetcher: ReturnType<typeof vi.fn>;
const button = (text: string) => [...container.querySelectorAll("button")].find((el) => el.textContent?.trim() === text)!;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container); confirm.mockReset(); confirm.mockResolvedValue(true);
  fetcher = vi.fn(async (url: string) => url.endsWith("/preview") ? Response.json({ title: "PR", base: "main", baseSha: "a".repeat(40), headSha: "b".repeat(40), files: [{ filename: "a.txt", previousFilename: "", status: "modified", additions: 1, deletions: 1, patch: "-old\n+new" }], expiresAt: Date.now() + 60000, reviewToken: "token" }) : Response.json({ merged: true, sha: "c".repeat(40) }));
  vi.stubGlobal("fetch", fetcher);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
describe("explicit merge UI", () => {
  it("requires a separate review, approval and confirmation", async () => {
    await act(async () => root.render(<GithubMergeReview repository="owner/repo" number={8} />));
    expect(fetcher).not.toHaveBeenCalled(); expect(button("Merge pull request")).toBeUndefined();
    await act(async () => button("Load merge review").click());
    expect(button("Merge pull request").disabled).toBe(true);
    expect(container.textContent).toContain("target branch may change");
    await act(async () => (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click());
    confirm.mockResolvedValueOnce(false);
    await act(async () => button("Merge pull request").click());
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => button("Merge pull request").click());
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("GitHub confirmed merge commit");
  });
  it("advises checking GitHub after an uncertain merge result", async () => {
    fetcher.mockImplementation(async (url: string) => url.endsWith("/preview") ? Response.json({ title: "PR", base: "main", baseSha: "a".repeat(40), headSha: "b".repeat(40), files: [], expiresAt: Date.now() + 60000, reviewToken: "token" }) : Response.json({ error: "GITHUB_ERROR" }, { status: 502 }));
    await act(async () => root.render(<GithubMergeReview repository="owner/repo" number={8} />));
    await act(async () => button("Load merge review").click());
    await act(async () => (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click());
    await act(async () => button("Merge pull request").click());
    expect(container.textContent).toContain("Check the PR on GitHub before trying again");
    expect(button("Merge pull request")).toBeUndefined();
  });
});
