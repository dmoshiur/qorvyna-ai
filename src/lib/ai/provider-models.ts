// =============================================================================
// Admin-managed models for connected provider accounts.
//
// Each connected provider account (see ./accounts.ts) can carry a list of
// models the administrator wants to expose for it: the exact provider model ID,
// a friendly label and the context window when the provider reports one.
//
// Model IDs are never invented or normalized: they are stored exactly as
// entered and validated only for shape (bounded length, no control
// characters). Whether a model is actually offered to the account is verified
// against the provider's live catalog when the administrator tests the
// account (see ./providers.ts `probeProvider`).
// =============================================================================

import "server-only";
import type { Db } from "@/lib/firebase/admin";
import { nowTs } from "@/lib/firebase/admin";
import { RpcError } from "@/lib/server/errors";
import { providerInfo, type ProviderType } from "@/lib/ai/providers";

export const PROVIDER_MODELS_COLLECTION = "provider_models";

export type StoredProviderModel = {
  model_id: string;
  label: string;
  /** The provider account this model belongs to (account hash id). */
  account_id: string;
  provider: ProviderType;
  provider_label: string;
  context_tokens: number | null;
  enabled: boolean;
  created_at: string | null;
};

const MODEL_ID_MAX = 220;

/** Accept a model ID: bounded length, no whitespace or control characters. */
export function normalizeModelId(value: unknown): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id || id.length > MODEL_ID_MAX || /[\s\x00-\x1f]/.test(id)) return "";
  return id;
}

function normalizeContextTokens(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 10_000_000) return null;
  return parsed;
}

function toStored(doc: { id: string; data: () => Record<string, unknown> | undefined }) {
  const data = doc.data() as Record<string, unknown> | undefined;
  const provider = providerInfo(String(data?.provider ?? ""))?.type ?? "groq";
  return {
    model_id: String(data?.model_id ?? ""),
    label: String(data?.label ?? ""),
    account_id: String(data?.account_id ?? ""),
    provider,
    provider_label: providerInfo(provider)?.label ?? provider,
    context_tokens: normalizeContextTokens(data?.context_tokens),
    enabled: data?.enabled !== false,
    created_at: (data?.created_at as { toDate?: () => Date } | undefined)?.toDate?.().toISOString() ?? null,
  } satisfies StoredProviderModel;
}

/** Every admin-added model across all provider accounts. */
export async function listProviderModels(d: Db): Promise<StoredProviderModel[]> {
  const snap = await d.collection(PROVIDER_MODELS_COLLECTION).get();
  return snap.docs.map(toStored).sort((a, b) => (a.label || a.model_id).localeCompare(b.label || b.model_id));
}

/** Models attached to one provider account (identified by its account hash id). */
export async function listModelsForAccount(d: Db, accountId: string): Promise<StoredProviderModel[]> {
  const snap = await d.collection(PROVIDER_MODELS_COLLECTION).where("account_id", "==", accountId).get();
  return snap.docs.map(toStored);
}

/** Add a model to a connected provider account. */
export async function addProviderModel(
  d: Db,
  input: { accountId: string; modelId: string; label?: string; contextTokens?: number | null; provider?: string; addedBy?: string },
): Promise<{ model_id: string }> {
  const provider = providerInfo(input.provider ?? "groq");
  if (!provider) throw new RpcError("INVALID_PROVIDER", 400, "That provider type is not supported.");
  const accountId = typeof input.accountId === "string" ? input.accountId.trim() : "";
  const modelId = normalizeModelId(input.modelId);
  if (!accountId) throw new RpcError("INVALID_PROVIDER_MODEL", 400, "Choose the provider account this model belongs to.");
  if (!modelId) throw new RpcError("INVALID_PROVIDER_MODEL", 400, "The model ID must be between 1 and 220 characters with no spaces.");
  const existing = await listProviderModels(d);
  if (existing.some((model) => model.account_id === accountId && model.model_id === modelId)) {
    throw new RpcError("PROVIDER_MODEL_EXISTS", 409, "This model is already added to that provider account.");
  }
  const ref = await d.collection(PROVIDER_MODELS_COLLECTION).add({
    provider: provider.type,
    account_id: accountId,
    model_id: modelId,
    label: (typeof input.label === "string" ? input.label.trim() : "").slice(0, 80) || modelId,
    context_tokens: normalizeContextTokens(input.contextTokens),
    enabled: true,
    added_by: input.addedBy ?? "",
    created_at: nowTs(),
    updated_at: nowTs(),
  });
  return { model_id: ref.id };
}

export async function updateProviderModel(d: Db, modelRefId: string, patch: { label?: string; enabled?: boolean }): Promise<void> {
  const ref = d.collection(PROVIDER_MODELS_COLLECTION).doc(modelRefId);
  const snap = await ref.get();
  if (!snap.exists) throw new RpcError("NOT_FOUND", 404);
  await ref.set({
    ...(typeof patch.label === "string" ? { label: patch.label.trim().slice(0, 80) } : {}),
    ...(typeof patch.enabled === "boolean" ? { enabled: patch.enabled } : {}),
    updated_at: nowTs(),
  }, { merge: true });
}

export async function removeProviderModel(d: Db, modelRefId: string): Promise<void> {
  const ref = d.collection(PROVIDER_MODELS_COLLECTION).doc(modelRefId);
  const snap = await ref.get();
  if (!snap.exists) throw new RpcError("NOT_FOUND", 404);
  await ref.delete();
}
