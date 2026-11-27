import "server-only";

// =============================================================================
// Bring-your-own model providers (Issue 8).
//
// Users can register an OpenAI-compatible endpoint with their own API key. Keys
// are encrypted at rest (AES-256-GCM, same secret pattern as the GitHub OAuth
// token) and are NEVER returned to the client, sent to any other provider, or
// exposed to the model. Every query is strictly scoped by the authenticated
// user id (see Issue 9): a second user can never list, read, or use another
// user's provider.
//
// Storage document (collection `user_providers`):
//   id, user_id, name, base_url, encrypted_key, models[], enabled,
//   last_verified_at, last_error, created_at, updated_at
// =============================================================================

import { createHash, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import type { Db } from "@/lib/firebase/admin";
import { adminDb } from "@/lib/firebase/admin";
import { RpcError } from "@/lib/server/errors";
import { createOpenAICompatibleProvider } from "@/lib/ai/openai";
import type { AIRouteTarget } from "@/lib/ai/config";
import type { AIProviderName } from "@/lib/ai/provider-error";
import type { ModelStatus } from "@/lib/ai/models/types";

const COLLECTION = "user_providers";

// ---------------------------------------------------------------------------
// Encryption (keys at rest, server-only)
// ---------------------------------------------------------------------------
function encryptionSecret(): string {
  return (
    process.env.PROVIDER_SECRET_KEY ||
    process.env.GITHUB_TOKEN_ENCRYPTION_KEY ||
    process.env.FIREBASE_PRIVATE_KEY ||
    ""
  ).trim();
}

export function canEncryptProviderKey(): boolean {
  const raw = encryptionSecret();
  return raw.length >= 16 && !raw.includes("replace-with");
}

function encryptionKey(): Buffer {
  const raw = encryptionSecret();
  if (!canEncryptProviderKey()) throw new RpcError("SECRET_KEY_MISSING", 500, "Provider key encryption is not configured on the server.");
  return createHash("sha256").update(raw).digest();
}

export function encryptProviderKey(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((part) => part.toString("base64url")).join(".");
}

export function decryptProviderKey(encoded: string): string {
  const [ivRaw, tagRaw, encryptedRaw] = encoded.split(".");
  if (!ivRaw || !tagRaw || !encryptedRaw) throw new RpcError("PROVIDER_KEY_INVALID", 400, "The stored provider key is corrupt.");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivRaw, "base64url"));
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encryptedRaw, "base64url")), decipher.final()]).toString("utf8");
}

/** Mask a key for display: sk-***1234. */
export function maskApiKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length <= 8) return "***";
  const prefix = trimmed.slice(0, Math.min(3, trimmed.length - 4));
  const last4 = trimmed.slice(-4);
  return `${prefix}***${last4}`;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
export function isCompatibleBaseUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    if (url.username || url.password) return false;
    return url.pathname.length <= 300;
  } catch {
    return false;
  }
}

function sanitizeModelId(value: unknown): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id || id.length > 220 || /\s/.test(id) || /[\x00-\x1f]/.test(id)) return "";
  return id;
}

function sanitizeName(value: string): string {
  return value.trim().slice(0, 60) || "My provider";
}

export type CustomModelInput = { id: string; label?: string };
export type UserProviderInput = {
  name: string;
  base_url: string;
  api_key: string;
  models: CustomModelInput[];
  enabled?: boolean;
};

export type StoredUserProvider = {
  user_id: string;
  name: string;
  base_url: string;
  encrypted_key: string;
  models: { id: string; label: string }[];
  enabled: boolean;
  last_verified_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

export type PublicUserProvider = {
  id: string;
  name: string;
  base_url: string;
  key_mask: string;
  models: { id: string; label: string }[];
  enabled: boolean;
  last_verified_at: string | null;
  last_error: string | null;
};

function toPublic(id: string, data: StoredUserProvider): PublicUserProvider {
  return {
    id,
    name: data.name,
    base_url: data.base_url,
    key_mask: maskApiKey(decryptProviderKey(data.encrypted_key)),
    models: data.models,
    enabled: data.enabled,
    last_verified_at: data.last_verified_at,
    last_error: data.last_error,
  };
}

// ---------------------------------------------------------------------------
// CRUD — every reader/writer is strictly scoped by user_id (Issue 9)
// ---------------------------------------------------------------------------
export async function listUserProviders(d: Db, uid: string): Promise<PublicUserProvider[]> {
  const snap = await d.collection(COLLECTION).where("user_id", "==", uid).get();
  return snap.docs.map((doc) => toPublic(doc.id, doc.data() as StoredUserProvider)).sort((a, b) => a.name.localeCompare(b.name));
}

export async function getUserProvider(d: Db, uid: string, id: string): Promise<StoredUserProvider | null> {
  const ref = d.collection(COLLECTION).doc(id);
  const snap = await ref.get();
  if (!snap.exists) return null;
  const data = snap.data() as StoredUserProvider;
  return data.user_id === uid ? data : null;
}

/** Returns the decrypted key only for the owning user. Throws if absent/mismatched. */
async function getDecryptedKeyForUser(d: Db, uid: string, id: string): Promise<string> {
  const data = await getUserProvider(d, uid, id);
  if (!data) throw new RpcError("PROVIDER_NOT_FOUND", 404, "That provider does not exist.");
  return decryptProviderKey(data.encrypted_key);
}

/** Probe a candidate provider before it is saved: a 1-token completion. */
export async function testProviderConnection(input: { base_url: string; api_key: string; model_id: string }): Promise<{ ok: boolean; status: number | null; code: string; message: string }> {
  if (!isCompatibleBaseUrl(input.base_url)) return { ok: false, status: null, code: "INVALID_BASE_URL", message: "Enter a valid https:// base URL (e.g. https://api.openai.com/v1)." };
  if (input.api_key.trim().length < 8) return { ok: false, status: null, code: "INVALID_KEY", message: "The API key looks too short to be valid." };
  const provider = createOpenAICompatibleProvider({ apiKey: input.api_key, baseUrl: input.base_url, label: input.model_id, model: input.model_id });
  try {
    const res = await provider.chat({
      model: input.model_id,
      messages: [{ role: "user", content: "Reply with the single word OK." }],
      maxTokens: 4,
      temperature: 0,
      signal: AbortSignal.timeout(20_000),
    });
    const ok = Boolean(res.content?.trim());
    return { ok, status: 200, code: ok ? "OK" : "EMPTY_RESPONSE", message: ok ? "Connection verified." : "The provider returned an empty response." };
  } catch (error) {
    const status = error instanceof Error && "status" in error ? (error as { status?: number }).status ?? null : null;
    const detail = error instanceof Error ? error.message.slice(0, 200) : "Connection failed.";
    const code = /401|unauthorized|invalid/i.test(detail) || status === 401 ? "INVALID_KEY" : /429|rate/i.test(detail) || status === 429 ? "RATE_LIMITED" : "CONNECTION_FAILED";
    return { ok: false, status, code, message: detail };
  }
}

export async function addUserProvider(d: Db, uid: string, input: UserProviderInput): Promise<PublicUserProvider> {
  if (!canEncryptProviderKey()) throw new RpcError("SECRET_KEY_MISSING", 500, "Provider key encryption is not configured on the server.");
  const name = sanitizeName(input.name);
  if (!isCompatibleBaseUrl(input.base_url)) throw new RpcError("INVALID_BASE_URL", 400, "Enter a valid https:// base URL (e.g. https://api.openai.com/v1).");
  const models = input.models.map((m) => ({ id: sanitizeModelId(m.id), label: (m.label?.trim() || sanitizeModelId(m.id)).slice(0, 80) })).filter((m) => m.id);
  if (models.length === 0) throw new RpcError("NO_MODELS", 400, "Add at least one model ID for this provider.");
  const probe = await testProviderConnection({ base_url: input.base_url, api_key: input.api_key, model_id: models[0].id });
  const now = new Date().toISOString();
  const ref = d.collection(COLLECTION).doc();
  const stored: StoredUserProvider = {
    user_id: uid,
    name,
    base_url: input.base_url.trim().replace(/\/+$/, ""),
    encrypted_key: encryptProviderKey(input.api_key),
    models,
    enabled: input.enabled !== false,
    last_verified_at: probe.ok ? now : null,
    last_error: probe.ok ? null : `${probe.code}: ${probe.message}`,
    created_at: now,
    updated_at: now,
  };
  await ref.set(stored);
  return toPublic(ref.id, stored);
}

export async function deleteUserProvider(d: Db, uid: string, id: string): Promise<void> {
  const data = await getUserProvider(d, uid, id);
  if (!data) throw new RpcError("PROVIDER_NOT_FOUND", 404, "That provider does not exist.");
  await d.collection(COLLECTION).doc(id).delete();
}

export async function setProviderEnabled(d: Db, uid: string, id: string, enabled: boolean): Promise<PublicUserProvider> {
  const data = await getUserProvider(d, uid, id);
  if (!data) throw new RpcError("PROVIDER_NOT_FOUND", 404, "That provider does not exist.");
  const now = new Date().toISOString();
  await d.collection(COLLECTION).doc(id).set({ enabled, updated_at: now }, { merge: true });
  return toPublic(id, { ...data, enabled, updated_at: now });
}

export async function reverifyProvider(d: Db, uid: string, id: string): Promise<PublicUserProvider> {
  const data = await getUserProvider(d, uid, id);
  if (!data) throw new RpcError("PROVIDER_NOT_FOUND", 404, "That provider does not exist.");
  const key = decryptProviderKey(data.encrypted_key);
  const probe = await testProviderConnection({ base_url: data.base_url, api_key: key, model_id: data.models[0]?.id ?? "" });
  const now = new Date().toISOString();
  await d.collection(COLLECTION).doc(id).set(
    { last_verified_at: probe.ok ? now : data.last_verified_at, last_error: probe.ok ? null : `${probe.code}: ${probe.message}`, updated_at: now },
    { merge: true },
  );
  return toPublic(id, { ...data, last_verified_at: probe.ok ? now : data.last_verified_at, last_error: probe.ok ? null : `${probe.code}: ${probe.message}`, updated_at: now });
}

// ---------------------------------------------------------------------------
// Routing integration (Issue 8): build AIRouteTargets for the user's ENABLED
// custom providers so their traffic (their key, their quota) is tried first.
// ---------------------------------------------------------------------------
export async function customRouteTargets(d: Db, uid: string): Promise<AIRouteTarget[]> {
  const providers = await d.collection(COLLECTION).where("user_id", "==", uid).where("enabled", "==", true).get();
  const targets: AIRouteTarget[] = [];
  for (const doc of providers.docs) {
    const data = doc.data() as StoredUserProvider;
    let key: string;
    try {
      key = decryptProviderKey(data.encrypted_key);
    } catch {
      continue;
    }
    for (const model of data.models) {
      targets.push({
        provider: "OpenAI" as AIProviderName,
        providerId: `custom:${doc.id}`,
        model: model.id,
        client: createOpenAICompatibleProvider({ apiKey: key, baseUrl: data.base_url, label: `${data.name} · ${model.label}`, model: model.id }),
        tier: "high",
        contextTokens: 128_000,
      });
    }
  }
  return targets;
}

// ---------------------------------------------------------------------------
// /models listing: surface the user's custom models with a "Custom" badge.
// ---------------------------------------------------------------------------
export async function listCustomModelStatus(d: Db, uid: string): Promise<ModelStatus[]> {
  const providers = await d.collection(COLLECTION).where("user_id", "==", uid).get();
  const out: ModelStatus[] = [];
  for (const doc of providers.docs) {
    const data = doc.data() as StoredUserProvider;
    for (const model of data.models) {
      out.push({
        key: `custom:${doc.id}:${model.id}`,
        label: model.label || model.id,
        summary: `Your ${data.name} model (${model.id}).`,
        model_id: model.id,
        provider: "Custom",
        providerLabel: `Custom · ${data.name}`,
        availability: data.enabled ? "available" : "not_configured",
        reason: data.enabled ? "Ready" : "Disabled",
        is_default: false,
        is_custom: true,
        custom_provider: data.name,
        strengths: ["fast", "coding", "writing"],
        context_tokens: 128_000,
        max_output_tokens: 8_192,
        streaming: true,
        tool_calling: true,
        structured_output: true,
        status_code: data.enabled ? "available" : "configuration_missing",
        status_label: data.enabled ? "Available" : "Disabled",
        supported_modes: ["general", "code", "study", "research", "health", "orchestrator", "agent"],
        last_tested_at: data.last_verified_at,
        last_error: data.last_error ? { code: "PROVIDER_ERROR", message: data.last_error, status: null, at: data.updated_at } : null,
        diagnostic_hint: null,
      } as unknown as ModelStatus);
    }
  }
  return out;
}

/** Convenience for callers that do not hold a Db handle yet. */
export async function listUserProvidersFor(uid: string): Promise<PublicUserProvider[]> {
  return listUserProviders(adminDb(), uid);
}
