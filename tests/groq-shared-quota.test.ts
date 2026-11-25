import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/firebase/admin";

const state = vi.hoisted(() => ({ docs: new Map<string, Record<string, unknown>>(), lock: Promise.resolve() as Promise<unknown>, fail: false }));
vi.mock("@/lib/firebase/admin", () => ({ adminDb: () => db, nowTs: () => Date.now() }));
const db = {
  collection: (name: string) => ({ doc: (id: string) => ({ path: `${name}/${id}` }) }),
  runTransaction: (fn: (tx: { get: (ref: { path: string }) => Promise<{ data: () => Record<string, unknown> | undefined }>; set: (ref: { path: string }, data: Record<string, unknown>) => void }) => Promise<unknown>) => {
    const next = state.lock.then(async () => {
      if (state.fail) throw new Error("storage unavailable");
      const writes: Array<[string, Record<string, unknown>]> = [];
      const result = await fn({ get: async (ref) => ({ data: () => state.docs.get(ref.path) }), set: (ref, data) => { writes.push([ref.path, data]); } });
      for (const [key, value] of writes) state.docs.set(key, value);
      return result;
    });
    state.lock = next.catch(() => {}); return next;
  },
} as unknown as Db;
import { observeGroqCapacity, releaseGroqBootstrap, reserveGroqCapacity } from "@/lib/ai/groq-shared-quota";
import { resetAccountsForTests } from "@/lib/ai/accounts";
import { GroqProvider } from "@/lib/ai/groq";
const model = "openai/gpt-oss-120b";
const headers = (requests: number, tokens: number) => new Headers({ "x-ratelimit-remaining-requests": String(requests), "x-ratelimit-reset-requests": "60s", "x-ratelimit-remaining-tokens": String(tokens), "x-ratelimit-reset-tokens": "60s" });
beforeEach(() => { state.docs.clear(); state.lock = Promise.resolve(); state.fail = false; vi.stubEnv("QORVYNA_GROQ_SHARED_QUOTA", "true"); vi.stubEnv("GROQ_API_KEY", "gsk_test_shared_key_123456789"); resetAccountsForTests(); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); resetAccountsForTests(); });
describe("shared Groq quota ledger", () => {
  it("serializes initial observation without inventing quota, with an expiring lease", async () => {
    const [a, b] = await Promise.all([reserveGroqCapacity(db, model, 5, 1000), reserveGroqCapacity(db, model, 5, 1000)]);
    expect(a.allowed).toBe(true); expect(a.leaseId).toBeTruthy();
    expect(b).toMatchObject({ allowed: false, reason: "bootstrap" });
    await releaseGroqBootstrap(db, model, "wrong", 1000);
    expect((await reserveGroqCapacity(db, model, 5, 1000)).allowed).toBe(false);
    expect((await reserveGroqCapacity(db, model, 5, 181001)).allowed).toBe(true);
  });
  it("atomically reserves provider-reported capacity across concurrent workers", async () => {
    await observeGroqCapacity(db, model, headers(2, 100), 0, 1000);
    const results = await Promise.all(Array.from({ length: 3 }, () => reserveGroqCapacity(db, model, 30, 1000)));
    expect(results.filter((r) => r.allowed)).toHaveLength(2);
    expect(results.filter((r) => !r.allowed)[0]).toMatchObject({ reason: "rate_limit", retryAt: 61000 });
  });
  it("never increases remaining based on out-of-order headers inside a live window", async () => {
    await observeGroqCapacity(db, model, headers(2, 100), 0, 1000);
    await reserveGroqCapacity(db, model, 30, 1000);
    await observeGroqCapacity(db, model, headers(20, 500), 0, 2000);
    expect((await reserveGroqCapacity(db, model, 80, 2000))).toMatchObject({ allowed: false, reason: "rate_limit" });
    expect((await reserveGroqCapacity(db, model, 5, 63000)).allowed).toBe(true);
  });
  it("does not invent reset windows for incomplete headers and honors cooldown", async () => {
    await observeGroqCapacity(db, model, new Headers({ "x-ratelimit-remaining-requests": "0" }), 11000, 1000);
    expect((await reserveGroqCapacity(db, model, 1, 1000))).toMatchObject({ allowed: false, reason: "rate_limit", retryAt: 11000 });
    expect((await reserveGroqCapacity(db, model, 1, 11001))).toMatchObject({ allowed: true, leaseId: expect.any(String) });
  });
  it("fails closed before sending if coordination is unavailable", async () => {
    state.fail = true; const fetch = vi.spyOn(globalThis, "fetch");
    await expect(new GroqProvider("gsk_test_shared_key_123456789", { pooled: true }).chat({ model, messages: [{ role: "user", content: "hi" }] })).rejects.toMatchObject({ type: "provider_unavailable" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("observes real response headers and blocks later pooled requests", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ model, choices: [{ message: { content: "ok" } }] }, { headers: headers(0, 5000) }));
    const provider = new GroqProvider("gsk_test_shared_key_123456789", { pooled: true });
    await expect(provider.chat({ model, messages: [{ role: "user", content: "hi" }] })).resolves.toMatchObject({ content: "ok" });
    await expect(provider.chat({ model, messages: [{ role: "user", content: "hi" }] })).rejects.toMatchObject({ type: "rate_limit" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
