import { describe, it, expect, vi } from "vitest";
const health = vi.hoisted(() => vi.fn(async () => true));
const image = vi.hoisted(() => vi.fn(async () => true));
vi.mock("@/lib/env", () => ({ isConfigured: () => true, isCloudinaryConfigured: () => false }));
vi.mock("@/lib/firebase/admin", () => ({ adminConfigured: () => true, adminDb: () => ({ collection: () => ({ limit: () => ({ get: async () => ({ docs: [] }) }) }) }) }));
vi.mock("@/lib/ai/config", () => ({ createAIRoutes: () => [], createAIRoutesFromDb: async () => [{ provider: "test", model: "test-model", client: { healthCheck: health } }], logAIConfiguration: () => {} }));
vi.mock("@/lib/server/cloudinary", () => ({ ping: vi.fn() }));
vi.mock("@/lib/server/identitytoolkit", () => ({ checkWebFirebaseConfig: async () => ({ status: "valid" }) }));
vi.mock("@/lib/ai/image/config", () => ({ isImageGenerationConfigured: async () => true, testImageProviderConfig: image }));
import { GET } from "@/app/api/health/route";
describe("public uptime health", () => {
  it("checks Firestore but does not call paid AI providers or claim online", async () => {
    const response = await GET(); const body = await response.json();
    expect(body).toMatchObject({ ok: true, firebase: "reachable", ai: "unknown", codingAi: "unknown", imageAi: "unknown" });
    expect(health).not.toHaveBeenCalled(); expect(image).not.toHaveBeenCalled();
  });
});
