import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET as list } from "@/app/api/github/pull-requests/route";
import { GET as inspect } from "@/app/api/github/pull-requests/inspect/route";
import { getSessionUser } from "@/lib/firebase/session";
import { inspectGithubPullRequest, listGithubPullRequests } from "@/lib/server/github-pr-read";
vi.mock("@/lib/firebase/session", () => ({ getSessionUser: vi.fn() }));
vi.mock("@/lib/server/github-pr-read", () => ({ inspectGithubPullRequest: vi.fn(), listGithubPullRequests: vi.fn() }));
vi.mock("@/lib/firebase/admin", () => ({ nowTs: () => 0, adminDb: () => ({ collection: () => ({ add: async () => ({}) }) }) }));
const req = (path: string) => new NextRequest(`https://example.com${path}`);
beforeEach(() => { vi.clearAllMocks(); vi.mocked(getSessionUser).mockResolvedValue({ uid: `user-${Math.random()}`, email: null, emailVerified: true }); });
describe("PR inspection routes", () => {
  it("requires an authenticated session and validates numeric parameters", async () => {
    vi.mocked(getSessionUser).mockResolvedValueOnce(null);
    expect((await list(req("/api/github/pull-requests?repository=owner/repo"))).status).toBe(401);
    expect((await inspect(req("/api/github/pull-requests/inspect?repository=owner/repo&number=1%2Fmerge"))).status).toBe(400);
    expect(inspectGithubPullRequest).not.toHaveBeenCalled();
  });
  it("prevents caching and surfaces concurrent change conflicts", async () => {
    vi.mocked(listGithubPullRequests).mockResolvedValueOnce({ pullRequests: [], page: 1, hasMore: false });
    const response = await list(req("/api/github/pull-requests?repository=owner/repo"));
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    vi.mocked(inspectGithubPullRequest).mockRejectedValueOnce(new Error("GITHUB_HEAD_CHANGED"));
    expect((await inspect(req("/api/github/pull-requests/inspect?repository=owner/repo&number=8"))).status).toBe(409);
  });
});
