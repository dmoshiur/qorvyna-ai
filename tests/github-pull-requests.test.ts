import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/env", () => ({ env: { github: { tokenEncryptionKey: "test-key-that-is-longer-than-32-characters" } }, isGithubConfigured: () => true }));
vi.mock("@/lib/firebase/admin", async () => { const { sharedFirestoreStub, makeAdminModule } = await import("./helpers/firestore-stub"); return makeAdminModule(sharedFirestoreStub()); });
import { sharedFirestoreStub } from "./helpers/firestore-stub";
import { encryptGithubToken } from "@/lib/server/github";
import { previewPullRequest, createReviewedPullRequest } from "@/lib/server/github-pr";
const db = sharedFirestoreStub();
const a = "a".repeat(40), b = "b".repeat(40);
const input = { repository: "owner/repo", base: "main", head: "feature/topic", title: "Changes", body: "Review carefully" };
function github(opts: { base?: string; head?: string; forbidden?: boolean; patch?: boolean; count?: number; fail?: boolean } = {}) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === "/repos/owner/repo") return Response.json({ permissions: { push: !opts.forbidden } });
    if (path.endsWith("/git/ref/heads/main")) return Response.json({ object: { sha: opts.base ?? a } });
    if (path.endsWith("/git/ref/heads/feature/topic")) return Response.json({ object: { sha: opts.head ?? b } });
    if (path.includes("/compare/")) return Response.json({ status: "ahead", total_commits: opts.count ?? 1, commits: [{}], files: [{ filename: "a.txt", status: "modified", additions: 1, deletions: 1, ...(opts.patch === false ? {} : { patch: "@@ -1 +1 @@\n-old\n+new" }) }] });
    if (path.endsWith("/pulls") && init?.method === "POST") {
      if (opts.fail) throw new Error("network failed");
      return Response.json({ number: 8, html_url: "https://github.com/owner/repo/pull/8" });
    }
    throw new Error(`unexpected path ${path}`);
  });
}
beforeEach(() => { db._state.docs.clear(); db._state.docs.set("github_connections/user", { access_token_encrypted: encryptGithubToken("fake-test-token") }); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
describe("reviewed pull request creation", () => {
  it("compares immutable commits, binds review and consumes it exactly once", async () => {
    const fetch = github(); const review = await previewPullRequest("user", input);
    expect(review).toMatchObject({ baseSha: a, headSha: b, totalCommits: 1, files: [{ filename: "a.txt" }] });
    expect(fetch.mock.calls.some(([url]) => String(url).includes(`/compare/${a}...${b}`))).toBe(true);
    const created = await createReviewedPullRequest("user", input, review.reviewToken);
    expect(created).toEqual({ number: 8, url: "https://github.com/owner/repo/pull/8" });
    const call = fetch.mock.calls.find(([url]) => String(url).endsWith("/pulls"))!;
    expect(JSON.parse(String(call[1]?.body))).toEqual({ title: input.title, body: input.body, base: input.base, head: input.head });
    await expect(createReviewedPullRequest("user", input, review.reviewToken)).rejects.toThrow("GITHUB_REVIEW_REQUIRED");
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith("/pulls"))).toHaveLength(1);
  });
  it("rejects changes to the signed user, target and text", async () => {
    github(); const review = await previewPullRequest("user", input);
    await expect(createReviewedPullRequest("other", input, review.reviewToken)).rejects.toThrow("GITHUB_REVIEW_REQUIRED");
    await expect(createReviewedPullRequest("user", { ...input, title: "other" }, review.reviewToken)).rejects.toThrow("GITHUB_REVIEW_REQUIRED");
    await expect(createReviewedPullRequest("user", { ...input, head: "other" }, review.reviewToken)).rejects.toThrow("GITHUB_REVIEW_REQUIRED");
    await expect(createReviewedPullRequest("user", input, `${review.reviewToken}a`)).rejects.toThrow("GITHUB_REVIEW_REQUIRED");
    vi.setSystemTime(review.expiresAt);
    await expect(createReviewedPullRequest("user", input, review.reviewToken)).rejects.toThrow("GITHUB_REVIEW_REQUIRED");
  });
  it("rejects stale refs before creating anything", async () => {
    let fetch = github(); const review = await previewPullRequest("user", input); fetch.mockRestore();
    fetch = github({ head: "c".repeat(40) });
    await expect(createReviewedPullRequest("user", input, review.reviewToken)).rejects.toThrow("GITHUB_HEAD_CHANGED");
    expect(fetch.mock.calls.some(([url]) => String(url).endsWith("/pulls"))).toBe(false);
  });
  it("refuses unsupported patches and incomplete pagination", async () => {
    let fetch = github({ patch: false }); await expect(previewPullRequest("user", input)).rejects.toThrow("GITHUB_PR_COMPARISON_INCOMPLETE"); fetch.mockRestore();
    fetch = github({ count: 101 }); await expect(previewPullRequest("user", input)).rejects.toThrow("GITHUB_PR_COMPARISON_INCOMPLETE");
  });
  it("enforces permissions and treats uncertain writes as consumed", async () => {
    let fetch = github({ forbidden: true }); await expect(previewPullRequest("user", input)).rejects.toThrow("GITHUB_PUSH_FORBIDDEN"); fetch.mockRestore();
    fetch = github(); const review = await previewPullRequest("user", input); fetch.mockRestore();
    fetch = github({ fail: true }); await expect(createReviewedPullRequest("user", input, review.reviewToken)).rejects.toThrow();
    await expect(createReviewedPullRequest("user", input, review.reviewToken)).rejects.toThrow("GITHUB_REVIEW_REQUIRED");
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith("/pulls"))).toHaveLength(1);
  });
});
