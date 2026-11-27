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
import { RpcError } from "@/lib/server/errors";
import {
  normalizeBaseUrl,
  providerInfo,
  type ProviderType,
} from "@/lib/ai/provider-types";

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

export type ProviderProbeResult = {
  ok: boolean;
  /** Model IDs the provider reported for this account (empty when unreachable). */
  models: string[];
  error: string | null;
  status: number | null;
};

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
 * Ask a provider which models this account can use.
 *
 * This is a real request to the provider's catalog endpoint: OpenAI-compatible
 * providers answer `GET {base}/models`, Anthropic `GET {base}/v1/models`,
 * Google `GET {base}/v1beta/models`. The response is parsed with the same
 * catalog parser the gateway uses — no model IDs are invented.
 */
export async function probeProvider(
  type: string,
  baseUrl: string,
  apiKey: string,
): Promise<ProviderProbeResult> {
  const info = providerInfo(type);
  if (!info) return { ok: false, models: [], error: "Unknown provider type.", status: null };

  const base = normalizeBaseUrl(baseUrl);
  if (!base || !isHttpUrl(base)) {
    return { ok: false, models: [], error: "The API base URL is not a valid http(s) address.", status: null };
  }
  const key = validateProviderKey(type, apiKey);
  if (!key) {
    return { ok: false, models: [], error: `That does not look like a ${info.label} API key (${info.keyHint}).`, status: null };
  }

  let url = base;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (type === "anthropic") {
    const path = basePath(base).replace(/\/v1$/i, "");
    url = `${base.slice(0, base.length - basePath(base).length)}${path}/v1/models`;
    headers["x-api-key"] = key;
    headers["anthropic-version"] = "2023-06-01";
  } else if (type === "google") {
    const path = basePath(base).replace(/\/v1beta$/i, "");
    url = `${base.slice(0, base.length - basePath(base).length)}${path}/v1beta/models`;
    headers.Authorization = `Bearer ${key}`;
  } else {
    url = `${base}/models`;
    headers.Authorization = `Bearer ${key}`;
  }

  try {
    const response = await fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(10_000), cache: "no-store" });
    const text = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        models: [],
        status: response.status,
        error:
          response.status === 401 || response.status === 403
            ? "The provider rejected this API key."
            : `The provider answered with status ${response.status}.`,
      };
    }
    if (text.length > 2_000_000) return { ok: false, models: [], error: "Provider catalog exceeds the 2 MB safety limit.", status: response.status };
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      return { ok: false, models: [], error: "The provider returned an invalid model catalog.", status: response.status };
    }
    const models = parseModelCatalog(payload).map((model) => model.id);
    if (!models.length) return { ok: false, models: [], error: "The provider returned no usable model IDs.", status: response.status };
    return { ok: true, models, error: null, status: response.status };
  } catch (cause) {
    return {
      ok: false,
      models: [],
      status: null,
      error: cause instanceof Error ? `Could not reach the provider: ${cause.message}` : "Could not reach the provider.",
    };
  }
}

/** RpcError helper used by the storage layer so invalid input is rejected early. */
export function invalidProviderInput(detail: string): RpcError {
  return new RpcError("INVALID_PROVIDER", 400, detail);
}
