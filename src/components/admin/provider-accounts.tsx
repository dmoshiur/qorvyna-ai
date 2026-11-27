"use client";

// Admin → AI configuration → Provider accounts.
//
// Two connected systems live here:
//
//   1. Provider accounts — several credentials per provider. Multiple Groq
//      keys rotate through shared organization rate limits (their windows are
//      reported live below). OpenAI, Anthropic (Claude), Google (Gemini) and
//      any OpenAI-compatible endpoint can also be connected; their keys are
//      encrypted before storage and are only verified with a live catalog
//      request when the admin tests them.
//
//   2. Models — the model IDs the administrator wants to expose for a given
//      provider account. Model IDs are stored exactly as entered; the test
//      action reports the provider's real catalog.
//
// The panel never shows a full key after it is saved.

import { useCallback, useEffect, useMemo, useState } from "react";
import { rpc } from "@/lib/client/api";
import { errorCodeOf } from "@/lib/admin-errors";
import { Alert, Badge, Button, Card, Field, Input, Select, Spinner } from "@/components/ui";
import { TimeOfDayText } from "@/components/local-time";
import { cn } from "@/lib/utils";
import { PROVIDERS, type ProviderType } from "@/lib/ai/provider-types";

type ModelWindow = { model: string; limit_requests: number | null; remaining_requests: number | null; limit_tokens: number | null; remaining_tokens: number | null; cooldown_until: string | null; observed_at: string | null };
type Account = {
  id: string; label: string; provider: ProviderType; provider_label: string; base_url: string;
  source: "env" | "admin"; key_hint: string; enabled: boolean;
  state: "ready" | "rate_limited" | "paused" | "invalid" | "disabled";
  available_at: string | null; last_error: string | null; last_error_at: string | null; last_ok_at: string | null;
  requests_last_minute: number; tokens_last_minute: number; requests_total: number; rotations_away: number; models: ModelWindow[];
};
type Stored = {
  doc_id: string; id: string; label: string; provider: ProviderType; provider_label: string; base_url: string; enabled: boolean; key_hint: string; created_at: string | null; readable: boolean;
  last_test_at: string | null; last_test_ok: boolean | null; last_test_status: number | null; last_test_category: string | null;
  last_test_detail: string | null; last_test_model: string | null; last_test_latency_ms: number | null; last_ok_at: string | null;
};
type StoredModel = { model_id: string; label: string; account_id: string; provider: ProviderType; provider_label: string; context_tokens: number | null; enabled: boolean; created_at: string | null };
type ProbeResult = {
  ok: boolean; models: string[]; error: string | null; status: number | null;
  category: string | null; verified: boolean; detail: string | null; model_used: string | null; latency_ms: number | null; checked_at?: string;
};
type Payload = { accounts: Account[]; stored: Stored[]; models: Record<string, StoredModel[]>; can_store: boolean };

const STATE_COPY: Record<Account["state"], { label: string; tone: string }> = {
  ready: { label: "Ready", tone: "border-success/30 bg-success-soft text-success" },
  rate_limited: { label: "At provider limit", tone: "border-warning/30 bg-warning-soft text-warning" },
  paused: { label: "Resting after errors", tone: "border-warning/30 bg-warning-soft text-warning" },
  invalid: { label: "Key rejected", tone: "border-danger/40 bg-danger-soft text-danger" },
  disabled: { label: "Disabled", tone: "border-border bg-surface-2 text-ink-3" },
};

/**
 * Configured ≠ Verified ≠ Available.
 *   Configured  credentials are saved (encrypted) — proves nothing about auth.
 *   Verified    the provider accepted a real authenticated request.
 *   Available   runtime rotation currently considers the account usable.
 * The verification badge comes from the last real test; "Ready" (runtime) is
 * never shown as proof that a key works.
 */
const CATEGORY_LABEL: Record<string, { label: string; tone: string }> = {
  authentication: { label: "Rejected", tone: "border-danger/40 bg-danger-soft text-danger" },
  permission: { label: "Permission denied", tone: "border-danger/40 bg-danger-soft text-danger" },
  model_not_found: { label: "Model not found", tone: "border-danger/40 bg-danger-soft text-danger" },
  invalid_request: { label: "Invalid request", tone: "border-danger/40 bg-danger-soft text-danger" },
  rate_limit: { label: "Rate limited", tone: "border-warning/30 bg-warning-soft text-warning" },
  quota: { label: "Quota exceeded", tone: "border-warning/30 bg-warning-soft text-warning" },
  provider_unavailable: { label: "Unavailable", tone: "border-warning/30 bg-warning-soft text-warning" },
  timeout: { label: "Timed out", tone: "border-warning/30 bg-warning-soft text-warning" },
  network: { label: "Unreachable", tone: "border-warning/30 bg-warning-soft text-warning" },
  unknown: { label: "Test failed", tone: "border-danger/40 bg-danger-soft text-danger" },
};

function verificationBadge(stored: Stored | undefined): { label: string; tone: string } | null {
  if (!stored) return null;
  if (stored.last_test_at === null || stored.last_test_ok === null) return { label: "Not verified", tone: "border-border bg-surface-2 text-ink-3" };
  if (stored.last_test_ok) return { label: "Verified", tone: "border-success/30 bg-success-soft text-success" };
  return CATEGORY_LABEL[stored.last_test_category ?? "unknown"] ?? CATEGORY_LABEL.unknown;
}

const PROVIDER_TONE: Record<string, string> = {
  groq: "border-sky-500/30 bg-sky-500/10 text-sky-700",
  openai: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700",
  anthropic: "border-orange-500/30 bg-orange-500/10 text-orange-700",
  google: "border-violet-500/30 bg-violet-500/10 text-violet-700",
  openai_compatible: "border-indigo-500/30 bg-indigo-500/10 text-indigo-700",
};

const ERRORS: Record<string, string> = {
  PERMISSION_DENIED: "Your role does not include the system.settings permission.",
  INVALID_API_KEY: "That does not look like a valid API key for the selected provider.",
  INVALID_PROVIDER: "That provider type is not supported.",
  INVALID_PROVIDER_BASE_URL: "The API base URL must be a valid http(s) address.",
  INVALID_PROVIDER_MODEL: "The model ID must be between 1 and 220 characters with no spaces.",
  PROVIDER_MODEL_EXISTS: "This model is already added to that provider account.",
  ACCOUNT_EXISTS: "This key is already connected.",
  NOT_FOUND: "That provider account or model no longer exists.",
  SECRET_STORAGE_UNAVAILABLE: "Keys cannot be stored encrypted on this deployment. Set PROVIDER_SECRET_KEY, or add the key as GROQ_API_KEY_2 … GROQ_API_KEY_8 in the environment.",
};

function Meter({ label, remaining, limit }: { label: string; remaining: number | null; limit: number | null }) {
  const known = remaining !== null && limit !== null && limit > 0;
  const percent = known ? Math.max(0, Math.min(100, Math.round((remaining / limit) * 100))) : 0;
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2 text-[11px] text-ink-3">
        <span>{label}</span>
        <span className="font-mono tabular-nums text-ink-2">{known ? `${remaining.toLocaleString("en-US")} / ${limit.toLocaleString("en-US")}` : "not reported yet"}</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-label={`${label} remaining`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <div className={cn("h-full rounded-full", percent > 25 ? "bg-success" : percent > 0 ? "bg-warning" : known ? "bg-danger" : "bg-transparent")} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

export function ProviderAccounts() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [providerType, setProviderType] = useState<ProviderType>("groq");
  const [baseUrl, setBaseUrl] = useState(PROVIDERS.groq.defaultBaseUrl);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [probeResults, setProbeResults] = useState<Record<string, ProbeResult | null>>({});
  const [probeInline, setProbeInline] = useState<ProbeResult | null>(null);
  const [modelAccountId, setModelAccountId] = useState<string>("");
  const [modelId, setModelId] = useState("");
  const [modelLabel, setModelLabel] = useState("");
  const [modelContext, setModelContext] = useState("");

  const provider = PROVIDERS[providerType];

  const load = useCallback(async () => {
    try {
      const payload = await rpc<Payload>("admin_provider_accounts_list");
      setData(payload);
      setError(null);
      const ids = payload.stored.map((item) => item.id);
      setModelAccountId((current) => (current && ids.includes(current) ? current : ids[0] ?? ""));
    } catch (cause) {
      setError(ERRORS[errorCodeOf(cause)] ?? "Provider accounts could not be loaded.");
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, [load]);

  // Keep the base URL field in sync with the selected provider preset.
  useEffect(() => {
    setBaseUrl((current) => (current.trim() === PROVIDERS[providerType].defaultBaseUrl ? PROVIDERS[providerType].defaultBaseUrl : current));
  }, [providerType]);

  const act = async (id: string, action: string, payload: Record<string, unknown>) => {
    setBusy(id);
    try {
      await rpc(action, payload);
      if (action === "admin_provider_account_add") { setApiKey(""); setLabel(""); setProbeInline(null); }
      await load();
    } catch (cause) {
      setError(ERRORS[errorCodeOf(cause)] ?? "That change could not be saved.");
    } finally {
      setBusy(null);
    }
  };

  const runProbe = async (id: string, action: string, payload: Record<string, unknown>) => {
    setBusy(id);
    setProbeResults((current) => ({ ...current, [id]: null }));
    try {
      const result = await rpc<ProbeResult>(action, payload);
      setProbeResults((current) => ({ ...current, [id]: result }));
      // The backend persists the verification outcome; refresh so the badges
      // (Verified / Rejected / Unavailable, last test time) reflect it.
      await load();
    } catch (cause) {
      setError(ERRORS[errorCodeOf(cause)] ?? "That check could not be completed.");
    } finally {
      setBusy(null);
    }
  };

  const accounts = data?.accounts ?? [];
  const stored = data?.stored ?? [];
  const storedById = useMemo(() => new Map(stored.map((item) => [item.id, item])), [stored]);
  const unreadable = (data?.stored ?? []).filter((item) => !item.readable);
  const modelsForSelected = (data?.models ?? {})[modelAccountId] ?? [];

  if (!data && !error) return <span className="inline-status"><Spinner /> Loading…</span>;

  return (
    <div className="space-y-4">
      {error ? <Alert tone="danger">{error}</Alert> : null}

      {/* --------------------------- Connected accounts --------------------------- */}
      <Card className="p-4 sm:p-5">
        <h3 className="text-[14px] font-semibold text-ink">Connected provider accounts</h3>
        <p className="mt-1 text-[12.5px] leading-relaxed text-ink-2">
          Groq limits apply at the organization level. Until organization identity can be verified, all configured Groq keys share rate-limit state within this server process. Limits shown are provider-reported, not independent quotas.
        </p>
        {accounts.length === 0 ? (
          <p className="mt-4 rounded-lg border border-border bg-surface-2 px-3 py-3 text-[12.5px] text-ink-2">No account is connected. Add a key below, or set GROQ_API_KEY in the environment.</p>
        ) : (
          <ul className="mt-4 grid gap-3">
            {accounts.map((account) => {
              const storedAccount = storedById.get(account.id);
              const isGroq = account.provider === "groq";
              const probe = probeResults[`probe-${account.id}`];
              const testing = busy === account.id && probe === null;
              // A green runtime badge is only honest when the most recent real
              // test did not fail. "Ready" never means "the key was verified".
              const lastTestFailed = storedAccount ? storedAccount.last_test_ok === false : false;
              const runtimeState = !account.enabled
                ? STATE_COPY.disabled
                : lastTestFailed && account.state === "ready"
                  ? { label: "Test failed", tone: "border-danger/40 bg-danger-soft text-danger" }
                  : STATE_COPY[account.state];
              const verification = verificationBadge(storedAccount);
              return (
                <li key={account.id} className="rounded-xl border border-border bg-surface p-3">
                  <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
                    <span className={cn("rounded-full border px-2 py-0.5 text-[10.5px] font-semibold", PROVIDER_TONE[account.provider] ?? "border-border bg-surface-2 text-ink-3")}>{account.provider_label}</span>
                    <span className="min-w-0 truncate text-[13px] font-semibold text-ink">{account.label}</span>
                    <span className="font-mono text-[11px] text-ink-3">{account.key_hint}</span>
                    <span className="rounded-full border border-border bg-surface-2 px-2 py-0.5 text-[10.5px] font-semibold text-ink-2">Configured</span>
                    {verification ? <span className={cn("rounded-full border px-2 py-0.5 text-[10.5px] font-semibold", verification.tone)}>{verification.label}</span> : null}
                    {testing ? (
                      <span className="inline-flex items-center gap-1 rounded-full border border-warning/30 bg-warning-soft px-2 py-0.5 text-[10.5px] font-semibold text-warning"><Spinner className="h-3 w-3" /> Testing…</span>
                    ) : isGroq || !account.enabled ? (
                      <span className={cn("rounded-full border px-2 py-0.5 text-[10.5px] font-semibold", runtimeState.tone)}>{runtimeState.label}</span>
                    ) : null}
                    <span className="text-[11px] text-ink-3">{account.source === "env" ? "Environment" : "Added here"}</span>
                    {account.source === "admin" ? (
                      <span className="ml-auto flex flex-wrap gap-1.5">
                        <Button variant="ghost" disabled={busy === account.id} onClick={() => void runProbe(`probe-${account.id}`, "admin_provider_account_test", { doc_id: storedAccount?.doc_id ?? "" })}>Test</Button>
                        {storedAccount ? (
                          <>
                            <Button variant="ghost" disabled={busy === account.id} onClick={() => void act(account.id, "admin_provider_account_update", { doc_id: storedAccount.doc_id, enabled: !storedAccount.enabled })}>
                              {storedAccount.enabled ? "Disable" : "Enable"}
                            </Button>
                            <Button variant="ghost" disabled={busy === account.id} onClick={() => void act(account.id, "admin_provider_account_remove", { doc_id: storedAccount.doc_id })}>Remove</Button>
                          </>
                        ) : null}
                      </span>
                    ) : null}
                  </div>
                  {!isGroq ? (
                    <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1.5 text-[11.5px] text-ink-3">
                      <span className="font-mono truncate">Base: <span className="text-ink-2">{account.base_url}</span></span>
                      {account.last_error ? <span className="text-warning">{account.last_error}</span> : null}
                    </div>
                  ) : null}
                  {storedAccount ? (
                    <dl className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11.5px] sm:grid-cols-4">
                      <div><dt className="text-ink-3">Last test</dt><dd className="font-mono tabular-nums text-ink">{storedAccount.last_test_at ? <TimeOfDayText value={storedAccount.last_test_at} /> : "never"}</dd></div>
                      <div><dt className="text-ink-3">Last successful request</dt><dd className="font-mono tabular-nums text-ink">{storedAccount.last_ok_at ? <TimeOfDayText value={storedAccount.last_ok_at} /> : "—"}</dd></div>
                      <div><dt className="text-ink-3">Last error category</dt><dd className="text-ink">{storedAccount.last_test_ok === false ? (CATEGORY_LABEL[storedAccount.last_test_category ?? "unknown"]?.label ?? "Unknown") : "none"}</dd></div>
                      <div><dt className="text-ink-3">Verification model</dt><dd className="truncate font-mono text-ink">{storedAccount.last_test_model ?? "—"}</dd></div>
                    </dl>
                  ) : null}
                  {probe ? (
                    <ProbeOutcome result={probe} />
                  ) : null}
                  {isGroq ? (
                    <>
                      <dl className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11.5px] sm:grid-cols-4">
                        <div><dt className="text-ink-3">Requests, last minute</dt><dd className="font-mono tabular-nums text-ink">{account.requests_last_minute}</dd></div>
                        <div><dt className="text-ink-3">Tokens, last minute (est.)</dt><dd className="font-mono tabular-nums text-ink">{account.tokens_last_minute.toLocaleString("en-US")}</dd></div>
                        <div><dt className="text-ink-3">Last success</dt><dd className="font-mono tabular-nums text-ink">{account.last_ok_at ? <TimeOfDayText value={account.last_ok_at} /> : "—"}</dd></div>
                        <div><dt className="text-ink-3">{account.available_at ? "Usable again" : "Moved away from"}</dt><dd className="font-mono tabular-nums text-ink">{account.available_at ? <TimeOfDayText value={account.available_at} /> : `${account.rotations_away}×`}</dd></div>
                      </dl>
                      {account.models.length ? (
                        <div className="mt-3 grid gap-2.5">
                          {account.models.map((window) => (
                            <div key={window.model} className="rounded-lg border border-border bg-surface-2 px-2.5 py-2">
                              <p className="truncate font-mono text-[11px] text-ink-2">{window.model}{window.cooldown_until ? <span className="ml-2 text-warning">limited until <TimeOfDayText value={window.cooldown_until} /></span> : null}</p>
                              <div className="mt-1.5 grid gap-2 sm:grid-cols-2">
                                <Meter label="Requests (RPM window)" remaining={window.remaining_requests} limit={window.limit_requests} />
                                <Meter label="Tokens (TPM window)" remaining={window.remaining_tokens} limit={window.limit_tokens} />
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="mt-2.5 text-[11.5px] text-ink-3">No request has used this account since the server started, so Groq has not reported its limits yet.</p>
                      )}
                    </>
                  ) : null}
                  {account.last_error && isGroq ? <p className="mt-2 break-words text-[11.5px] text-ink-3">Last problem ({account.last_error_at ? <TimeOfDayText value={account.last_error_at} /> : "—"}): {account.last_error}</p> : null}
                </li>
              );
            })}
          </ul>
        )}
        {unreadable.length ? (
          <div className="mt-3"><Alert tone="warning">{unreadable.length} saved key{unreadable.length === 1 ? "" : "s"} cannot be decrypted with this deployment&apos;s secret ({unreadable.map((item) => item.label).join(", ")}. Remove and add {unreadable.length === 1 ? "it" : "them"} again.</Alert></div>
        ) : null}
      </Card>

      {/* ------------------------------ Add an account ----------------------------- */}
      <Card className="p-4 sm:p-5">
        <h3 className="text-[14px] font-semibold text-ink">Add a provider account</h3>
        <p className="mt-1 text-[12.5px] leading-relaxed text-ink-2">
          Connect another Groq key (their quotas rotate together), or a credential for OpenAI, Anthropic, Google or any OpenAI-compatible endpoint. The key is encrypted before it is stored and is never shown again.
        </p>
        {data && !data.can_store ? (
          <div className="mt-3"><Alert tone="warning">{ERRORS.SECRET_STORAGE_UNAVAILABLE}</Alert></div>
        ) : (
          <>
            <form
              className="mt-3 grid gap-3 sm:grid-cols-2"
              onSubmit={(event) => { event.preventDefault(); void act("new", "admin_provider_account_add", { label, provider: providerType, base_url: baseUrl, api_key: apiKey }); }}
            >
              <Field label="Provider" htmlFor="provider-account-provider">
                <Select id="provider-account-provider" value={providerType} onChange={(event) => { setProviderType(event.target.value as ProviderType); setProbeInline(null); }}>
                  {Object.values(PROVIDERS).map((entry) => (
                    <option key={entry.type} value={entry.type}>{entry.label}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Name" htmlFor="provider-account-label" hint={provider.description}>
                <Input id="provider-account-label" value={label} onChange={(event) => setLabel(event.target.value)} placeholder={`${provider.label} account`} maxLength={60} />
              </Field>
              <Field label="API base URL" htmlFor="provider-account-base" hint={provider.baseUrlRequired ? "Required for a custom OpenAI-compatible endpoint." : "Defaults to the provider's official API. Change it to use a gateway or self-hosted server."}>
                <Input id="provider-account-base" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder={provider.defaultBaseUrl} />
              </Field>
              <Field label="API key" htmlFor="provider-account-key" hint={`Encrypted before it is stored. ${provider.keyHint}.`}>
                <Input id="provider-account-key" type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={provider.keyHint} />
              </Field>
              <div className="flex items-end gap-2 sm:col-span-2">
                <Button type="submit" disabled={busy === "new" || apiKey.trim().length < 20}>{busy === "new" ? "Saving…" : "Add account"}</Button>
                <Button type="button" variant="ghost" disabled={busy === "probe-new" || apiKey.trim().length < 20} onClick={() => void runProbe("probe-new", "admin_provider_account_test", { provider: providerType, base_url: baseUrl, api_key: apiKey })}>
                  {busy === "probe-new" ? "Checking…" : "Test connection"}
                </Button>
              </div>
            </form>
            {probeInline ? <ProbeOutcome result={probeInline} /> : null}
          </>
        )}
        <p className="mt-3 text-[11.5px] leading-relaxed text-ink-3">Only connect credentials you are authorized to use. Adding keys does not increase an organization&apos;s quota.</p>
      </Card>

      {/* ------------------------------- Models ---------------------------------- */}
      <Card className="p-4 sm:p-5">
        <h3 className="text-[14px] font-semibold text-ink">Models for a provider</h3>
        <p className="mt-1 text-[12.5px] leading-relaxed text-ink-2">
          Add the model IDs this deployment should be able to use for a provider account. Use “Test” on an account to see the models the provider actually offers this key — the IDs are stored exactly as entered.
        </p>
        {stored.length === 0 ? (
          <p className="mt-4 rounded-lg border border-border bg-surface-2 px-3 py-3 text-[12.5px] text-ink-2">Add a provider account first, then attach models to it here.</p>
        ) : (
          <div className="mt-3 grid gap-4 lg:grid-cols-[1fr_1.4fr]">
            <div className="space-y-3">
              <Field label="Provider account" htmlFor="provider-model-account">
                <Select id="provider-model-account" value={modelAccountId} onChange={(event) => setModelAccountId(event.target.value)}>
                  {stored.map((item) => (
                    <option key={item.id} value={item.id}>{item.provider_label} · {item.label}</option>
                  ))}
                </Select>
              </Field>
              {modelsForSelected.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-[12px] text-ink-3">No models added yet.</p>
              ) : (
                <ul className="space-y-2">
                  {modelsForSelected.map((model) => (
                    <li key={model.model_id} className="rounded-lg border border-border bg-surface p-2.5">
                      <div className="flex items-center gap-2">
                        <Badge tone={model.enabled ? "success" : "neutral"}>{model.enabled ? "Enabled" : "Disabled"}</Badge>
                        <span className="min-w-0 truncate font-mono text-[12px] text-ink">{model.model_id}</span>
                      </div>
                      <p className="mt-1 truncate text-[11.5px] text-ink-3">{model.label}{model.context_tokens ? ` · ${model.context_tokens.toLocaleString("en-US")} context` : ""}</p>
                      <span className="mt-1.5 flex gap-1.5">
                        <Button variant="ghost" disabled={busy === `model-${model.model_id}`} onClick={() => void act(`model-${model.model_id}`, "admin_provider_model_update", { model_id: model.model_id, enabled: !model.enabled })}>
                          {model.enabled ? "Disable" : "Enable"}
                        </Button>
                        <Button variant="ghost" disabled={busy === `model-${model.model_id}`} onClick={() => void act(`model-${model.model_id}`, "admin_provider_model_remove", { model_id: model.model_id })}>Remove</Button>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="rounded-xl border border-border bg-surface p-3">
              <p className="text-[13px] font-semibold text-ink">Add a model</p>
              <form
                className="mt-3 grid gap-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  const account = stored.find((item) => item.id === modelAccountId);
                  if (!account) return;
                  void act(`model-new-${account.id}`, "admin_provider_model_add", {
                    account_id: account.id,
                    model_id: modelId,
                    label: modelLabel,
                    context_tokens: modelContext,
                    provider: account.provider,
                  });
                  setModelId("");
                  setModelLabel("");
                  setModelContext("");
                }}
              >
                <Field label="Model ID" htmlFor="provider-model-id" hint="Exactly as the provider names it (e.g. claude-sonnet-4-5, gpt-4o, gemini-2.0-flash).">
                  <Input id="provider-model-id" value={modelId} onChange={(event) => setModelId(event.target.value)} placeholder="model-id" maxLength={220} />
                </Field>
                <Field label="Display label" htmlFor="provider-model-label">
                  <Input id="provider-model-label" value={modelLabel} onChange={(event) => setModelLabel(event.target.value)} placeholder="Optional friendly name" maxLength={80} />
                </Field>
                <Field label="Context tokens" htmlFor="provider-model-context" hint="Optional. The provider-reported context window, when known.">
                  <Input id="provider-model-context" value={modelContext} onChange={(event) => setModelContext(event.target.value)} placeholder="131072" inputMode="numeric" />
                </Field>
                <Button type="submit" disabled={busy !== null || !modelAccountId || modelId.trim().length === 0}>Add model</Button>
              </form>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

function ProbeOutcome({ result }: { result: ProbeResult }) {
  const checkedAt = result.checked_at ? <TimeOfDayText value={result.checked_at} /> : null;
  if (result.ok) {
    return (
      <div className="mt-2.5 rounded-lg border border-success/30 bg-success-soft px-3 py-2 text-[11.5px] text-success">
        <p className="font-semibold">Verified — the provider accepted the authenticated request{checkedAt ? <> at {checkedAt}</> : null}.</p>
        <p className="mt-0.5">
          {result.model_used ? <>Model checked: <span className="font-mono">{result.model_used}</span>. </> : null}
          The provider reports {result.models.length} model{result.models.length === 1 ? "" : "s"} for this key{result.latency_ms ? ` (${result.latency_ms} ms)` : ""}.
        </p>
      </div>
    );
  }
  const category = result.category ? (CATEGORY_LABEL[result.category] ?? CATEGORY_LABEL.unknown).label : null;
  return (
    <div className="mt-2.5 rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-[11.5px] text-danger">
      <p className="font-semibold">
        Not verified{category ? ` — ${category}` : ""}{result.status ? ` (HTTP ${result.status})` : ""}{checkedAt ? <> · {checkedAt}</> : null}
      </p>
      <p className="mt-0.5 break-words">{result.error ?? result.detail ?? "The provider could not be reached."}</p>
      {result.model_used ? <p className="mt-0.5 text-[11px] text-ink-3">Verification model: <span className="font-mono">{result.model_used}</span></p> : null}
    </div>
  );
}
