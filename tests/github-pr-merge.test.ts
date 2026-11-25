import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/env", () => ({ env: { github: { tokenEncryptionKey: "test-key-that-is-longer-than-32-characters" } }, isGithubConfigured: () => true }));
vi.mock("@/lib/firebase/admin", async () => { const { sharedFirestoreStub, makeAdminModule } = await import("./helpers/firestore-stub"); return makeAdminModule(sharedFirestoreStub()); });
import { sharedFirestoreStub } from "./helpers/firestore-stub";
import { encryptGithubToken } from "@/lib/server/github";
import { mergeGithubPullRequest, previewGithubMerge } from "@/lib/server/github-pr-merge";
const db = sharedFirestoreStub(); const baseSha = "a".repeat(40), headSha = "b".repeat(40), mergeSha = "c".repeat(40);
const input = { repository: "owner/repo", number: 8 };
const pr = { number: 8, title: "Changes", state: "open", draft: false, merged: false, mergeable: true, changed_files: 1, updated_at: "now", base: { ref: "main", sha: baseSha, repo: { full_name: "owner/repo" } }, head: { sha: headSha, repo: { full_name: "owner/repo" } } };
function mock(options: { permission?: boolean; head?: string; base?: string; fork?: boolean; patch?: boolean; conflict?: boolean; fail?: boolean; unknown?: boolean } = {}) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === "/repos/owner/repo") return Response.json({ permissions: { push: options.permission ?? true } });
    if (path.endsWith("/pulls/8/files")) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 1, ...(options.patch === false ? {} : { patch: "-old\n+new" }) }]);
    if (path.endsWith("/pulls/8/merge")) {
      if (options.fail) throw new Error("lost response");
      if (options.conflict) return Response.json({}, { status: 409 });
      if (options.unknown) return Response.json({ merged: false });
      return Response.json({ merged: true, sha: mergeSha });
    }
    if (path.endsWith("/pulls/8")) return Response.json({ ...pr, base: { ...pr.base, sha: options.base ?? baseSha }, head: { ...pr.head, sha: options.head ?? headSha, repo: { full_name: options.fork ? "other/repo" : "owner/repo" } } });
    throw new Error(`unexpected ${path} ${init?.method}`);
  });
}
beforeEach(() => { db._state.docs.clear(); db._state.docs.set("github_connections/user", { access_token_encrypted: encryptGithubToken("fake-test-token") }); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
describe("explicit PR merge", () => {
  it("previews, sends the reviewed head SHA and consumes the review once", async () => {
    const fetch = mock(); const review = await previewGithubMerge("user", input);
    expect(review).toMatchObject({ base: "main", baseSha, headSha, files: [{ filename: "src/a.ts", patch: "-old\n+new" }] });
    const result = await mergeGithubPullRequest("user", input, review.reviewToken);
    expect(result).toEqual({ merged: true, sha: mergeSha });
    const [url, request] = fetch.mock.calls.find(([u]) => String(u).endsWith("/merge"))!;
    expect(String(url)).toBe("https://api.github.com/repos/owner/repo/pulls/8/merge");
    expect(request?.method).toBe("PUT");
    expect(JSON.parse(String(request?.body))).toEqual({ sha: headSha, merge_method: "merge" });
    await expect(mergeGithubPullRequest("user", input, review.reviewToken)).rejects.toThrow("GITHUB_REVIEW_REQUIRED");
    expect(fetch.mock.calls.filter(([u]) => String(u).endsWith("/merge"))).toHaveLength(1);
  });
  it("binds review to user, repository, PR, signature and expiry", async () => {
    mock(); const review = await previewGithubMerge("user", input);
    await expect(mergeGithubPullRequest("other", input, review.reviewToken)).rejects.toThrow("GITHUB_REVIEW_REQUIRED");
    await expect(mergeGithubPullRequest("user", { ...input, number: 9 }, review.reviewToken)).rejects.toThrow("GITHUB_REVIEW_REQUIRED");
    await expect(mergeGithubPullRequest("user", { ...input, repository: "other/repo" }, review.reviewToken)).rejects.toThrow("GITHUB_REVIEW_REQUIRED");
    await expect(mergeGithubPullRequest("user", input, `${review.reviewToken}x`)).rejects.toThrow("GITHUB_REVIEW_REQUIRED");
    vi.setSystemTime(review.expiresAt);
    await expect(mergeGithubPullRequest("user", input, review.reviewToken)).rejects.toThrow("GITHUB_REVIEW_REQUIRED");
  });
  it("rejects base or head changes before sending a merge", async () => {
    let fetch = mock(); const review = await previewGithubMerge("user", input); fetch.mockRestore();
    fetch = mock({ base: "d".repeat(40) }); await expect(mergeGithubPullRequest("user", input, review.reviewToken)).rejects.toThrow("GITHUB_HEAD_CHANGED");
    expect(fetch.mock.calls.some(([u]) => String(u).endsWith("/merge"))).toBe(false); fetch.mockRestore();
    fetch = mock({ head: "d".repeat(40) }); await expect(mergeGithubPullRequest("user", input, review.reviewToken)).rejects.toThrow("GITHUB_HEAD_CHANGED");
    expect(fetch.mock.calls.some(([u]) => String(u).endsWith("/merge"))).toBe(false);
  });
  it("rejects unauthorized access, forks and missing patches", async () => {
    let fetch = mock({ permission: false }); await expect(previewGithubMerge("user", input)).rejects.toThrow("GITHUB_PUSH_FORBIDDEN"); fetch.mockRestore();
    fetch = mock({ fork: true }); await expect(previewGithubMerge("user", input)).rejects.toThrow("GITHUB_PR_MERGE_UNAVAILABLE"); fetch.mockRestore();
    fetch = mock({ patch: false }); await expect(previewGithubMerge("user", input)).rejects.toThrow("GITHUB_PR_COMPARISON_INCOMPLETE");
  });
  it("does not retry uncertain writes or report false success", async () => {
    let fetch = mock(); const review = await previewGithubMerge("user", input); fetch.mockRestore();
    fetch = mock({ fail: true }); await expect(mergeGithubPullRequest("user", input, review.reviewToken)).rejects.toThrow();
    await expect(mergeGithubPullRequest("user", input, review.reviewToken)).rejects.toThrow("GITHUB_REVIEW_REQUIRED");
    expect(fetch.mock.calls.filter(([u]) => String(u).endsWith("/merge"))).toHaveLength(1); fetch.mockRestore();
    fetch = mock(); const next = await previewGithubMerge("user", input); fetch.mockRestore();
    fetch = mock({ unknown: true }); await expect(mergeGithubPullRequest("user", input, next.reviewToken)).rejects.toThrow("GITHUB_MERGE_UNCONFIRMED");
  });
});
