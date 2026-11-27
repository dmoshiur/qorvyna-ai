// Admin "Provider accounts & models" system: provider key validation, the live
// catalog probe, encrypted multi-provider storage, Groq-rotation isolation,
// per-provider model management, and the /api/rpc actions end to end.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeFakeFirestore } from "./helpers/test-db";
import type { Db } from "../src/lib/firebase/admin";

const fakeDb = makeFakeFirestore();
// The lib functions take the Firestore `Db` type; the fake satisfies every
// operation this suite uses.
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

const { POST } = await import("../src/app/api/rpc/route");
const {
  addStoredAccount,
  accountStatuses,
  ensureAccounts,
  groqAccounts,
  listAccounts,
  listStoredAccounts,
  observeHeaders,
  resetAccountsForTests,
  selectAccount,
  storedAccountCredentials,
} = await import("../src/lib/ai/accounts");
const { validateProviderKey, probeProvider } = await import("../src/lib/ai/providers");
const { addProviderModel, listModelsForAccount, listProviderModels, removeProviderModel, updateProviderModel } = await import(
  "../src/lib/ai/provider-models"
);

const SECRET = "2f9c1a77b0e4d5316a8c9f0e1b2d3c4a";
const GROQ_KEY = "gsk_" + "a".repeat(32);
const OPENAI_KEY = "sk-" + "b".repeat(32);
const ANTHROPIC_KEY = "sk-ant-" + "c".repeat(32);
const GOOGLE_KEY = "AIza" + "d".repeat(35);

function col(name: string) {
  return fakeDb.collection(name);
}

/** Remove every document the suite writes so tests start from a clean store. */
async function clearDb() {
  for (const name of ["provider_accounts", "provider_models", "provider_account_status", "audit_logs", "admin_role_assignments"]) {
    const snap = await col(name).get();
    for (const doc of snap.docs) await col(name).doc(doc.id).delete();
  }
}

async function callRpc(action: string, args: Record<string, unknown> = {}) {
  const req = new Request("http://localhost/api/rpc", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost" },
    body: JSON.stringify({ action, ...args }),
  });
  const res = await POST(req as never);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function stubFetch(impl: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const spy = vi.fn((url: RequestInfo | URL, init?: RequestInit) => Promise.resolve(impl(String(url), init)));
  vi.stubGlobal("fetch", spy);
  return spy;
}

beforeEach(async () => {
  process.env.PROVIDER_SECRET_KEY = SECRET;
  resetAccountsForTests();
  sessionUid = "actor-super";
  await clearDb();
  // Grant the session user the system.settings permission via a super role.
  await col("admin_role_assignments").doc("actor-super").set({ role_id: "super_admin" });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("provider key validation", () => {
  it("accepts the native key shape for every supported provider", () => {
    expect(validateProviderKey("groq", GROQ_KEY)).toBe(GROQ_KEY);
    expect(validateProviderKey("openai", OPENAI_KEY)).toBe(OPENAI_KEY);
    expect(validateProviderKey("anthropic", ANTHROPIC_KEY)).toBe(ANTHROPIC_KEY);
    expect(validateProviderKey("google", GOOGLE_KEY)).toBe(GOOGLE_KEY);
    expect(validateProviderKey("openai_compatible", "some-custom-key-1234567890abcdef")).toBe("some-custom-key-1234567890abcdef");
  });

  it("rejects keys from another provider and malformed input", () => {
    expect(validateProviderKey("groq", OPENAI_KEY)).toBe("");
    expect(validateProviderKey("openai", GROQ_KEY)).toBe("");
    expect(validateProviderKey("anthropic", "sk-" + "x".repeat(32))).toBe("");
    expect(validateProviderKey("google", "AIza" + "d".repeat(10))).toBe("");
    expect(validateProviderKey("groq", "short")).toBe("");
    expect(validateProviderKey("groq", "gsk_ with spaces")).toBe("");
    expect(validateProviderKey("unknown", GROQ_KEY)).toBe("");
  });
});

describe("provider catalog probe", () => {
  it("queries OpenAI-compatible /models and parses the catalog", async () => {
    const spy = stubFetch(() =>
      new Response(JSON.stringify({ data: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }] }), { status: 200 }),
    );
    const result = await probeProvider("openai", "https://api.openai.com/v1", OPENAI_KEY);
    expect(result.ok).toBe(true);
    expect(result.models).toEqual(["gpt-4o", "gpt-4o-mini"]);
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/models");
    expect((init!.headers as Record<string, string>).Authorization).toBe(`Bearer ${OPENAI_KEY}`);
  });

  it("queries Anthropic with x-api-key and parses the catalog", async () => {
    const spy = stubFetch(() => new Response(JSON.stringify({ data: [{ id: "claude-sonnet-4-5" }] }), { status: 200 }));
    const result = await probeProvider("anthropic", "https://api.anthropic.com", ANTHROPIC_KEY);
    expect(result.ok).toBe(true);
    expect(result.models).toEqual(["claude-sonnet-4-5"]);
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/models");
    const headers = init!.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe(ANTHROPIC_KEY);
    expect(headers["anthropic-version"]).toBe("2023-06-01");
  });

  it("queries Google and normalizes model names", async () => {
    const spy = stubFetch(() => new Response(JSON.stringify({ models: [{ name: "models/gemini-2.0-flash" }] }), { status: 200 }));
    const result = await probeProvider("google", "https://generativelanguage.googleapis.com", GOOGLE_KEY);
    expect(result.ok).toBe(true);
    expect(result.models).toEqual(["gemini-2.0-flash"]);
    const [url] = spy.mock.calls[0];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models");
  });

  it("reports rejected credentials and never invents models", async () => {
    stubFetch(() => new Response("nope", { status: 401 }));
    const rejected = await probeProvider("openai", "https://api.openai.com/v1", OPENAI_KEY);
    expect(rejected.ok).toBe(false);
    expect(rejected.status).toBe(401);
    expect(rejected.error).toContain("rejected");

    const invalid = await probeProvider("groq", "https://api.groq.com/openai/v1", "not-a-key");
    expect(invalid.ok).toBe(false);
    expect(invalid.models).toEqual([]);

    const badBase = await probeProvider("openai", "not-a-url", OPENAI_KEY);
    expect(badBase.ok).toBe(false);
  });
});

describe("multi-provider account storage", () => {
  it("stores Groq and OpenAI credentials encrypted, never in plaintext", async () => {
    const groq = await addStoredAccount(db, { label: "Groq team", apiKey: GROQ_KEY, addedBy: "actor-super" });
    const openai = await addStoredAccount(db, {
      label: "OpenAI team",
      apiKey: OPENAI_KEY,
      addedBy: "actor-super",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
    });
    expect(groq.id).not.toBe(openai.id);

    await ensureAccounts(db, true);
    const stored = await listStoredAccounts(db);
    expect(stored.map((item) => item.provider)).toEqual(["groq", "openai"]);
    expect(stored[0].base_url).toBe("https://api.groq.com/openai/v1");
    expect(stored[1].base_url).toBe("https://api.openai.com/v1");
    expect(stored[1].provider_label).toBe("OpenAI (ChatGPT)");
    expect(JSON.stringify(stored)).not.toContain(GROQ_KEY);
    expect(JSON.stringify(stored)).not.toContain(OPENAI_KEY);

    const raw = fakeDb.dump("provider_accounts");
    expect(JSON.stringify(raw)).not.toContain(GROQ_KEY);
    expect(JSON.stringify(raw)).not.toContain(OPENAI_KEY);
  });

  it("rejects invalid keys, missing base URLs and duplicates", async () => {
    await expect(addStoredAccount(db, { label: "x", apiKey: "sk-short", addedBy: "u" })).rejects.toMatchObject({ code: "INVALID_API_KEY" });
    await expect(
      addStoredAccount(db, { label: "x", apiKey: "some-custom-key-1234567890abcdef", addedBy: "u", provider: "openai_compatible" }),
    ).rejects.toMatchObject({ code: "INVALID_PROVIDER_BASE_URL" });
    await expect(addStoredAccount(db, { label: "x", apiKey: "weird", addedBy: "u", provider: "nonsense" })).rejects.toMatchObject({ code: "INVALID_PROVIDER" });

    await addStoredAccount(db, { label: "x", apiKey: GROQ_KEY, addedBy: "u" });
    await expect(addStoredAccount(db, { label: "dup", apiKey: GROQ_KEY, addedBy: "u" })).rejects.toMatchObject({ code: "ACCOUNT_EXISTS" });
  });

  it("keeps the Groq rotation helpers isolated to Groq accounts", async () => {
    await addStoredAccount(db, { label: "Groq", apiKey: GROQ_KEY, addedBy: "u" });
    await addStoredAccount(db, { label: "OpenAI", apiKey: OPENAI_KEY, addedBy: "u", provider: "openai", baseUrl: "https://api.openai.com/v1" });
    await ensureAccounts(db, true);

    expect(listAccounts().map((account) => account.provider)).toEqual(["groq", "openai"]);
    expect(groqAccounts().map((account) => account.provider)).toEqual(["groq"]);

    // The OpenAI account must never be selected for a Groq model.
    const choice = selectAccount("openai/gpt-oss-120b", 100);
    expect(choice.account?.provider).toBe("groq");
  });

  it("never leaks Groq window state into another provider's status", async () => {
    await addStoredAccount(db, { label: "Groq", apiKey: GROQ_KEY, addedBy: "u" });
    await addStoredAccount(db, { label: "OpenAI", apiKey: OPENAI_KEY, addedBy: "u", provider: "openai", baseUrl: "https://api.openai.com/v1" });
    resetAccountsForTests();
    await ensureAccounts(db, true);

    const [groq, openai] = listAccounts();
    observeHeaders(groq.id, "openai/gpt-oss-120b", new Headers({
      "x-ratelimit-limit-requests": "30",
      "x-ratelimit-remaining-requests": "0",
      "x-ratelimit-reset-requests": "60s",
    }));

    const statuses = accountStatuses();
    const openaiStatus = statuses.find((status) => status.id === openai.id)!;
    expect(openaiStatus.provider).toBe("openai");
    expect(openaiStatus.provider_label).toBe("OpenAI (ChatGPT)");
    expect(openaiStatus.base_url).toBe("https://api.openai.com/v1");
    expect(openaiStatus.models).toEqual([]);
    expect(openaiStatus.state).toBe("ready");

    const groqStatus = statuses.find((status) => status.id === groq.id)!;
    expect(groqStatus.models).toHaveLength(1);
    expect(JSON.stringify(statuses)).not.toContain(GROQ_KEY);
    expect(JSON.stringify(statuses)).not.toContain(OPENAI_KEY);
  });

  it("decrypts stored credentials only for server-side testing", async () => {
    const added = await addStoredAccount(db, { label: "OpenAI", apiKey: OPENAI_KEY, addedBy: "u", provider: "openai" });
    const creds = await storedAccountCredentials(db, added.doc_id);
    expect(creds?.provider).toBe("openai");
    expect(creds?.key).toBe(OPENAI_KEY);
    expect(await storedAccountCredentials(db, "missing")).toBeNull();
  });
});

describe("per-provider models", () => {
  it("adds, lists, updates and removes models for a provider account", async () => {
    const account = await addStoredAccount(db, { label: "OpenAI", apiKey: OPENAI_KEY, addedBy: "u", provider: "openai" });
    await ensureAccounts(db, true);

    const added = await addProviderModel(db, { accountId: account.id, modelId: "gpt-4o", label: "GPT-4o", contextTokens: 128_000, provider: "openai", addedBy: "u" });
    expect(added.model_id).toBeTruthy();

    const models = await listModelsForAccount(db, account.id);
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ model_id: "gpt-4o", label: "GPT-4o", context_tokens: 128_000, enabled: true });

    await updateProviderModel(db, added.model_id, { enabled: false });
    expect((await listModelsForAccount(db, account.id))[0].enabled).toBe(false);

    await removeProviderModel(db, added.model_id);
    expect(await listModelsForAccount(db, account.id)).toHaveLength(0);
  });

  it("validates model IDs, providers and duplicates", async () => {
    const account = await addStoredAccount(db, { label: "OpenAI", apiKey: OPENAI_KEY, addedBy: "u", provider: "openai" });
    await addProviderModel(db, { accountId: account.id, modelId: "gpt-4o", provider: "openai" });

    await expect(addProviderModel(db, { accountId: account.id, modelId: "has space", provider: "openai" })).rejects.toMatchObject({ code: "INVALID_PROVIDER_MODEL" });
    await expect(addProviderModel(db, { accountId: "", modelId: "gpt-4o", provider: "openai" })).rejects.toMatchObject({ code: "INVALID_PROVIDER_MODEL" });
    await expect(addProviderModel(db, { accountId: account.id, modelId: "gpt-4o", provider: "openai" })).rejects.toMatchObject({ code: "PROVIDER_MODEL_EXISTS" });
    await expect(addProviderModel(db, { accountId: account.id, modelId: "gpt-4o", provider: "nonsense" })).rejects.toMatchObject({ code: "INVALID_PROVIDER" });

    expect(await listProviderModels(db)).toHaveLength(1);
  });
});

describe("/api/rpc provider accounts & models", () => {
  it("lists connected accounts with their models", async () => {
    const empty = await callRpc("admin_provider_accounts_list");
    expect(empty.status).toBe(200);
    expect(empty.body).toMatchObject({ success: true, data: { accounts: [], stored: [], models: {} } });

    await callRpc("admin_provider_account_add", { label: "Groq A", provider: "groq", api_key: GROQ_KEY });
    await callRpc("admin_provider_account_add", { label: "OpenAI A", provider: "openai", api_key: OPENAI_KEY, base_url: "https://api.openai.com/v1" });

    const list = await callRpc("admin_provider_accounts_list");
    const data = list.body.data as { stored: { provider: string }[]; accounts: { provider: string }[] };
    expect(data.stored.map((item) => item.provider)).toEqual(["groq", "openai"]);
    expect(data.accounts.map((item) => item.provider)).toEqual(["groq", "openai"]);
  });

  it("adds and manages models through the RPC surface", async () => {
    const added = await callRpc("admin_provider_account_add", { label: "OpenAI A", provider: "openai", api_key: OPENAI_KEY });
    const accountId = (added.body.data as { id: string }).id;

    const model = await callRpc("admin_provider_model_add", { account_id: accountId, model_id: "gpt-4o", label: "GPT-4o", provider: "openai" });
    expect(model.status).toBe(200);
    const modelId = (model.body.data as { model_id: string }).model_id;

    const list = await callRpc("admin_provider_models_list");
    expect(list.body.data).toMatchObject({ models: [{ model_id: "gpt-4o", account_id: accountId, provider: "openai" }] });

    const updated = await callRpc("admin_provider_model_update", { model_id: modelId, enabled: false });
    expect(updated.status).toBe(200);

    const removed = await callRpc("admin_provider_model_remove", { model_id: modelId });
    expect(removed.status).toBe(200);
    const after = await callRpc("admin_provider_models_list");
    expect((after.body.data as { models: unknown[] }).models).toHaveLength(0);
  });

  it("tests a stored credential against the provider's live catalog", async () => {
    const added = await callRpc("admin_provider_account_add", { label: "OpenAI A", provider: "openai", api_key: OPENAI_KEY });
    const docId = (added.body.data as { doc_id: string }).doc_id;

    stubFetch(() => new Response(JSON.stringify({ data: [{ id: "gpt-4o" }] }), { status: 200 }));
    const result = await callRpc("admin_provider_account_test", { doc_id: docId });
    expect(result.status).toBe(200);
    expect(result.body.data).toMatchObject({ ok: true, models: ["gpt-4o"], provider: "openai" });
  });

  it("rejects invalid credentials and non-admin callers", async () => {
    const invalid = await callRpc("admin_provider_account_add", { label: "x", provider: "groq", api_key: "nope" });
    expect(invalid.status).toBe(400);
    expect(invalid.body).toMatchObject({ success: false, error: { code: "INVALID_API_KEY" } });

    sessionUid = "regular-user";
    const denied = await callRpc("admin_provider_accounts_list");
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ success: false, error: { code: "PERMISSION_DENIED" } });
  });
});
