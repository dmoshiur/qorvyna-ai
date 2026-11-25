import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST as preview } from "../src/app/api/github/preview/route";
import { POST as push } from "../src/app/api/github/push/route";
import { getSessionUser } from "../src/lib/firebase/session";
import { previewGithubPush, pushAgentFiles, validatePushFiles } from "../src/lib/server/github";

vi.mock("@/lib/firebase/session", () => ({ getSessionUser: vi.fn() }));
vi.mock("@/lib/server/github", () => ({ previewGithubPush: vi.fn(), pushAgentFiles: vi.fn(), validatePushFiles: vi.fn((files) => files) }));
vi.mock("@/lib/firebase/admin", () => ({ nowTs: () => 0, adminDb: () => ({ collection: () => ({ add: async () => ({}) }) }) }));
const body = { source: "agent", repository: "owner/repo", branch: "main", message: "reviewed", files: [{ path: "a.txt", content: "text" }], reviewToken: "signed-token" };
const request = (path: string, data: unknown, origin = "https://app.example") => new NextRequest(`https://app.example${path}`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(data) });
beforeEach(() => { vi.clearAllMocks(); vi.mocked(getSessionUser).mockResolvedValue({ uid: `user-${Math.random()}`, email: null, emailVerified: true }); });

describe("GitHub review routes", () => {
  it("rejects cross-origin mutations and anonymous requests before accessing GitHub", async () => {
    expect((await preview(request("/api/github/preview", body, "https://evil.example"))).status).toBe(403);
    expect(previewGithubPush).not.toHaveBeenCalled();
    vi.mocked(getSessionUser).mockResolvedValueOnce(null);
    expect((await push(request("/api/github/push", body))).status).toBe(401);
    expect(pushAgentFiles).not.toHaveBeenCalled();
  });
  it("requires a review token and validates file payloads before push", async () => {
    const { reviewToken: _omitted, ...missing } = body;
    expect((await push(request("/api/github/push", missing))).status).toBe(400);
    expect(pushAgentFiles).not.toHaveBeenCalled();
    vi.mocked(pushAgentFiles).mockResolvedValueOnce({ commitSha: "test", commitUrl: "https://github.com/owner/repo/commit/test", branch: "main" });
    expect((await push(request("/api/github/push", body))).status).toBe(200);
    expect(validatePushFiles).toHaveBeenCalled();
    expect(pushAgentFiles).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ reviewToken: "signed-token" }));
  });
  it("returns no-store comparison results and reports stale HEAD as a conflict", async () => {
    vi.mocked(previewGithubPush).mockResolvedValueOnce({ head: "a".repeat(40), expiresAt: 123, reviewToken: "test", files: [] });
    const result = await preview(request("/api/github/preview", body));
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("no-store");
    vi.mocked(pushAgentFiles).mockRejectedValueOnce(new Error("GITHUB_HEAD_CHANGED"));
    const conflict = await push(request("/api/github/push", body));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "GITHUB_HEAD_CHANGED" });
  });
  it("rejects oversized request bodies before calling GitHub", async () => {
    const big = request("/api/github/preview", { ...body, files: [{ path: "a", content: "x".repeat(1_200_001) }] });
    expect((await preview(big)).status).toBe(413);
    expect(previewGithubPush).not.toHaveBeenCalled();
  });
});
