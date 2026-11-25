import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST as preview } from "@/app/api/github/pull-requests/preview/route";
import { POST as create } from "@/app/api/github/pull-requests/create/route";
import { getSessionUser } from "@/lib/firebase/session";
import { createReviewedPullRequest, previewPullRequest } from "@/lib/server/github-pr";
vi.mock("@/lib/firebase/session", () => ({ getSessionUser: vi.fn() }));
vi.mock("@/lib/server/github-pr", () => ({ createReviewedPullRequest: vi.fn(), previewPullRequest: vi.fn() }));
vi.mock("@/lib/firebase/admin", () => ({ nowTs: () => 0, adminDb: () => ({ collection: () => ({ add: async () => ({}) }) }) }));
const input = { repository: "owner/repo", base: "main", head: "feature", title: "Title", body: "" };
const req = (path: string, data: unknown, origin = "https://example.com") => new NextRequest(`https://example.com${path}`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(data) });
beforeEach(() => { vi.clearAllMocks(); vi.mocked(getSessionUser).mockResolvedValue({ uid: `user-${Math.random()}`, email: null, emailVerified: true }); });
describe("pull request routes", () => {
  it("rejects cross-origin, unauthenticated and missing-review creation", async () => {
    expect((await create(req("/api/github/pull-requests/create", input, "https://evil.example"))).status).toBe(403);
    vi.mocked(getSessionUser).mockResolvedValueOnce(null);
    expect((await preview(req("/api/github/pull-requests/preview", input))).status).toBe(401);
    expect((await create(req("/api/github/pull-requests/create", input))).status).toBe(400);
    expect(createReviewedPullRequest).not.toHaveBeenCalled();
  });
  it("returns no-store preview and requires an exact token on create", async () => {
    vi.mocked(previewPullRequest).mockResolvedValueOnce({ baseSha: "a".repeat(40), headSha: "b".repeat(40), totalCommits: 1, files: [], expiresAt: 123, reviewToken: "token" });
    const result = await preview(req("/api/github/pull-requests/preview", input));
    expect(result.status).toBe(200); expect(result.headers.get("cache-control")).toBe("no-store");
    vi.mocked(createReviewedPullRequest).mockRejectedValueOnce(new Error("GITHUB_HEAD_CHANGED"));
    const conflict = await create(req("/api/github/pull-requests/create", { ...input, reviewToken: "token" }));
    expect(conflict.status).toBe(409);
    expect(createReviewedPullRequest).toHaveBeenCalledWith(expect.any(String), input, "token");
  });
});
