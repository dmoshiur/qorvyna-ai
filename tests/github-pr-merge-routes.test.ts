import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST as preview } from "@/app/api/github/pull-requests/merge/preview/route";
import { POST as execute } from "@/app/api/github/pull-requests/merge/execute/route";
import { getSessionUser } from "@/lib/firebase/session";
import { mergeGithubPullRequest, previewGithubMerge } from "@/lib/server/github-pr-merge";
vi.mock("@/lib/firebase/session", () => ({ getSessionUser: vi.fn() }));
vi.mock("@/lib/server/github-pr-merge", () => ({ mergeGithubPullRequest: vi.fn(), previewGithubMerge: vi.fn() }));
vi.mock("@/lib/firebase/admin", () => ({ nowTs: () => 0, adminDb: () => ({ collection: () => ({ add: async () => ({}) }) }) }));
const input = { repository: "owner/repo", number: 8 };
const req = (path: string, data: unknown, origin = "https://example.com") => new NextRequest(`https://example.com${path}`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(data) });
beforeEach(() => { vi.clearAllMocks(); vi.mocked(getSessionUser).mockResolvedValue({ uid: `user-${Math.random()}`, email: null, emailVerified: true }); });
describe("PR merge routes", () => {
  it("checks origin, authentication and review token before any merge", async () => {
    expect((await execute(req("/api/github/pull-requests/merge/execute", input, "https://evil.example"))).status).toBe(403);
    vi.mocked(getSessionUser).mockResolvedValueOnce(null);
    expect((await preview(req("/api/github/pull-requests/merge/preview", input))).status).toBe(401);
    expect((await execute(req("/api/github/pull-requests/merge/execute", input))).status).toBe(400);
    expect(mergeGithubPullRequest).not.toHaveBeenCalled();
  });
  it("returns no-store preview and reports a stale review as a conflict", async () => {
    vi.mocked(previewGithubMerge).mockResolvedValueOnce({ title: "Test", base: "main", baseSha: "a".repeat(40), headSha: "b".repeat(40), files: [], expiresAt: 123, reviewToken: "token" });
    const result = await preview(req("/api/github/pull-requests/merge/preview", input));
    expect(result.status).toBe(200); expect(result.headers.get("cache-control")).toBe("no-store");
    vi.mocked(mergeGithubPullRequest).mockRejectedValueOnce(new Error("GITHUB_HEAD_CHANGED"));
    const conflict = await execute(req("/api/github/pull-requests/merge/execute", { ...input, reviewToken: "token" }));
    expect(conflict.status).toBe(409);
    expect(mergeGithubPullRequest).toHaveBeenCalledWith(expect.any(String), input, "token");
  });
});
