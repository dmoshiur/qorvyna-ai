// =============================================================================
// Provider definitions for the admin "Provider accounts" system (browser-safe).
//
// This module holds only static provider metadata — labels, default base URLs
// and key-shape hints — so the admin UI can render its provider selector
// without importing anything server-only. Validation and the live catalog
// probe live in the server-only sibling `@/lib/ai/providers`.
// =============================================================================

/** The provider families the admin panel can connect. */
export type ProviderType = "groq" | "openai" | "anthropic" | "google" | "openai_compatible";

export const PROVIDER_TYPES: readonly ProviderType[] = ["groq", "openai", "anthropic", "google", "openai_compatible"];

export type ProviderInfo = {
  type: ProviderType;
  label: string;
  description: string;
  defaultBaseUrl: string;
  /** How the API key is validated. */
  keyPattern: RegExp;
  keyHint: string;
  /** Whether the base URL must be supplied explicitly. */
  baseUrlRequired: boolean;
};

/** The supported providers, in the order the admin selector shows them. */
export const PROVIDERS: Record<ProviderType, ProviderInfo> = {
  groq: {
    type: "groq",
    label: "Groq",
    description: "Groq Cloud — multiple keys rotate through shared organization rate limits.",
    defaultBaseUrl: "https://api.groq.com/openai/v1",
    keyPattern: /^gsk_[A-Za-z0-9_-]{20,}$/,
    keyHint: "Starts with gsk_",
    baseUrlRequired: false,
  },
  openai: {
    type: "openai",
    label: "OpenAI (ChatGPT)",
    description: "OpenAI API — GPT / ChatGPT models through api.openai.com.",
    defaultBaseUrl: "https://api.openai.com/v1",
    keyPattern: /^sk-(?:proj-)?[A-Za-z0-9_-]{20,}$/,
    keyHint: "Starts with sk- (or sk-proj-)",
    baseUrlRequired: false,
  },
  anthropic: {
    type: "anthropic",
    label: "Anthropic (Claude)",
    description: "Anthropic API — Claude models through api.anthropic.com.",
    defaultBaseUrl: "https://api.anthropic.com",
    keyPattern: /^sk-ant-[A-Za-z0-9_-]{20,}$/,
    keyHint: "Starts with sk-ant-",
    baseUrlRequired: false,
  },
  google: {
    type: "google",
    label: "Google (Gemini)",
    description: "Google Generative Language API — Gemini models.",
    defaultBaseUrl: "https://generativelanguage.googleapis.com",
    // Google has two live Gemini API key formats and BOTH are valid:
    //   • legacy "Standard key": AIza + 35 key characters (39 total)
    //   • new "Auth key":        AQ. + key characters (length varies; new
    //     AI Studio keys default to it). A key must never be rejected because
    //     of its prefix — validation is a shape check only, and the key is
    //     stored and sent byte-for-byte exactly as entered.
    keyPattern: /^(?:AIza[0-9A-Za-z_-]{35}|AQ\.[A-Za-z0-9_.-]{30,120})$/,
    keyHint: "Starts with AIza (legacy) or AQ. (new Gemini auth key)",
    baseUrlRequired: false,
  },
  openai_compatible: {
    type: "openai_compatible",
    label: "Custom OpenAI-compatible",
    description: "Any OpenAI-compatible endpoint (OpenRouter, LM Studio, vLLM, a self-hosted server…).",
    defaultBaseUrl: "https://api.openai.com/v1",
    keyPattern: /^[A-Za-z0-9_\-.]{20,}$/,
    keyHint: "At least 20 characters, no spaces",
    baseUrlRequired: true,
  },
};

export function providerInfo(type: string): ProviderInfo | null {
  return PROVIDERS[type as ProviderType] ?? null;
}

export function isProviderType(value: unknown): value is ProviderType {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(PROVIDERS, value);
}

/** Normalize a provider base URL: strip trailing slashes. */
export function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

/** Last four characters of a key — the only form ever shown after storage. */
export function keyHint(key: string): string {
  return `…${key.slice(-4)}`;
}
