import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { pcm16Base64, decodePcm16 } from "@/lib/voice/live-audio";
import { liveConfig } from "@/lib/voice/live-config";

const mocks = vi.hoisted(() => ({ create: vi.fn(), user: { uid: "live-user" } as { uid: string } | null }));
vi.mock("@google/genai", async (original) => ({ ...await original<typeof import("@google/genai")>(), GoogleGenAI: class { authTokens = { create: mocks.create }; } }));
vi.mock("@/lib/firebase/session", () => ({ getSessionUser: async () => mocks.user }));
vi.mock("@/lib/firebase/admin", async () => {
  const { sharedFirestoreStub, makeAdminModule } = await import("./helpers/firestore-stub");
  return makeAdminModule(sharedFirestoreStub());
});
import { sharedFirestoreStub } from "./helpers/firestore-stub";
import { POST } from "@/app/api/voice/live-token/route";
const db = sharedFirestoreStub();
const post = (body = { language: "bn-BD" }, origin = "http://localhost") => POST(new NextRequest("http://localhost/api/voice/live-token", { method: "POST", headers: { origin, "Content-Type": "application/json" }, body: JSON.stringify(body) }));
beforeEach(() => {
  db._state.docs.clear(); db.clearFaults(); mocks.user = { uid: "live-user" };
  mocks.create.mockReset().mockResolvedValue({ name: "auth_tokens/short-lived" });
  vi.stubEnv("GEMINI_API_KEY", "server-only-test-key"); vi.stubEnv("GEMINI_LIVE_MODEL", "configured-live-model");
});
afterEach(() => vi.unstubAllEnvs());

describe("live audio transport", () => {
  it("encodes clipped little-endian PCM and decodes all polarities", () => {
    const samples = decodePcm16(pcm16Base64(new Float32Array([-2, -0.5, 0, 0.5, 2])));
    expect([...samples]).toEqual([-1, -0.5, 0, 16383 / 32768, 32767 / 32768]);
    expect(() => decodePcm16(btoa("x"))).toThrow("Invalid PCM");
  });
  it("follows selected or spoken languages without forced English translation", () => {
    expect(liveConfig("auto").systemInstruction).toContain("language the user speaks");
    expect(liveConfig("bn-BD").systemInstruction).toContain("Bangla");
    expect(liveConfig("es-ES").systemInstruction).toContain("Spanish");
    expect(liveConfig("auto").responseModalities).toEqual(["AUDIO"]);
  });
});
describe("live token security", () => {
  it("requires same-origin auth, validates languages and explicitly configured provider", async () => {
    expect((await post(undefined, "https://attacker.invalid")).status).toBe(403);
    mocks.user = null; expect((await post()).status).toBe(401);
    mocks.user = { uid: "live-user" }; expect((await post({ language: "unsupported" })).status).toBe(400);
    vi.stubEnv("GEMINI_LIVE_MODEL", ""); expect((await post()).status).toBe(503);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("locks one-use tokens to configured audio model and bounds lifetime", async () => {
    const before = Date.now(); const response = await post();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const json = await response.json();
    expect(JSON.stringify(json)).not.toContain("server-only-test-key");
    expect(json.token).toBe("auth_tokens/short-lived");
    const config = mocks.create.mock.calls[0][0].config;
    expect(config.uses).toBe(1);
    expect(config.liveConnectConstraints.model).toBe("configured-live-model");
    expect(config.liveConnectConstraints.config).toEqual(liveConfig("bn-BD"));
    expect(Date.parse(config.newSessionExpireTime) - before).toBeLessThanOrEqual(61000);
    expect(Date.parse(config.expireTime) - before).toBeLessThanOrEqual(601000);
    expect(JSON.stringify(db.dump())).not.toContain("auth_tokens");
    expect((await post()).status).toBe(429);
    expect(mocks.create).toHaveBeenCalledOnce();
  });
  it("hides sensitive provider errors and fails closed", async () => {
    mocks.create.mockRejectedValue(new Error("server-only-test-key"));
    const response = await post(); expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("server-only-test-key");
  });
  it("enforces a shared hourly limit", async () => {
    await db.collection("voice_live_limits").doc("live-user").set({ window_start: Date.now(), last_at: Date.now() - 30000, count: 12 });
    expect((await post()).status).toBe(429);
  });
});
