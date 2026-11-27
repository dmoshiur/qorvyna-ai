// Issue 9 — per-user isolation proof.
//
// User B must never see, use, list or delete user A's data. This covers the new
// bring-your-own provider vault (which stores encrypted API keys) end to end:
// storage, listing, reads, deletes and routing targets are all strictly scoped
// by the authenticated user id, never by a request-supplied id.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFirestoreStub, type FirestoreStub } from "./helpers/firestore-stub";

let stub: FirestoreStub;
let sessionUid: string | null = "user-A";

const originalFetch = globalThis.fetch;
beforeEach(() => {
  stub = createFirestoreStub();
  sessionUid = "user-A";
  vi.stubEnv("PROVIDER_SECRET_KEY", "test-encryption-secret-key-0123456789abcdef");
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: () => stub,
  nowTs: () => new Date().toISOString(),
  Timestamp: {
    now: () => Date.now(),
    fromMillis: (ms: number) => ms,
    fromDate: (date: Date) => date.getTime(),
  },
}));

vi.mock("@/lib/firebase/session", () => ({
  getSessionUser: async () => (sessionUid ? { uid: sessionUid, email: `${sessionUid}@example.com` } : null),
}));

const { addUserProvider, listUserProviders, getUserProvider, deleteUserProvider, customRouteTargets, listCustomModelStatus } =
  await import("../src/lib/server/provider-vault");
const { GET } = await import("../src/app/api/ai/providers/route");

/** Successful 1-token completion so the connection probe passes. */
function mockOkCompletion() {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: "OK", finish_reason: "stop" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
  }) as unknown as typeof fetch;
}

describe("provider vault: strict per-user scoping", () => {
  it("stores each user's providers separately and never leaks across users", async () => {
    mockOkCompletion();
    const a = await addUserProvider(stub as never, "user-A", { name: "A gateway", base_url: "https://a.example/v1", api_key: "sk-A-secret", models: [{ id: "a-model" }] });
    const b = await addUserProvider(stub as never, "user-B", { name: "B gateway", base_url: "https://b.example/v1", api_key: "sk-B-secret", models: [{ id: "b-model" }] });

    const aList = await listUserProviders(stub as never, "user-A");
    const bList = await listUserProviders(stub as never, "user-B");

    expect(aList).toHaveLength(1);
    expect(bList).toHaveLength(1);
    expect(aList[0].id).toBe(a.id);
    expect(bList[0].id).toBe(b.id);
    expect(aList[0].name).toBe("A gateway");
    expect(bList[0].name).toBe("B gateway");
    // Keys are masked in the public projection — never returned in cleartext.
    expect(aList[0].key_mask).toContain("***");
    expect(aList[0].key_mask).not.toContain("sk-A-secret");
  });

  it("blocks cross-user reads and deletes (returns null / throws, no leak)", async () => {
    mockOkCompletion();
    const a = await addUserProvider(stub as never, "user-A", { name: "A gateway", base_url: "https://a.example/v1", api_key: "sk-A-secret", models: [{ id: "a-model" }] });

    // B cannot read A's provider document.
    const crossRead = await getUserProvider(stub as never, "user-B", a.id);
    expect(crossRead).toBeNull();

    // B cannot delete A's provider.
    await expect(deleteUserProvider(stub as never, "user-B", a.id)).rejects.toThrow(/PROVIDER_NOT_FOUND/);

    // A's data is still intact afterwards.
    const aList = await listUserProviders(stub as never, "user-A");
    expect(aList).toHaveLength(1);
    expect(aList[0].id).toBe(a.id);
  });

  it("encrypts the API key at rest (ciphertext differs from plaintext)", async () => {
    mockOkCompletion();
    await addUserProvider(stub as never, "user-A", { name: "A gateway", base_url: "https://a.example/v1", api_key: "sk-A-super-secret", models: [{ id: "a-model" }] });
    const dump = stub.dump();
    const providerDoc = Object.values(dump).find((doc) => (doc as { user_id?: string }).user_id === "user-A") as Record<string, unknown>;
    expect(providerDoc).toBeTruthy();
    expect(providerDoc.encrypted_key).toBeTypeOf("string");
    expect(providerDoc.encrypted_key).not.toBe("sk-A-super-secret");
    expect(String(providerDoc.encrypted_key)).not.toContain("sk-A-super-secret");
  });

  it("builds routing targets only from the requesting user's enabled providers", async () => {
    mockOkCompletion();
    const a = await addUserProvider(stub as never, "user-A", { name: "A gateway", base_url: "https://a.example/v1", api_key: "sk-A-secret", models: [{ id: "a-model" }] });
    await addUserProvider(stub as never, "user-B", { name: "B gateway", base_url: "https://b.example/v1", api_key: "sk-B-secret", models: [{ id: "b-model" }] });

    const aTargets = await customRouteTargets(stub as never, "user-A");
    const bTargets = await customRouteTargets(stub as never, "user-B");

    expect(aTargets.map((t) => t.model)).toEqual(["a-model"]);
    expect(bTargets.map((t) => t.model)).toEqual(["b-model"]);
    expect(aTargets.some((t) => t.model === "b-model")).toBe(false);
    expect(bTargets.some((t) => t.model === "a-model")).toBe(false);

    const aStatus = await listCustomModelStatus(stub as never, "user-A");
    expect(aStatus.find((m) => m.model_id === "a-model")).toBeTruthy();
    expect(aStatus.find((m) => m.model_id === "b-model")).toBeFalsy();
    void a.id;
  });
});

describe("providers API: GET is scoped to the signed-in user", () => {
  it("returns only the caller's providers and never another user's", async () => {
    mockOkCompletion();
    await addUserProvider(stub as never, "user-A", { name: "A gateway", base_url: "https://a.example/v1", api_key: "sk-A-secret", models: [{ id: "a-model" }] });
    await addUserProvider(stub as never, "user-B", { name: "B gateway", base_url: "https://b.example/v1", api_key: "sk-B-secret", models: [{ id: "b-model" }] });

    sessionUid = "user-A";
    const resA = await GET();
    const bodyA = await resA.json();
    expect(resA.status).toBe(200);
    expect(bodyA.providers).toHaveLength(1);
    expect(bodyA.providers[0].name).toBe("A gateway");

    sessionUid = "user-B";
    const resB = await GET();
    const bodyB = await resB.json();
    expect(bodyB.providers).toHaveLength(1);
    expect(bodyB.providers[0].name).toBe("B gateway");

    // Neither response leaks the other user's cleartext key (only the masked form).
    for (const provider of [...bodyA.providers, ...bodyB.providers]) {
      expect(JSON.stringify(provider)).not.toContain("sk-A-secret");
      expect(JSON.stringify(provider)).not.toContain("sk-B-secret");
    }
  });

  it("rejects unauthenticated reads with 401", async () => {
    sessionUid = null;
    const res = await GET();
    expect(res.status).toBe(401);
  });
});
