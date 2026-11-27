// Google Gemini provider adapter — the targeted fix for
// "The provider rejected this API key."
//
// The original defect: the shared admin probe authenticated Google with
// `Authorization: Bearer <API key>` — a header Google reserves for OAuth
// tokens — so valid Gemini keys (legacy AIza… and the newer AQ.… auth key)
// were answered 401 UNAUTHENTICATED and the admin console showed a generic
// rejection. These tests pin the correct behaviour with mocked HTTP only:
//
//   1. AQ.-format key handling            9.  HTTP 401 handling
//   2. AIza-format key handling           10. HTTP 403 handling
//   3. Invalid key rejection              11. HTTP 429 handling
//   4. Correct X-goog-api-key header      12. Timeout handling
//   5. Correct endpoint                   13. Secret redaction
//   6. Correct request body               14. Admin test endpoint
//   7. Encryption/decryption round trip   15. Provider fallback after Gemini failure
//   8. HTTP 400 handling                  16. Successful Gemini response

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeFakeFirestore } from "./helpers/test-db";
import type { Db } from "../src/lib/firebase/admin";

const fakeDb = makeFakeFirestore();
const db = fakeDb as unknown as Db;
let sessionUid: string | null = "actor-super";

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: () => fakeDb,
  nowTs: () => new Date(),
  toTs: (v: unknown) => v,
  adminConfigured: () => true,
}));

vi.mock("@/lib/firebase/session", () => ({
  getSessionUser: async () => (sessionUid ? { uid: sessionUid, email: `${sessionUid}@matrix.test` } : null),
}));

const {
  buildGeminiVerificationBody,
  classifyGeminiStatus,
  geminiGenerateContentUrl,
  geminiHeaders,
  geminiModelsUrl,
  geminiStreamGenerateUrl,
  normalizeGeminiBaseUrl,
  parseGenerateContentText,
  parseGeminiError,
  redactKey,
  GeminiProvider,
  verifyGeminiCredential,
  GEMINI_VERIFICATION_MODEL,
} = await import("../src/lib/ai/gemini");
const { validateProviderKey, probeProvider } = await import("../src/lib/ai/providers");
const { encryptSecret, decryptSecret } = await import("../src/lib/ai/image/config");
const { addStoredAccount, ensureAccounts, nextAvailability, resetAccountsForTests, selectAccount, unavailableReason } = await import("../src/lib/ai/accounts");

// Both valid Google formats (task: never reject a key by its prefix).
// Synthetic test keys, built as expressions so no real-looking credential is
// ever committed: a 53-character AQ. auth key and the legacy 39-char AIza key.
const KEY_AIZA = "AIza" + "d".repeat(35);
const KEY_AQ = "AQ.Ab" + "e".repeat(48);
const SECRET = "2f9c1a77b0e4d5316a8c9f0e1b2d3c4a";
const GROQ_KEY = "gsk_" + "a".repeat(32);

const OK_GENERATE = JSON.stringify({ candidates: [{ content: { parts: [{ text: "AI learns patterns from data." }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 7, totalTokenCount: 19 } });
const OK_CATALOG = JSON.stringify({ models: [{ name: "models/gemini-flash-latest", displayName: "Gemini Flash (latest)", input_token_limit: 1_048_576 }, { name: "models/gemini-2.0-flash" }] });

/** Google catalog 200 + generateContent 200 unless the caller overrides. */
function stubGoogle(overrides: { catalog?: () => Response; generate?: () => Response } = {}) {
  const spy = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
    const target = String(url);
    if (target.includes(":generateContent")) return Promise.resolve(overrides.generate?.() ?? new Response(OK_GENERATE, { status: 200 }));
    return Promise.resolve(overrides.catalog?.() ?? new Response(OK_CATALOG, { status: 200 }));
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

async function callRpc(action: string, args: Record<string, unknown> = {}) {
  const req = new Request("http://localhost/api/rpc", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost" },
    body: JSON.stringify({ action, ...args }),
  });
  const res = await (await import("../src/app/api/rpc/route")).POST(req as never);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(async () => {
  process.env.PROVIDER_SECRET_KEY = SECRET;
  resetAccountsForTests();
  sessionUid = "actor-super";
  for (const name of ["provider_accounts", "provider_models", "provider_account_status", "audit_logs", "admin_role_assignments"]) {
    const snap = await fakeDb.collection(name).get();
    for (const doc of snap.docs) await fakeDb.collection(name).doc(doc.id).delete();
  }
  await fakeDb.collection("admin_role_assignments").doc("actor-super").set({ role_id: "super_admin" });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
describe("key handling (AQ. and AIza, exact preservation)", () => {
  it("1-2. accepts both valid Google key formats unchanged and rejects other shapes", () => {
    expect(validateProviderKey("google", KEY_AQ)).toBe(KEY_AQ);
    expect(validateProviderKey("google", KEY_AIZA)).toBe(KEY_AIZA);
    // The prefix is never rewritten, padded or truncated.
    expect(validateProviderKey("google", `  ${KEY_AQ} `)).toBe(KEY_AQ);
    // Malformed / foreign keys are rejected before storage.
    expect(validateProviderKey("google", "AQ.short")).toBe("");
    expect(validateProviderKey("google", "AIza" + "d".repeat(10))).toBe("");
    expect(validateProviderKey("google", GROQ_KEY)).toBe("");
    expect(validateProviderKey("google", "has space in it")).toBe("");
  });

  it("7. encrypts and decrypts both formats byte-for-byte without ever storing plaintext", () => {
    for (const key of [KEY_AQ, KEY_AIZA]) {
      const encrypted = encryptSecret(key);
      expect(encrypted).not.toContain(key);
      expect(encrypted).not.toContain("AQ.");
      expect(encrypted).not.toContain("AIza");
      expect(decryptSecret(encrypted)).toBe(key);
    }
  });
});

// ---------------------------------------------------------------------------
describe("request construction", () => {
  it("4. authenticates ONLY via X-goog-api-key — no Bearer, no key in the URL", () => {
    const headers = geminiHeaders(KEY_AQ);
    expect(headers["X-goog-api-key"]).toBe(KEY_AQ);
    expect(JSON.stringify(headers)).not.toContain("Bearer");
    expect(headers.Authorization).toBeUndefined();

    const url = geminiGenerateContentUrl("https://generativelanguage.googleapis.com", GEMINI_VERIFICATION_MODEL);
    expect(url).not.toContain(KEY_AQ);
    expect(url).not.toContain("key=");
  });

  it("5. builds the documented endpoint and normalizes base URLs safely", () => {
    expect(geminiGenerateContentUrl("https://generativelanguage.googleapis.com", GEMINI_VERIFICATION_MODEL)).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent",
    );
    // Stored base URLs with a version suffix, trailing slashes or a proxy path all normalize.
    expect(normalizeGeminiBaseUrl("https://generativelanguage.googleapis.com/v1beta/")).toBe("https://generativelanguage.googleapis.com");
    expect(normalizeGeminiBaseUrl("https://generativelanguage.googleapis.com/v1")).toBe("https://generativelanguage.googleapis.com");
    expect(geminiGenerateContentUrl("https://generativelanguage.googleapis.com/v1beta/", "gemini-flash-latest")).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent",
    );
    expect(geminiModelsUrl("https://proxy.example/google")).toBe("https://proxy.example/google/v1beta/models?pageSize=200");
    expect(geminiStreamGenerateUrl("https://generativelanguage.googleapis.com", "gemini-flash-latest")).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:streamGenerateContent?alt=sse",
    );
    // A model id can never change the URL shape.
    expect(geminiGenerateContentUrl("https://generativelanguage.googleapis.com", "models/gemini-2.0-flash")).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent",
    );
    expect(geminiGenerateContentUrl("https://generativelanguage.googleapis.com", "../evil")).toBe("");
  });

  it("6. sends the documented contents → parts → text body", () => {
    expect(buildGeminiVerificationBody()).toEqual({
      contents: [{ parts: [{ text: "Explain how AI works in a few words" }] }],
      generationConfig: { maxOutputTokens: 32, temperature: 0 },
    });
  });
});

// ---------------------------------------------------------------------------
describe("verification against mocked Google responses", () => {
  it("16. reports Verified on a successful generateContent response", async () => {
    const spy = stubGoogle();
    const result = await verifyGeminiCredential({ baseUrl: "https://generativelanguage.googleapis.com", apiKey: KEY_AQ });
    expect(result).toMatchObject({ ok: true, verified: true, status: 200, category: null, detail: null, model: GEMINI_VERIFICATION_MODEL });
    expect(result.latency_ms).toBeGreaterThan(0);
    // The exact credential travels in the documented header, byte-for-byte.
    const [, init] = spy.mock.calls[0];
    expect((init!.headers as Record<string, string>)["X-goog-api-key"]).toBe(KEY_AQ);
    expect(init!.method).toBe("POST");
  });

  it("3. treats a malformed/unrecognized key as a configuration error before any HTTP call", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const probe = await probeProvider("google", "https://generativelanguage.googleapis.com", "not-a-gemini-key");
    expect(probe.ok).toBe(false);
    expect(probe.category).toBe("invalid_request");
    expect(spy).not.toHaveBeenCalled();
  });

  it("8. classifies HTTP 400 (invalid request / unsupported model)", async () => {
    stubGoogle({
      generate: () => new Response(JSON.stringify({ error: { code: 400, message: "The requested model was not found.", status: "INVALID_ARGUMENT" } }), { status: 400 }),
    });
    const result = await verifyGeminiCredential({ apiKey: KEY_AQ });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(result.category).toBe("invalid_request");
    expect(result.detail).toContain("400");
    expect(result.detail).toContain("model was not found");
  });

  it("9. classifies HTTP 401 as an authentication failure with Google's own message", async () => {
    stubGoogle({
      generate: () => new Response(JSON.stringify({ error: { code: 401, message: "API key not valid. Please pass a valid API key.", status: "UNAUTHENTICATED" } }), { status: 401 }),
    });
    const result = await verifyGeminiCredential({ apiKey: KEY_AQ });
    expect(result.ok).toBe(false);
    expect(result.verified).toBe(false);
    expect(result.category).toBe("authentication");
    expect(result.detail).toContain("API key not valid");
  });

  it("10. classifies HTTP 403 as a permission/key-restriction failure", async () => {
    stubGoogle({
      generate: () => new Response(JSON.stringify({ error: { code: 403, message: "Method doesn't allow unregistered callers or request is not valid for consumer.", status: "PERMISSION_DENIED" } }), { status: 403 }),
    });
    const result = await verifyGeminiCredential({ apiKey: KEY_AIZA });
    expect(result.ok).toBe(false);
    expect(result.category).toBe("permission");
    expect(result.detail).toContain("403");
  });

  it("11. classifies HTTP 429 as rate limit / quota exhaustion", async () => {
    stubGoogle({
      generate: () => new Response(JSON.stringify({ error: { code: 429, message: "Resource has been exhausted (e.g. check quota).", status: "RESOURCE_EXHAUSTED" } }), { status: 429 }),
    });
    const result = await verifyGeminiCredential({ apiKey: KEY_AQ });
    expect(result.ok).toBe(false);
    expect(result.category).toBe("rate_limit");
    expect(result.detail).toContain("quota");
  });

  it("classifies 5xx as provider-unavailable (Google service temporarily down)", async () => {
    stubGoogle({ generate: () => new Response(JSON.stringify({ error: { code: 503, message: "The service is currently unavailable.", status: "UNAVAILABLE" } }), { status: 503 }) });
    const result = await verifyGeminiCredential({ apiKey: KEY_AQ });
    expect(result.ok).toBe(false);
    expect(result.category).toBe("provider_unavailable");
    expect(classifyGeminiStatus(500)).toBe("provider_unavailable");
    expect(classifyGeminiStatus(503)).toBe("provider_unavailable");
    expect(classifyGeminiStatus(404)).toBe("model_not_found");
  });

  it("12. classifies timeouts and network failures without inventing an HTTP status", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError"))));
    const timeout = await verifyGeminiCredential({ apiKey: KEY_AQ });
    expect(timeout.ok).toBe(false);
    expect(timeout.status).toBeNull();
    expect(timeout.category).toBe("timeout");
    expect((timeout.detail ?? "").toLowerCase()).toContain("timed out");

    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("fetch failed"))));
    const network = await verifyGeminiCredential({ apiKey: KEY_AQ });
    expect(network.ok).toBe(false);
    expect(network.category).toBe("network");
    expect(network.status).toBeNull();
  });

  it("never substitutes a different model when the verification model fails", async () => {
    stubGoogle({ generate: () => new Response(JSON.stringify({ error: { code: 404, message: "Model gemini-flash-latest is not found for api version v1beta.", status: "NOT_FOUND" } }), { status: 404 }) });
    const result = await verifyGeminiCredential({ apiKey: KEY_AQ });
    expect(result.ok).toBe(false);
    expect(result.model).toBe(GEMINI_VERIFICATION_MODEL);
    // No fallback model was silently tried: exactly one generateContent call happened.
    expect(result.detail).toContain("404");
  });
});

// ---------------------------------------------------------------------------
describe("13. secret redaction", () => {
  it("removes the credential from anything Google echoes back", () => {
    const echoed = `API key not valid. Please pass a valid API key. ${KEY_AQ}`;
    const parsed = parseGeminiError(401, JSON.stringify({ error: { code: 401, message: echoed, status: "UNAUTHENTICATED" } }), KEY_AQ);
    expect(parsed.detail).not.toContain(KEY_AQ);
    expect(parsed.detail).toContain("API key not valid");
    expect(parsed.detail).toContain("[redacted]");
    expect(redactKey(`prefix ${KEY_AIZA} suffix`, KEY_AIZA)).toBe("prefix [redacted] suffix");
  });

  it("sanitizes credentials from provider probe errors and GeminiProvider failures", async () => {
    stubGoogle({
      generate: () => new Response(JSON.stringify({ error: { code: 401, message: `Unauthorized: ${KEY_AQ}`, status: "UNAUTHENTICATED" } }), { status: 401 }),
    });
    const probe = await probeProvider("google", "https://generativelanguage.googleapis.com", KEY_AQ);
    expect(probe.ok).toBe(false);
    expect(JSON.stringify(probe)).not.toContain(KEY_AQ);
    expect(JSON.stringify(probe)).not.toContain(KEY_AIZA);

    const provider = new GeminiProvider(KEY_AQ);
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({ error: { code: 401, message: `Denied for ${KEY_AQ}` } }), { status: 401 }))));
    let message = "";
    try {
      await provider.chat({ model: "gemini-flash-latest", messages: [{ role: "user", content: "hi" }] });
    } catch (error) {
      message = String((error as Error).message) + JSON.stringify(Object.getOwnPropertyNames(error).map((name) => (error as unknown as Record<string, unknown>)[name]));
    }
    expect(message).not.toContain(KEY_AQ);
  });

  it("parseGenerateContentText only extracts model text", () => {
    expect(parseGenerateContentText(JSON.parse(OK_GENERATE))).toBe("AI learns patterns from data.");
    expect(parseGenerateContentText({})).toBe("");
    expect(parseGenerateContentText({ candidates: [{ content: { parts: [{ text: "a" }, { text: "b" }] } }] })).toBe("ab");
  });
});

// ---------------------------------------------------------------------------
describe("14. admin test endpoint end to end", () => {
  it("stores a Gemini account, verifies it with a real request shape, persists the result and hides the key", async () => {
    const added = await callRpc("admin_provider_account_add", { label: "Gemini 1", provider: "google", api_key: KEY_AQ });
    expect(added.status).toBe(200);
    const docId = (added.body.data as { doc_id: string }).doc_id;

    const spy = stubGoogle();
    const result = await callRpc("admin_provider_account_test", { doc_id: docId });
    expect(result.status).toBe(200);
    const data = result.body.data as Record<string, unknown>;
    expect(data).toMatchObject({ ok: true, verified: true, provider: "google", model_used: GEMINI_VERIFICATION_MODEL, status: 200 });
    expect(data.checked_at).toBeTruthy();
    // No credential material anywhere in the response.
    expect(JSON.stringify(result.body)).not.toContain(KEY_AQ);

    // Verification is persisted for the admin list (Configured ≠ Verified).
    const stored = fakeDb.dump("provider_accounts")[docId] as Record<string, unknown>;
    expect(stored.last_test_ok).toBe(true);
    expect(stored.last_test_at).toBeTruthy();
    expect(stored.last_ok_at).toBeTruthy();
    expect(JSON.stringify(stored)).not.toContain(KEY_AQ);

    // Two real requests were made: catalog + documented generateContent.
    expect(spy).toHaveBeenCalledTimes(2);
    const [genUrl, genInit] = spy.mock.calls[1];
    expect(genUrl).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent");
    expect((genInit!.headers as Record<string, string>)["X-goog-api-key"]).toBe(KEY_AQ);
    expect(JSON.parse(String(genInit!.body)).contents[0].parts[0].text).toBe("Explain how AI works in a few words");
  });

  it("reports the real sanitized Google error when the key is rejected", async () => {
    const added = await callRpc("admin_provider_account_add", { label: "Gemini bad", provider: "google", api_key: KEY_AIZA });
    const docId = (added.body.data as { doc_id: string }).doc_id;
    stubGoogle({
      catalog: () => new Response(JSON.stringify({ error: { code: 401, message: `API key not valid. ${KEY_AIZA}`, status: "UNAUTHENTICATED" } }), { status: 401 }),
    });
    const result = await callRpc("admin_provider_account_test", { doc_id: docId });
    const data = result.body.data as Record<string, unknown>;
    expect(data.ok).toBe(false);
    expect(data.verified).toBe(false);
    expect(data.status).toBe(401);
    expect(data.category).toBe("authentication");
    expect(String(data.error)).toContain("API key not valid");
    expect(JSON.stringify(result.body)).not.toContain(KEY_AIZA);
    const stored = fakeDb.dump("provider_accounts")[docId] as Record<string, unknown>;
    expect(stored.last_test_ok).toBe(false);
    expect(stored.last_test_category).toBe("authentication");
  });

  it("returns Unavailable (no persisted success) when Google cannot be reached", async () => {
    const added = await callRpc("admin_provider_account_add", { label: "Gemini offline", provider: "google", api_key: KEY_AQ });
    const docId = (added.body.data as { doc_id: string }).doc_id;
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("fetch failed"))));
    const result = await callRpc("admin_provider_account_test", { doc_id: docId });
    const data = result.body.data as Record<string, unknown>;
    expect(data.ok).toBe(false);
    expect(data.category).toBe("network");
    expect(data.status).toBeNull();
    const stored = fakeDb.dump("provider_accounts")[docId] as Record<string, unknown>;
    expect(stored.last_test_ok).toBe(false);
    expect(stored.last_ok_at).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
describe("15. Gemini failure never disturbs the existing Groq infrastructure", () => {
  it("a rejected Gemini credential leaves Groq rotation, availability and error state untouched", async () => {
    await addStoredAccount(db, { label: "Groq team", apiKey: GROQ_KEY, addedBy: "actor-super" });
    await addStoredAccount(db, { label: "Gemini 1", apiKey: KEY_AQ, addedBy: "actor-super", provider: "google" });
    await ensureAccounts(db, true);

    stubGoogle({
      generate: () => new Response(JSON.stringify({ error: { code: 401, message: "API key not valid.", status: "UNAUTHENTICATED" } }), { status: 401 }),
      catalog: () => new Response(JSON.stringify({ error: { code: 401, message: "API key not valid.", status: "UNAUTHENTICATED" } }), { status: 401 }),
    });
    const geminiProbe = await probeProvider("google", "https://generativelanguage.googleapis.com", KEY_AQ);
    expect(geminiProbe.ok).toBe(false);
    expect(geminiProbe.category).toBe("authentication");

    // Groq is completely unaffected: still selectable, still available, not paused.
    const choice = selectAccount("openai/gpt-oss-120b", 100);
    expect(choice.account?.provider).toBe("groq");
    expect(nextAvailability("openai/gpt-oss-120b")).toBeNull();
    expect(unavailableReason("openai/gpt-oss-120b")).toBe("provider_unavailable");
  });

  it("a GeminiProvider chat failure raises a typed error and touches no Groq account state", async () => {
    await addStoredAccount(db, { label: "Groq team", apiKey: GROQ_KEY, addedBy: "actor-super" });
    await ensureAccounts(db, true);

    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({ error: { code: 503, message: "backend error", status: "UNAVAILABLE" } }), { status: 503 }))));
    const provider = new GeminiProvider(KEY_AQ);
    await expect(provider.chat({ model: "gemini-flash-latest", messages: [{ role: "user", content: "hi" }] })).rejects.toMatchObject({
      name: "AIProviderError",
      status: 503,
      type: "provider_unavailable",
    });

    const choice = selectAccount("openai/gpt-oss-120b", 100);
    expect(choice.account?.provider).toBe("groq");
    expect(nextAvailability("openai/gpt-oss-120b")).toBeNull();
  });

  it("the Gemini adapter serves the shared AIProvider surface (chat, stream, models, health)", async () => {
    const spy = stubGoogle();
    const provider = new GeminiProvider(KEY_AQ);
    const response = await provider.chat({ model: "gemini-flash-latest", messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "Explain AI." }], maxTokens: 64, temperature: 0.2 });
    expect(response.content).toBe("AI learns patterns from data.");
    expect(response.model).toBe("gemini-flash-latest");
    expect(response.usage).toEqual({ promptTokens: 12, completionTokens: 7, totalTokens: 19 });

    const [chatUrl, chatInit] = spy.mock.calls.find(([url]) => String(url).includes(":generateContent"))!;
    expect(chatUrl).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent");
    const body = JSON.parse(String(chatInit!.body)) as { systemInstruction?: { parts: { text: string }[] }; contents: { role: string; parts: { text: string }[] }[] };
    expect(body.systemInstruction?.parts[0].text).toBe("Be brief.");
    expect(body.contents).toEqual([{ role: "user", parts: [{ text: "Explain AI." }] }]);

    const models = await provider.listModels();
    expect(models.map((model) => model.id)).toEqual(["gemini-2.0-flash", "gemini-flash-latest"]);
    expect(models[1].contextTokens).toBe(1_048_576);

    await expect(provider.verifyModel("model-not-in-catalog")).rejects.toMatchObject({ name: "AIProviderError", modelUnavailable: true });

    const stream: string[] = [];
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(
      new Blob([
        'data: {"candidates":[{"content":{"parts":[{"text":"Hel"}]}}]}\n\n',
        'data: {"candidates":[{"content":{"parts":[{"text":"lo"}]}}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":2,"totalTokenCount":3}}\n\n',
      ]),
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    ))));
    for await (const delta of provider.streamChat({ model: "gemini-flash-latest", messages: [{ role: "user", content: "hi" }] })) stream.push(delta);
    expect(stream.join("")).toBe("Hello");
  });
});
