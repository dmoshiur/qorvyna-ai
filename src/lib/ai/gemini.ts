// =============================================================================
// Google Gemini provider adapter (Generative Language API).
//
// Root cause this adapter fixes: the shared admin probe used to send the
// Gemini API key as `Authorization: Bearer <key>` — a header Google reserves
// for OAuth 2.0 tokens. Google answers an API key in that header with
// 401 UNAUTHENTICATED, which the admin console reported as
// "The provider rejected this API key." for perfectly valid keys.
//
// How Google Gemini actually authenticates an API key:
//   • the key travels ONLY in the `X-goog-api-key` header, byte-for-byte as
//     stored — never modified, truncated, re-encoded or placed in the URL;
//   • no `Authorization`/Bearer header is sent alongside it;
//   • requests go to `{base}/v1beta/models/{model}:generateContent`
//     (`:streamGenerateContent?alt=sse` for streaming);
//   • valid keys come in two formats: legacy `AIza…` (39 chars) and the newer
//     `AQ.…` auth key. Both are accepted; the key's prefix is never rewritten.
//
// Failures are classified with Google's real status/error body (sanitized —
// never a key, an authorization header or an encrypted credential) and the
// adapter NEVER silently substitutes another model when one fails.
// =============================================================================

import "server-only";
import type {
  AIProvider,
  AIProviderRequest,
  AIProviderResponse,
  AIProviderToolCall,
} from "@/lib/ai/groq";
import { AIProviderError, providerErrorFromException, providerErrorFromResponse, sanitizeProviderDetail } from "@/lib/ai/provider-error";
import { parseModelCatalog, type CatalogModel } from "@/lib/ai/model-catalog";
import { cachedRealHealthCheck, healthCacheKey } from "@/lib/ai/provider-health";

export const GEMINI_DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";
export const GEMINI_API_VERSION = "v1beta";
/** The model the admin verification request uses (a real, currently-served alias). */
export const GEMINI_VERIFICATION_MODEL = "gemini-flash-latest";
/** The exact documented verification prompt (mirrors Google's own quickstart request). */
export const GEMINI_VERIFICATION_PROMPT = "Explain how AI works in a few words";

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 2_000_000;

/** Failure categories the admin console surfaces verbatim. */
export type GeminiErrorCategory =
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

/**
 * Normalize a Gemini base URL: trim, strip trailing slashes and any explicit
 * `/v1` or `/v1beta` path suffix so versioned paths can never double up.
 */
export function normalizeGeminiBaseUrl(value: string): string {
  return value
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/v1(?:beta)?$/i, "");
}

/**
 * The model id as it appears in a URL path: a `models/…` prefix is stripped,
 * everything else is validated so a model id can never change the shape of
 * the URL. Returns "" when the id is not a safe path segment.
 */
export function geminiModelId(value: string): string {
  const id = value.trim().replace(/^models\//i, "");
  return id && /^[A-Za-z0-9._-]{1,120}$/.test(id) && !/^[.-]/.test(id) ? id : "";
}

/** `POST {base}/v1beta/models/{model}:generateContent` — "" for an unsafe model id. */
export function geminiGenerateContentUrl(baseUrl: string, model: string): string {
  const id = geminiModelId(model);
  if (!id) return "";
  const base = normalizeGeminiBaseUrl(baseUrl) || GEMINI_DEFAULT_BASE_URL;
  return `${base}/${GEMINI_API_VERSION}/models/${id}:generateContent`;
}

/** `POST {base}/v1beta/models/{model}:streamGenerateContent?alt=sse` ("" for an unsafe model id). */
export function geminiStreamGenerateUrl(baseUrl: string, model: string): string {
  const generate = geminiGenerateContentUrl(baseUrl, model);
  return generate ? `${generate.replace(/:generateContent$/, ":streamGenerateContent")}?alt=sse` : "";
}

/** `GET {base}/v1beta/models` — the live model catalog for this credential. */
export function geminiModelsUrl(baseUrl: string): string {
  const base = normalizeGeminiBaseUrl(baseUrl) || GEMINI_DEFAULT_BASE_URL;
  return `${base}/${GEMINI_API_VERSION}/models?pageSize=200`;
}

/**
 * Authentication headers for every Gemini request. The key goes ONLY in
 * `X-goog-api-key`, exactly as stored — never a Bearer header, never a query
 * parameter, so the credential can never leak into URLs or logs.
 */
export function geminiHeaders(apiKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-goog-api-key": apiKey,
  };
}

/** The documented verification request body (contents → parts → text). */
export function buildGeminiVerificationBody(text = GEMINI_VERIFICATION_PROMPT, maxOutputTokens = 32): Record<string, unknown> {
  return {
    contents: [{ parts: [{ text }] }],
    ...(maxOutputTokens > 0 ? { generationConfig: { maxOutputTokens, temperature: 0 } } : {}),
  };
}

/** Remove any occurrence of the credential itself from a diagnostic string. */
export function redactKey(detail: string, apiKey: string): string {
  const key = apiKey.trim();
  if (!key) return detail;
  return detail.split(key).join("[redacted]");
}

/** HTTP status → failure category (see the admin console's error taxonomy). */
export function classifyGeminiStatus(status: number): GeminiErrorCategory {
  if (status === 400) return "invalid_request";
  if (status === 401) return "authentication";
  if (status === 403) return "permission";
  if (status === 404) return "model_not_found";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "provider_unavailable";
  return "unknown";
}

const GOOGLE_STATUS_CATEGORY: Record<string, GeminiErrorCategory> = {
  INVALID_ARGUMENT: "invalid_request",
  FAILED_PRECONDITION: "permission",
  UNAUTHENTICATED: "authentication",
  PERMISSION_DENIED: "permission",
  NOT_FOUND: "model_not_found",
  // Google reports both rate limiting and quota exhaustion as 429
  // RESOURCE_EXHAUSTED — one category, explained by the upstream message.
  RESOURCE_EXHAUSTED: "rate_limit",
  INTERNAL: "provider_unavailable",
  UNAVAILABLE: "provider_unavailable",
  BACKEND_ERROR: "provider_unavailable",
  CANCELLED: "unknown",
  ABORTED: "unknown",
};

const STATUS_MESSAGE: Record<number, string> = {
  400: "Invalid request — the model or request body was rejected (HTTP 400).",
  401: "Authentication failed — Google rejected this API key (HTTP 401).",
  403: "Access denied — the key may be restricted, lack this API's permission, or be blocked for this project (HTTP 403).",
  404: "Not found — this model or endpoint does not exist for this key (HTTP 404).",
  429: "Rate limit or quota exceeded on this key (HTTP 429).",
};

type GoogleErrorBody = { error?: { code?: unknown; message?: unknown; status?: unknown; details?: unknown } };

/**
 * Turn Google's structured error response into a sanitized, useful explanation.
 * Captures `error.message` / `error.status` where available; the credential is
 * redacted from anything Google echoed back, and no header or key is ever included.
 */
export function parseGeminiError(status: number, body: string, apiKey = ""): { category: GeminiErrorCategory; detail: string; code: string | null } {
  let category = classifyGeminiStatus(status);
  let message = STATUS_MESSAGE[status] ?? `Google answered with status ${status}.`;
  let code: string | null = null;
  try {
    const parsed = JSON.parse(body) as GoogleErrorBody;
    const error = parsed?.error;
    if (error && typeof error === "object") {
      const upstream = typeof error.message === "string" && error.message.trim() ? error.message.trim() : "";
      const googleStatus = typeof error.status === "string" && error.status ? error.status.toUpperCase() : "";
      code = googleStatus || (typeof error.code === "number" ? String(error.code) : null);
      if (googleStatus && GOOGLE_STATUS_CATEGORY[googleStatus]) {
        // Google's own status string is more precise than the HTTP code alone
        // (e.g. 429 RESOURCE_EXHAUSTED, 403 FAILED_PRECONDITION billing blocks).
        category = GOOGLE_STATUS_CATEGORY[googleStatus];
      }
      if (upstream) message = `${message} Google says: ${upstream}`;
    }
  } catch {
    // Non-JSON error body: keep the classified message, sanitized below.
  }
  return {
    category,
    detail: sanitizeProviderDetail(redactKey(message, apiKey)),
    code,
  };
}

/** An exception (timeout / abort / network) → the same sanitized category shape. */
export function geminiErrorFromException(error: unknown, model: string, apiKey = ""): { category: GeminiErrorCategory; detail: string; status: null } {
  const isTimeout = error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError");
  const category: GeminiErrorCategory = isTimeout ? "timeout" : error instanceof TypeError ? "network" : "unknown";
  const raw = error instanceof Error ? error.message : "Google request failed";
  const detail = isTimeout
    ? "The request to Google timed out before an answer arrived."
    : category === "network"
      ? `Could not reach Google: ${raw}`
      : sanitizeProviderDetail(raw);
  return { category, detail: sanitizeProviderDetail(redactKey(detail, apiKey)), status: null };
}

export type GeminiVerifyResult = {
  /** Google accepted the authenticated request and returned a usable answer. */
  ok: boolean;
  verified: boolean;
  status: number | null;
  category: GeminiErrorCategory | null;
  detail: string | null;
  model: string;
  latency_ms: number | null;
};

type GenerateContentPayload = {
  candidates?: { content?: { parts?: { text?: unknown }[] }; finishReason?: unknown }[];
  promptFeedback?: { blockReason?: unknown };
  error?: { code?: unknown; message?: unknown; status?: unknown };
  usageMetadata?: { promptTokenCount?: unknown; candidatesTokenCount?: unknown; totalTokenCount?: unknown };
};

/** Text of the first candidate, or "" when the response carried none. */
export function parseGenerateContentText(payload: GenerateContentPayload): string {
  const parts = payload.candidates?.[0]?.content?.parts ?? [];
  const text = parts
    .map((part) => (part && typeof part.text === "string" ? part.text : ""))
    .join("")
    .trim();
  return text;
}

/**
 * Verify a Gemini credential with a REAL authenticated request:
 * `POST {base}/v1beta/models/{model}:generateContent` with the key in
 * `X-goog-api-key`. This is the same request shape Google documents; only the
 * model differs (default: `gemini-flash-latest`). No other model is ever
 * substituted when this one fails.
 */
export async function verifyGeminiCredential(input: {
  baseUrl?: string;
  apiKey: string;
  model?: string;
  signal?: AbortSignal;
}): Promise<GeminiVerifyResult> {
  // No model is ever silently substituted: an explicitly given but invalid
  // model id fails the verification instead of being replaced.
  const requested = input.model;
  const model = requested === undefined ? GEMINI_VERIFICATION_MODEL : geminiModelId(requested);
  if (!model) {
    return { ok: false, verified: false, status: null, category: "invalid_request", detail: `Invalid Gemini model identifier: ${sanitizeProviderDetail(requested ?? "")}`, model: requested ?? "", latency_ms: null };
  }
  const url = geminiGenerateContentUrl(input.baseUrl ?? GEMINI_DEFAULT_BASE_URL, model);
  const started = Date.now();
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      redirect: "error",
      headers: geminiHeaders(input.apiKey),
      body: JSON.stringify(buildGeminiVerificationBody()),
      signal: input.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (error) {
    const classified = geminiErrorFromException(error, model, input.apiKey);
    return { ok: false, verified: false, status: null, category: classified.category, detail: classified.detail, model, latency_ms: Math.max(1, Date.now() - started) };
  }

  const latency_ms = Math.max(1, Date.now() - started);
  const bodyText = (await response.text().catch(() => "")).slice(0, MAX_RESPONSE_BYTES);

  if (!response.ok) {
    const classified = parseGeminiError(response.status, bodyText, input.apiKey);
    return { ok: false, verified: false, status: response.status, category: classified.category, detail: classified.detail, model, latency_ms };
  }

  let payload: GenerateContentPayload;
  try {
    payload = JSON.parse(bodyText) as GenerateContentPayload;
  } catch {
    return { ok: false, verified: false, status: response.status, category: "unknown", detail: "Google returned a response that could not be parsed.", model, latency_ms };
  }
  if (payload.error) {
    // 200 with an embedded error object (defensive; Google normally errors via status).
    const status = typeof payload.error.code === "number" ? payload.error.code : 500;
    const classified = parseGeminiError(status, bodyText, input.apiKey);
    return { ok: false, verified: false, status: response.status, category: classified.category, detail: classified.detail, model, latency_ms };
  }
  const text = parseGenerateContentText(payload);
  if (!text) {
    const blocked = typeof payload.promptFeedback?.blockReason === "string" ? payload.promptFeedback.blockReason : "";
    return {
      ok: false,
      verified: false,
      status: response.status,
      category: "invalid_request",
      detail: blocked ? `Google accepted the credential but returned no content (blocked: ${blocked}).` : "Google accepted the credential but returned no content.",
      model,
      latency_ms,
    };
  }
  return {
    ok: true,
    verified: true,
    status: response.status,
    category: null,
    detail: null,
    model,
    latency_ms,
  };
}

export type GeminiListResult = {
  ok: boolean;
  models: CatalogModel[];
  status: number | null;
  category: GeminiErrorCategory | null;
  error: string | null;
};

/**
 * The credential's live model catalog: `GET {base}/v1beta/models` with the key
 * in `X-goog-api-key`. Model IDs come only from Google's response — none are
 * invented (`models/…` names are normalized by the shared catalog parser).
 */
export async function listGeminiModels(input: { baseUrl?: string; apiKey: string; signal?: AbortSignal }): Promise<GeminiListResult> {
  const url = geminiModelsUrl(input.baseUrl ?? GEMINI_DEFAULT_BASE_URL);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      redirect: "error",
      headers: geminiHeaders(input.apiKey),
      signal: input.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (error) {
    const classified = geminiErrorFromException(error, "models", input.apiKey);
    return { ok: false, models: [], status: null, category: classified.category, error: classified.detail };
  }
  const bodyText = (await response.text().catch(() => "")).slice(0, MAX_RESPONSE_BYTES);
  if (!response.ok) {
    const classified = parseGeminiError(response.status, bodyText, input.apiKey);
    return { ok: false, models: [], status: response.status, category: classified.category, error: classified.detail };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    return { ok: false, models: [], status: response.status, category: "unknown", error: "Google returned an invalid model catalog." };
  }
  const models = parseModelCatalog(payload);
  if (!models.length) {
    return { ok: false, models: [], status: response.status, category: "unknown", error: "Google returned no usable model IDs." };
  }
  return { ok: true, models, status: response.status, category: null, error: null };
}

function usageOf(payload: GenerateContentPayload): AIProviderResponse["usage"] {
  const usage = payload.usageMetadata;
  const promptTokens = Number(usage?.promptTokenCount ?? 0) || 0;
  const completionTokens = Number(usage?.candidatesTokenCount ?? 0) || 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: Number(usage?.totalTokenCount ?? promptTokens + completionTokens) || promptTokens + completionTokens,
  };
}

/**
 * OpenAI-style messages → Gemini `contents`. System messages become the
 * `systemInstruction`; roles map user→user, assistant→model. No tool calls are
 * translated (`supportsToolCalls` is false, so callers never send any).
 */
type GeminiContent = { role: "user" | "model"; parts: ({ text: string } | { inlineData: { mimeType: string; data: string } })[] };

function buildContents(req: AIProviderRequest): { systemInstruction?: { parts: { text: string }[] }; contents: GeminiContent[] } {
  const system = req.messages.filter((message) => message.role === "system").map((message) => message.content);
  const contents: GeminiContent[] = req.messages
    .filter((message) => message.role !== "system")
    .map((message) => ({ role: (message.role === "assistant" ? "model" : "user") as "user" | "model", parts: [{ text: message.content }] }));
  if (req.imageDataUrl) {
    const match = /^data:([^;,]+);base64,(.+)$/s.exec(req.imageDataUrl.trim());
    if (match) {
      const last = contents.at(-1);
      if (last) last.parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
    }
  }
  return { ...(system.length ? { systemInstruction: { parts: [{ text: system.join("\n\n") }] } } : {}), contents };
}

function buildGenerationConfig(req: AIProviderRequest): Record<string, unknown> {
  return {
    temperature: req.temperature ?? 0.5,
    ...(req.maxTokens ? { maxOutputTokens: req.maxTokens } : {}),
    ...(req.jsonMode ? { responseMimeType: "application/json" } : {}),
  };
}

/**
 * The Gemini provider. Implements the same AIProvider interface as the Groq,
 * OpenAI-compatible and Cloudflare adapters, so it can serve requests through
 * the existing execution paths without a parallel provider system.
 */
export class GeminiProvider implements AIProvider {
  /** Gemini function-calling is not translated here; tools are never sent. */
  readonly supportsToolCalls = false;
  private readonly baseUrl: string;

  constructor(
    private readonly apiKey: string,
    baseUrl?: string,
  ) {
    this.baseUrl = normalizeGeminiBaseUrl(baseUrl ?? "") || GEMINI_DEFAULT_BASE_URL;
  }

  async listModels(): Promise<CatalogModel[]> {
    const result = await listGeminiModels({ baseUrl: this.baseUrl, apiKey: this.apiKey });
    if (!result.ok) {
      throw new AIProviderError({ provider: "Google", model: "catalog", status: result.status, type: result.category === "timeout" ? "timeout" : result.category === "network" ? "network" : result.category === "rate_limit" || result.category === "quota" ? "rate_limit" : result.category === "authentication" || result.category === "permission" ? "authentication" : "provider_unavailable", detail: result.error ?? "Google model catalog could not be read" });
    }
    return result.models;
  }

  /** Model availability check against Google's own catalog — never a guess. */
  async verifyModel(model: string): Promise<void> {
    const result = await listGeminiModels({ baseUrl: this.baseUrl, apiKey: this.apiKey });
    if (!result.ok) {
      throw new AIProviderError({ provider: "Google", model, status: result.status, type: "provider_unavailable", detail: result.error ?? "Google model catalog could not be read" });
    }
    if (!result.models.some((item) => item.id === geminiModelId(model))) {
      throw new AIProviderError({
        provider: "Google",
        model,
        status: 404,
        type: "invalid_request",
        modelUnavailable: true,
        detail: `Model ${model} is not present in this Google account's catalog. Choose a listed model; QORVYNA will not guess a replacement.`,
      });
    }
  }

  /** Honest one-token generateContent probe (GET /models cannot prove auth). */
  async healthCheck(model?: string): Promise<boolean> {
    const target = geminiModelId(model ?? "") || GEMINI_VERIFICATION_MODEL;
    const probe = async () => {
      try {
        const response = await fetch(geminiGenerateContentUrl(this.baseUrl, target), {
          method: "POST",
          redirect: "error",
          headers: geminiHeaders(this.apiKey),
          body: JSON.stringify(buildGeminiVerificationBody("ping", 1)),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (response.ok) return { ok: true, status: response.status, detail: "ok" };
        return { ok: false, status: response.status, detail: (await response.text().catch(() => "")).slice(0, 400) };
      } catch (error) {
        return { ok: false, status: null, detail: error instanceof Error ? error.message : "network error" };
      }
    };
    const result = await cachedRealHealthCheck(healthCacheKey(["google", this.baseUrl, target, this.apiKey.slice(-4)]), probe);
    if (!result.ok && result.status) {
      console.error("[QORVYNA] AI provider health check failed", {
        provider: "Google",
        baseUrl: this.baseUrl,
        model: target,
        httpStatus: result.status,
        detail: redactKey(sanitizeProviderDetail(result.detail), this.apiKey),
      });
    }
    return result.ok;
  }

  async chat(req: AIProviderRequest): Promise<AIProviderResponse> {
    const model = geminiModelId(req.model);
    if (!model) throw new AIProviderError({ provider: "Google", model: req.model, type: "invalid_request", detail: `Invalid Gemini model identifier: ${sanitizeProviderDetail(req.model)}` });
    const { systemInstruction, contents } = buildContents(req);
    const body: Record<string, unknown> = {
      contents,
      generationConfig: buildGenerationConfig(req),
      ...(systemInstruction ? { systemInstruction } : {}),
    };
    let response: Response;
    try {
      response = await fetch(geminiGenerateContentUrl(this.baseUrl, model), {
        method: "POST",
        redirect: "error",
        headers: geminiHeaders(this.apiKey),
        body: JSON.stringify(body),
        signal: req.signal ?? AbortSignal.timeout(60_000),
      });
    } catch (error) {
      throw providerErrorFromException("Google", model, error, req.requestId);
    }
    if (!response.ok) {
      throw providerErrorFromResponse("Google", model, response, await response.text().catch(() => ""), req.requestId);
    }
    let payload: GenerateContentPayload;
    try {
      payload = (await response.json()) as GenerateContentPayload;
    } catch (error) {
      throw providerErrorFromException("Google", model, error, req.requestId);
    }
    const content = parseGenerateContentText(payload);
    return {
      content,
      model,
      finishReason: typeof payload.candidates?.[0]?.finishReason === "string" ? payload.candidates[0].finishReason : undefined,
      toolCalls: [],
      usage: usageOf(payload),
    };
  }

  /** Streaming via `:streamGenerateContent?alt=sse`. */
  async *streamChat(req: AIProviderRequest): AsyncGenerator<string> {
    const model = geminiModelId(req.model);
    if (!model) throw new AIProviderError({ provider: "Google", model: req.model, type: "invalid_request", detail: `Invalid Gemini model identifier: ${sanitizeProviderDetail(req.model)}` });
    const { systemInstruction, contents } = buildContents(req);
    const body: Record<string, unknown> = {
      contents,
      generationConfig: buildGenerationConfig(req),
      ...(systemInstruction ? { systemInstruction } : {}),
    };
    let response: Response;
    try {
      response = await fetch(geminiStreamGenerateUrl(this.baseUrl, model), {
        method: "POST",
        redirect: "error",
        headers: geminiHeaders(this.apiKey),
        body: JSON.stringify(body),
        signal: req.signal ?? AbortSignal.timeout(120_000),
      });
      if (!response.ok || !response.body) {
        throw providerErrorFromResponse("Google", model, response, await response.text().catch(() => ""), req.requestId);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const payloadText = trimmed.slice(5).trim();
          if (!payloadText || payloadText === "[DONE]") continue;
          try {
            const payload = JSON.parse(payloadText) as GenerateContentPayload & { error?: { message?: string } };
            if (payload.error) {
              throw new AIProviderError({ provider: "Google", model, type: "provider_unavailable", detail: payload.error.message ?? "Google stream error", requestId: req.requestId });
            }
            const delta = parseGenerateContentText(payload);
            if (delta) yield delta;
          } catch (error) {
            if (error instanceof SyntaxError) continue;
            throw error;
          }
        }
      }
    } catch (error) {
      if (error instanceof AIProviderError) throw error;
      throw providerErrorFromException("Google", model, error, req.requestId);
    }
  }
}

/** Build the provider from a stored/admin configuration record. */
export function createGeminiProvider(settings: { apiKey: string; baseUrl?: string }): GeminiProvider {
  return new GeminiProvider(settings.apiKey, settings.baseUrl);
}

export type { AIProviderToolCall };
