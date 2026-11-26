import { describe, it, expect, vi } from "vitest";
const health = vi.hoisted(() => vi.fn(async () => true));
const imageStatus = vi.hoisted(() => vi.fn(async () => "online" as const));
vi.mock("@/lib/env", () => ({ isConfigured: () => true, isCloudinaryConfigured: () => false }));
vi.mock("@/lib/firebase/admin", () => ({ adminConfigured: () => true, adminDb: () => ({ collection: () => ({ limit: () => ({ get: async () => ({ docs: [] }) }) }) }) }));
vi.mock("@/lib/ai/config", () => ({ createAIRoutes: () => [], createAIRoutesFromDb: async () => [{ provider: "test", model: "test-model", client: { healthCheck: health } }], logAIConfiguration: () => {} }));
vi.mock("@/lib/server/cloudinary", () => ({ ping: vi.fn() }));
vi.mock("@/lib/server/identitytoolkit", () => ({ checkWebFirebaseConfig: async () => ({ status: "valid" }) }));
vi.mock("@/lib/ai/image/config", () => ({ imageGenerationStatus: imageStatus }));
import { GET } from "@/app/api/health/route";

describe("public uptime health", () => {
  it("drives AI status from the real, cached provider probe", async () => {
    const response = await GET();
    const body = await response.json();
    expect(body).toMatchObject({ ok: true, firebase: "reachable", ai: "online", codingAi: "online", imageAi: "online" });
    // The probe is a real (TTL-cached) provider call — that is the point of
    // P0-3: configuration alone must not masquerade as "online".
    expect(health).toHaveBeenCalled();
    expect(imageStatus).toHaveBeenCalled();
  });

  it("reports unavailable when the provider probe fails", async () => {
    health.mockImplementationOnce(async () => false);
    const response = await GET();
    const body = await response.json();
    expect(body).toMatchObject({ ai: "unavailable", codingAi: "unavailable" });
  });
});
