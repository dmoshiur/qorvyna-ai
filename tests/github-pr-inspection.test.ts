import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/env", () => ({ env: { github: { tokenEncryptionKey: "test-key-that-is-longer-than-32-characters" } }, isGithubConfigured: () => true }));
vi.mock("@/lib/firebase/admin", async () => { const { sharedFirestoreStub, makeAdminModule } = await import("./helpers/firestore-stub"); return makeAdminModule(sharedFirestoreStub()); });
import { sharedFirestoreStub } from "./helpers/firestore-stub";
import { encryptGithubToken } from "@/lib/server/github";
import { inspectGithubPullRequest, listGithubPullRequests } from "@/lib/server/github-pr-read";
const db = sharedFirestoreStub();
const pr = { number: 8, title: "PR", body: "description", state: "open", draft: false, merged_at: null, html_url: "https://github.com/owner/repo/pull/8", updated_at: "2026-01-01T00:00:00Z", user: { login: "author" }, base: { ref: "main", sha: "a".repeat(40) }, head: { ref: "branch", sha: "b".repeat(40), repo: { full_name: "fork/repo" } }, changed_files: 2 };
beforeEach(() => { db._state.docs.clear(); db._state.docs.set("github_connections/owner", { access_token_encrypted: encryptGithubToken("fake-test-token") }); });
afterEach(() => vi.restoreAllMocks());
function github(options: { changed?: boolean } = {}) {
  let reads = 0;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname.endsWith("/pulls")) return Response.json([pr]);
    if (parsed.pathname.endsWith("/pulls/8/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, patch: "+line" }, { filename: "image.png", status: "added", additions: 0, deletions: 0 }]);
    if (parsed.pathname.endsWith("/pulls/8")) { reads++; return Response.json(options.changed && reads === 2 ? { ...pr, head: { ...pr.head, sha: "c".repeat(40) } } : pr); }
    throw new Error("unexpected");
  });
}
describe("GitHub PR inspection", () => {
  it("lists bounded metadata without leaking OAuth tokens", async () => {
    const fetch = github(); const result = await listGithubPullRequests("owner", "owner/repo", 1);
    expect(result.pullRequests[0]).toMatchObject({ number: 8, headRepository: "fork/repo", headSha: "b".repeat(40) });
    expect(JSON.stringify(result)).not.toContain("fake-test-token");
    expect(String(fetch.mock.calls[0][0])).toContain("per_page=20&page=1");
  });
  it("shows missing patches as incomplete and rechecks the PR revision", async () => {
    const fetch = github(); const result = await inspectGithubPullRequest("owner", "owner/repo", 8, 1);
    expect(result.files[0].patch).toBe("+line"); expect(result.files[1].patch).toBeNull();
    expect(result.patchesIncomplete).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it("refuses to combine files with a changed PR", async () => {
    github({ changed: true });
    await expect(inspectGithubPullRequest("owner", "owner/repo", 8, 1)).rejects.toThrow("GITHUB_HEAD_CHANGED");
  });
  it("prevents path injection, unbounded pages and cross-user credentials", async () => {
    const fetch = github();
    await expect(listGithubPullRequests("owner", "../repo", 1)).rejects.toThrow("TARGET_INVALID");
    await expect(inspectGithubPullRequest("owner", "owner/repo", 8, 11)).rejects.toThrow("PR_INPUT_INVALID");
    await expect(inspectGithubPullRequest("owner", "owner/repo", -1, 1)).rejects.toThrow("PR_INPUT_INVALID");
    await expect(listGithubPullRequests("other", "owner/repo", 1)).rejects.toThrow("GITHUB_NOT_CONNECTED");
    expect(fetch).not.toHaveBeenCalled();
  });
});
