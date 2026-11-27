// =============================================================================
// Server-side provider verification for the admin "Provider accounts" system.
//
// A provider type knows what its API keys look like (so a mistyped key is
// rejected before it is encrypted and stored) and how to list the models the
// account can actually use — a real request to the provider's own catalog
// endpoint, never an invented list.
//
// The API key is validated here and encrypted before storage (see accounts.ts);
// it is never returned to the browser.
// =============================================================================

import "server-only";
import { parseModelCatalog } from "@/lib/ai/model-catalog";
import { sanitizeProviderDetail } from "@/lib/ai/provider-error";
import { RpcError } from "@/lib/server/errors";
import {
  normalizeBaseUrl,
  providerInfo,
  type ProviderType,
} from "@/lib/ai/provider-types";
import { classifyGeminiStatus, geminiErrorFromException, geminiModelsUrl, geminiHeaders, parseGeminiError, verifyGeminiCredential, redactKey, type GeminiErrorCategory } from "@/lib/ai/gemini";

export type { ProviderInfo, ProviderType } from "@/lib/ai/provider-types";
export { PROVIDERS, PROVIDER_TYPES, normalizeBaseUrl, providerInfo } from "@/lib/ai/provider-types";

/** Trim + basic shape check; the provider-specific pattern is applied by `validateProviderKey`. */
function cleanKey(value: unknown): string {
  const key = typeof value === "string" ? value.trim() : "";
  return key.length >= 8 && !/\s/.test(key) ? key : "";
}

/** Validate a key for a provider type. Returns the cleaned key, or "" when invalid. */
export function validateProviderKey(type: string, value: unknown): string {
  const info = providerInfo(type);
  if (!info) return "";
  const key = cleanKey(value);
  if (!key) return "";
  return info.keyPattern.test(key) ? key : "";
}

export type ProviderErrorCategory =
  | "invalid_request"
  | "authentication"
  | "permission"
  | "model_not_found"
  | "rate_limit"
  | "quota"
  | "provider_unavailable"
  | "timeout"
  | "network"
  | "unknown";

export type ProviderProbeResult = {
  ok: boolean;
  /** Model IDs the provider reported for this account (empty when unreachable). */
  models: string[];
  error: string | null;
  status: number | null;
  /** Classified failure, so the admin console can explain WHY a test failed. */
  category: ProviderErrorCategory | null;
  /** True only when the provider accepted a real authenticated request. */
  verified: boolean;
  /** Sanitized upstream explanation (never a credential or header). */
  detail: string | null;
  /** The model the verification request actually used (Google only). */
  model_used: string | null;
  latency_ms: number | null;
};

function probeFailure(error: string): ProviderProbeResult {
  return { ok: false, models: [], error, status: null, category: "invalid_request", verified: false, detail: null, model_used: null, latency_ms: null };
}

/** HTTP status → category + a sanitized, useful message (no credential material). */
function classifyHttpStatus(status: number, apiKey = ""): { category: ProviderErrorCategory; error: string } {
  const category = classifyGeminiStatus(status);
  const messages: Record<number, string> = {
    400: "Invalid request — the provider rejected the endpoint or parameters (HTTP 400).",
    401: "Authentication failed — the provider rejected this API key (HTTP 401).",
    403: "Access denied — the key may lack permission or be restricted for this account (HTTP 403).",
    404: "Not found — the endpoint or model does not exist for this key (HTTP 404).",
    429: "Rate limit or quota exceeded (HTTP 429).",
  };
  const fallback = `The provider answered with status ${status}.`;
  return { category, error: redactKey(messages[status] ?? fallback, apiKey) };
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password;
  } catch {
    return false;
  }
}

function basePath(base: string): string {
  try {
    return new URL(base).pathname.replace(/\/+$/, "");
  } catch {
    return "";
  }
}

/**
 * Ask a provider which models this account can use — and, for Google, verify
 * the credential with a REAL authenticated generateContent request.
 *
 *   • OpenAI-compatible: `GET {base}/models` (Bearer).
 *   • Anthropic:         `GET {base}/v1/models` (x-api-key).
 *   • Google (Gemini):   `GET {base}/v1beta/models` (X-goog-api-key) followed
 *     by `POST {base}/v1beta/models/{model}:generateContent` — the documented
 *     authenticated request. The API key travels only in `X-goog-api-key`,
 *     byte-for-byte as stored; no Bearer header is ever sent, and no other
 *     model is substituted when the verification model fails.
 *
 * The response is parsed with the same catalog parser the gateway uses — no
 * model IDs are invented. Results never contain the credential.
 */
export async function probeProvider(
  type: string,
  baseUrl: string,
  apiKey: string,
): Promise<ProviderProbeResult> {
  const info = providerInfo(type);
  if (!info) return probeFailure("Unknown provider type.");

  const base = normalizeBaseUrl(baseUrl);
  if (!base || !isHttpUrl(base)) {
    return probeFailure("The API base URL is not a valid http(s) address.");
  }
  const key = validateProviderKey(type, apiKey);
  if (!key) {
    return probeFailure(`That does not look like a ${info.label} API key (${info.keyHint}).`);
  }

  // --- Google Gemini: dedicated adapter path --------------------------------
  if (type === "google") {
    const started = Date.now();
    // 1. Catalog: proves the key authenticates, and lists real model IDs.
    const catalog = await listGeminiCatalog(base, key);
    if (!catalog.ok) {
      return {
        ok: false,
        models: [],
        error: catalog.error,
        status: catalog.status,
        category: catalog.category,
        verified: false,
        detail: catalog.detail,
        model_used: null,
        latency_ms: Math.max(1, Date.now() - started),
      };
    }
    // 2. A real authenticated generateContent request against the documented
    //    verification model — catalog reads alone cannot prove the key may
    //    generate. The model is never silently replaced when this fails.
    const verification = await verifyGeminiCredential({ baseUrl: base, apiKey: key });
    if (!verification.ok) {
      return {
        ok: false,
        models: catalog.models.map((model) => model.id),
        error: verification.detail ?? "Google rejected the generateContent verification request.",
        status: verification.status,
        category: verification.category,
        verified: false,
        detail: verification.detail,
        model_used: verification.model,
        latency_ms: Math.max(1, Date.now() - started),
      };
    }
    return {
      ok: true,
      models: catalog.models.map((model) => model.id),
      error: null,
      status: verification.status,
      category: null,
      verified: true,
      detail: null,
      model_used: verification.model,
      latency_ms: Math.max(1, Date.now() - started),
    };
  }

  // --- OpenAI-compatible / Anthropic: catalog probe (unchanged behaviour) ---
  let url = base;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (type === "anthropic") {
    const path = basePath(base).replace(/\/v1$/i, "");
    url = `${base.slice(0, base.length - basePath(base).length)}${path}/v1/models`;
    headers["x-api-key"] = key;
    headers["anthropic-version"] = "2023-06-01";
  } else {
    url = `${base}/models`;
    headers.Authorization = `Bearer ${key}`;
  }

  try {
    const response = await fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(10_000), cache: "no-store" });
    const text = await response.text();
    if (!response.ok) {
      const classified = classifyHttpStatus(response.status, key);
      return {
        ok: false,
        models: [],
        status: response.status,
        error: classified.error,
        category: classified.category,
        verified: false,
        detail: text ? parseUpstreamDetail(text) : null,
        model_used: null,
        latency_ms: null,
      };
    }
    if (text.length > 2_000_000) return probeFailure("Provider catalog exceeds the 2 MB safety limit.");
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      return probeFailure("The provider returned an invalid model catalog.");
    }
    const models = parseModelCatalog(payload).map((model) => model.id);
    if (!models.length) return probeFailure("The provider returned no usable model IDs.");
    return { ok: true, models, error: null, status: response.status, category: null, verified: true, detail: null, model_used: null, latency_ms: null };
  } catch (cause) {
    const isTimeout = cause instanceof DOMException && (cause.name === "TimeoutError" || cause.name === "AbortError");
    return {
      ok: false,
      models: [],
      status: null,
      error: isTimeout
        ? "Could not reach the provider: the request timed out."
        : cause instanceof Error
          ? `Could not reach the provider: ${sanitizeProviderDetail(cause.message)}`
          : "Could not reach the provider.",
      category: isTimeout ? "timeout" : cause instanceof TypeError ? "network" : "unknown",
      verified: false,
      detail: null,
      model_used: null,
      latency_ms: null,
    };
  }
}

/** Sanitized first line of a provider's upstream error text (no credentials). */
function parseUpstreamDetail(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } | string; message?: unknown };
    const message = typeof parsed.error === "string" ? parsed.error : typeof parsed.error?.message === "string" ? parsed.error.message : typeof parsed.message === "string" ? parsed.message : "";
    return message ? sanitizeProviderDetail(message) : null;
  } catch {
    return null;
  }
}

/** Google catalog read through the dedicated Gemini auth (X-goog-api-key). */
async function listGeminiCatalog(base: string, key: string): Promise<{ ok: boolean; models: { id: string }[]; status: number | null; category: GeminiErrorCategory | null; error: string | null; detail: string | null }> {
  try {
    const response = await fetch(geminiModelsUrl(base), { headers: geminiHeaders(key), redirect: "error", signal: AbortSignal.timeout(10_000), cache: "no-store" });
    const text = await response.text();
    if (!response.ok) {
      const classified = parseGeminiError(response.status, text, key);
      return { ok: false, models: [], status: response.status, category: classified.category, error: classified.detail, detail: classified.detail };
    }
    if (text.length > 2_000_000) {
      return { ok: false, models: [], status: response.status, category: "unknown", error: "Google's model catalog exceeds the 2 MB safety limit.", detail: null };
    }
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      return { ok: false, models: [], status: response.status, category: "unknown", error: "Google returned an invalid model catalog.", detail: null };
    }
    const models = parseModelCatalog(payload);
    if (!models.length) {
      return { ok: false, models: [], status: response.status, category: "unknown", error: "Google returned no usable model IDs.", detail: null };
    }
    return { ok: true, models, status: response.status, category: null, error: null, detail: null };
  } catch (cause) {
    const classified = geminiErrorFromException(cause, "models", key);
    return { ok: false, models: [], status: null, category: classified.category, error: classified.detail, detail: null };
  }
}

/** RpcError helper used by the storage layer so invalid input is rejected early. */
export function invalidProviderInput(detail: string): RpcError {
  return new RpcError("INVALID_PROVIDER", 400, detail);
}
