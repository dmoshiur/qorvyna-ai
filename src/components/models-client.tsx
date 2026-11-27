"use client";

// Model settings: every registered model with its real configuration,
// current availability, diagnostic state, and live connectivity probe.
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Activity, Check, RefreshCw, Sparkles, X } from "lucide-react";
import { Alert, Badge, Button, Card, Spinner } from "@/components/ui";
import { VerifiedTimeText } from "@/components/local-time";
import { cn } from "@/lib/utils";
import { onModelPoolChange, saveModelPool, testModelConnection, visualStateForModel } from "@/components/model-picker";
import { STRENGTH_LABEL, type ModelStatus, type PoolPreference } from "@/lib/ai/models/types";

type DefaultModel = { health: "online" | "unavailable" | "not-configured" | "unchecked"; error: string | null; checked_at: string };
type Payload = { model: DefaultModel; models: ModelStatus[]; pool: PoolPreference; max_active: number; custom_providers?: CustomProvider[] };
/** Local mirror of the server's PublicUserProvider (provider-vault is server-only). */
type CustomProvider = {
  id: string;
  name: string;
  base_url: string;
  key_mask: string;
  models: { id: string; label: string }[];
  enabled: boolean;
  last_verified_at: string | null;
  last_error: string | null;
};

function Capability({ on, label }: { on: boolean; label: string }) {
  return <li className="flex items-center gap-1.5 text-xs">
    {on ? <Check size={13} className="shrink-0 text-success" aria-hidden /> : <X size={13} className="shrink-0 text-ink-3" aria-hidden />}
    <span className={on ? "text-ink-2" : "text-ink-3"}>{label}{on ? "" : " — no"}</span>
  </li>;
}

const SAVE_ERRORS: Record<string, string> = {
  MODEL_UNAVAILABLE: "That model isn't available right now, so it can't be switched on.",
  EMPTY_MODEL_POOL: "Keep at least one model on, or use Auto.",
};

export function ModelsClient({ showChatLink = true }: { showChatLink?: boolean }) {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState("");
  const [testingKey, setTestingKey] = useState("");
  const [testFeedback, setTestFeedback] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const response = await fetch("/api/models?check=1", { cache: "no-store", credentials: "same-origin" });
      const body = await response.json();
      if (!response.ok) throw new Error("load");
      setData(body);
    } catch { setError("Model status couldn't be loaded. Check your connection and try again."); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => onModelPoolChange((pool) => setData((current) => (current ? { ...current, pool } : current))), []);

  const pool = data?.pool ?? { auto: true, enabled: [] };
  const available = data?.models.filter((model) => model.availability === "available") ?? [];
  const activeCount = pool.auto ? Math.min(available.length, data?.max_active ?? 4) : pool.enabled.filter((key) => available.some((model) => model.key === key)).length;

  async function apply(next: PoolPreference, key: string): Promise<boolean> {
    if (!data) return false;
    const previous = data.pool;
    setData({ ...data, pool: next });
    setSaving(key); setError("");
    try {
      const saved = await saveModelPool(next);
      setData((current) => (current ? { ...current, pool: saved } : current));
      return true;
    } catch (err) {
      setData((current) => (current ? { ...current, pool: previous } : current));
      setError(SAVE_ERRORS[err instanceof Error ? err.message : ""] ?? "The change couldn't be saved. Try again.");
      return false;
    } finally { setSaving(""); }
  }
  function toggle(key: string) {
    if (!data) return;
    const base = pool.auto ? [] : pool.enabled;
    const enabling = !base.includes(key);
    const next = base.includes(key) ? base.filter((item) => item !== key) : [...base, key];
    if (next.length > data.max_active) { setError(`Up to ${data.max_active} models can work together on one request.`); return; }
    const saved = apply(next.length ? { auto: false, enabled: next } : { auto: true, enabled: [] }, key);
    // Turning a model on verifies it live so its "Last verified" timestamp is
    // recorded server-side immediately, not left as "Not tested yet".
    void saved.then((ok) => {
      if (!ok || !enabling) return;
      const model = data.models.find((item) => item.key === key);
      if (model) void runConnectionTest(model);
    });
  }

  async function runConnectionTest(model: ModelStatus) {
    if (testingKey) return;
    setTestingKey(model.key);
    setError("");
    try {
      const res = await testModelConnection(model.key);
      if (res.model) {
        setData((current) =>
          current
            ? { ...current, models: current.models.map((item) => (item.key === res.model!.key ? res.model! : item)) }
            : current,
        );
      }
      setTestFeedback((current) => ({
        ...current,
        [model.key]: {
          ok: res.ok,
          text: res.ok
            ? `Connection verified in ${res.latency_ms}ms (${res.status_label}).`
            : `${res.status_label}: ${res.detail}`,
        },
      }));
    } catch {
      setTestFeedback((current) => ({
        ...current,
        [model.key]: { ok: false, text: "Connectivity check failed to run." },
      }));
    } finally {
      setTestingKey("");
    }
  }

  // -------------------------------------------------------------------------
  // Issue 8: bring-your-own providers (server-scoped to the signed-in user).
  // -------------------------------------------------------------------------
  const [customBusy, setCustomBusy] = useState("");
  const [adding, setAdding] = useState(false);
  const [addForm, setAddForm] = useState({ name: "", base_url: "", api_key: "", models: "" });
  const [addError, setAddError] = useState("");

  const customProviders = data?.custom_providers ?? [];

  async function mutateProvider(id: string, patch: Record<string, unknown>) {
    setCustomBusy(id);
    setAddError("");
    try {
      const res = await fetch(`/api/ai/providers/${id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch), credentials: "same-origin",
      });
      if (!res.ok) throw new Error("update_failed");
      const body = await res.json();
      setData((c) => (c ? { ...c, custom_providers: c.custom_providers?.map((p) => (p.id === id ? body.provider : p)) ?? [] } : c));
    } catch { setError("Could not update that provider."); }
    finally { setCustomBusy(""); }
  }
  async function deleteProvider(id: string) {
    if (!confirm("Delete this provider and its stored key? This cannot be undone.")) return;
    setCustomBusy(id);
    try {
      const res = await fetch(`/api/ai/providers/${id}`, { method: "DELETE", credentials: "same-origin" });
      if (!res.ok) throw new Error("delete_failed");
      setData((c) => (c ? { ...c, custom_providers: c.custom_providers?.filter((p) => p.id !== id) ?? [] } : c));
    } catch { setError("Could not delete that provider."); }
    finally { setCustomBusy(""); }
  }
  async function addProvider() {
    setAddError("");
    const models = addForm.models.split(",").map((m) => m.trim()).filter(Boolean).map((id) => ({ id, label: id }));
    if (!addForm.name.trim() || !addForm.base_url.trim() || !addForm.api_key.trim() || models.length === 0) {
      setAddError("Name, base URL, API key and at least one model ID are required.");
      return;
    }
    setCustomBusy("new");
    try {
      const res = await fetch("/api/ai/providers", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: addForm.name, base_url: addForm.base_url, api_key: addForm.api_key, models }), credentials: "same-origin",
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? "add_failed");
      setData((c) => (c ? { ...c, custom_providers: [...(c.custom_providers ?? []), body.provider] } : c));
      setAddForm({ name: "", base_url: "", api_key: "", models: "" });
      setAdding(false);
    } catch (err) {
      setAddError(err instanceof Error ? err.message : "Could not add the provider.");
    } finally { setCustomBusy(""); }
  }

  const health = data?.model.health;
  return <div className="mx-auto max-w-3xl space-y-6">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <p className="eyebrow text-accent">Intelligence</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Models</h1>
        <p className="mt-2 max-w-2xl text-sm text-ink-2">Choose which models work on your requests in Chat and Agent. When more than one is on, each takes a different part of the job and you get one combined answer.</p>
      </div>
      <Button variant="outline" onClick={() => void load()} disabled={loading}><RefreshCw size={15} className={loading ? "animate-spin" : ""} /> Refresh status</Button>
    </header>
    <div aria-live="polite" className="space-y-2 empty:hidden">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {health === "unavailable" ? <Alert tone="warning">The default model did not answer the live check{data?.model.error ? ` (${data.model.error})` : ""}. Requests will show a provider error until it recovers.</Alert> : null}
      {health === "not-configured" ? <Alert tone="warning">No API key is installed on the server (GROQ_API_KEY). AI features are unavailable until it is added.</Alert> : null}
    </div>

    {loading && !data ? <div className="space-y-3" aria-busy="true">{[0, 1, 2].map((item) => <div key={item} className="h-28 animate-pulse rounded-2xl bg-surface-2/60" />)}</div> : null}

    {data ? <>
      <Card className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <Sparkles size={18} className={cn("mt-0.5 shrink-0", pool.auto ? "text-accent" : "text-ink-3")} />
          <div className="min-w-0">
            <h2 className="font-semibold">Auto</h2>
            <p className="text-sm text-ink-2">QORVYNA uses every available model and decides who does what. {activeCount} active now.</p>
          </div>
        </div>
        <Button variant={pool.auto ? "secondary" : "primary"} disabled={pool.auto || saving === "auto"} onClick={() => void apply({ auto: true, enabled: [] }, "auto")}>{pool.auto ? "On" : "Use Auto"}</Button>
      </Card>

      <p className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-xs text-ink-2">
        <span className="font-medium text-ink">Auto routing rules —</span> QORVYNA inspects each message and picks the
        best-fit model from the enabled pool: long or code-heavy prompts route to the larger models, short general
        questions to the efficient ones, and requests that need tool use or a specific strength go to the model that
        can serve them. Availability (provider key, quota and plan) is checked live, so a model that is temporarily
        unavailable is skipped and the request is handed to the next best option automatically.
      </p>

      <ul className="space-y-3">
        {data.models.map((model) => {
          const usable = model.availability === "available";
          const on = usable && (pool.auto || pool.enabled.includes(model.key));
          const isTesting = testingKey === model.key;
          const visual = visualStateForModel(model, isTesting);
          const feedback = testFeedback[model.key];
          return <li key={model.key}>
            <Card className="space-y-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="flex flex-wrap items-center gap-2 text-lg font-semibold">{model.label}{model.is_default ? <Badge>Default</Badge> : null}</h2>
                  <p className="mt-0.5 text-sm text-ink-2">{model.summary}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge className={cn(
                    isTesting ? "!border-accent/40 !text-accent"
                      : usable ? "!border-success/40 !text-success"
                      : model.status_code === "invalid_credentials" || model.status_code === "permission_denied" ? "!border-danger/40 !text-danger"
                      : "!border-warning/40 !text-warning",
                  )}>
                    <span className={cn("mr-1.5 inline-block h-1.5 w-1.5 rounded-full", visual.dot)} aria-hidden="true" />
                    {visual.label}
                  </Badge>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void runConnectionTest(model)}
                    disabled={Boolean(testingKey)}
                    className="!min-h-8 !px-2.5 !py-1 text-xs"
                  >
                    {isTesting ? <Spinner /> : <Activity size={13} />}
                    {isTesting ? "Testing…" : "Test connection"}
                  </Button>
                  <button
                    type="button" role="switch" aria-checked={on} aria-label={`Use ${model.label}`} disabled={!usable || saving === model.key}
                    onClick={() => toggle(model.key)}
                    className={cn("relative h-6 w-11 shrink-0 rounded-full transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50", on ? "bg-accent-solid" : "bg-surface-2 ring-1 ring-inset ring-border")}
                  >
                    <span className={cn("absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-[left]", on ? "left-[22px]" : "left-0.5")} />
                  </button>
                </div>
              </div>
              {feedback ? (
                <p className={cn("text-xs font-medium", feedback.ok ? "text-success" : "text-danger")} role="status">
                  {feedback.text}
                </p>
              ) : null}
              {!usable || (model.reason && model.reason !== "Ready") ? (
                <p className="text-sm text-warning">
                  {model.reason}
                  {model.diagnostic_hint ? <span className="block text-xs text-ink-3">{model.diagnostic_hint}</span> : null}
                </p>
              ) : null}
              <div className="flex flex-wrap gap-1.5">{model.strengths.map((strength) => <Badge key={strength}>{STRENGTH_LABEL[strength]}</Badge>)}</div>
              <ul className="flex flex-wrap gap-x-4 gap-y-1">
                <Capability on={model.streaming} label="Streaming" />
                <Capability on={model.tool_calling} label="Tool calling" />
                <Capability on={model.structured_output} label="Structured output" />
                <Capability on={false} label="Image understanding" />
              </ul>
              <dl className="grid gap-x-4 gap-y-1 border-t border-border pt-3 text-xs text-ink-3 sm:grid-cols-2">
                <div><dt className="inline">Provider: </dt><dd className="inline text-ink-2">{model.provider}</dd></div>
                <div className="min-w-0"><dt className="inline">Model ID: </dt><dd className="inline break-all font-mono text-ink-2">{model.model_id}</dd></div>
                <div><dt className="inline">Context window: </dt><dd className="inline text-ink-2">{model.context_tokens.toLocaleString("en-US")} tokens</dd></div>
                <div><dt className="inline">Longest reply: </dt><dd className="inline text-ink-2">{model.max_output_tokens.toLocaleString("en-US")} tokens</dd></div>
                <div><dt className="inline">Supported modes: </dt><dd className="inline text-ink-2">{model.supported_modes?.join(", ") || "chat, agent"}</dd></div>
                <div>
                  <dt className="inline">Last verified: </dt>
                  <dd className="inline text-ink-2"><VerifiedTimeText value={model.last_tested_at} /></dd>
                </div>
                {model.last_error ? (
                  <div className="sm:col-span-2">
                    <dt className="inline">Last error: </dt>
                    <dd className="inline text-danger">{model.last_error.code}{model.last_error.status ? ` (${model.last_error.status})` : ""} — {model.last_error.message}</dd>
                  </div>
                ) : null}
              </dl>
            </Card>
          </li>;
        })}
      </ul>
      <p className="text-xs text-ink-3">Availability is checked against the provider&apos;s live model list and server connectivity tests. Temporary upstream errors do not permanently disable models.</p>
      {showChatLink ? <Link href="/chat" className="btn btn-primary">Open chat</Link> : null}

      {/* Issue 8 — bring-your-own providers */}
      <section className="space-y-3" aria-label="Your AI providers">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold tracking-tight">Your AI providers</h2>
            <p className="text-sm text-ink-2">Add your own OpenAI-compatible endpoint and API key. Keys are encrypted at rest and only used for your own requests.</p>
          </div>
          {!adding ? (
            <Button variant="outline" onClick={() => setAdding(true)} disabled={Boolean(customBusy)}>Add provider</Button>
          ) : null}
        </div>
        {adding ? (
          <Card className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-xs text-ink-2">Display name
                <input className="mt-1 w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm" value={addForm.name} onChange={(e) => setAddForm({ ...addForm, name: e.target.value })} placeholder="My vLLM gateway" />
              </label>
              <label className="text-xs text-ink-2">Base URL
                <input className="mt-1 w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm" value={addForm.base_url} onChange={(e) => setAddForm({ ...addForm, base_url: e.target.value })} placeholder="https://api.openai.com/v1" />
              </label>
              <label className="text-xs text-ink-2">API key
                <input type="password" className="mt-1 w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm" value={addForm.api_key} onChange={(e) => setAddForm({ ...addForm, api_key: e.target.value })} placeholder="sk-…" />
              </label>
              <label className="text-xs text-ink-2">Model IDs (comma-separated)
                <input className="mt-1 w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm" value={addForm.models} onChange={(e) => setAddForm({ ...addForm, models: e.target.value })} placeholder="my-model-1, my-model-2" />
              </label>
            </div>
            {addError ? <p className="text-xs font-medium text-danger">{addError}</p> : null}
            <div className="flex gap-2">
              <Button variant="primary" onClick={() => void addProvider()} disabled={customBusy === "new"}>Save &amp; test</Button>
              <Button variant="ghost" onClick={() => { setAdding(false); setAddError(""); }}>Cancel</Button>
            </div>
          </Card>
        ) : null}
        {customProviders.length === 0 && !adding ? (
          <p className="text-sm text-ink-3">No custom providers yet. Add one to route your traffic through your own model and key.</p>
        ) : null}
        <ul className="space-y-3">
          {customProviders.map((provider) => (
            <li key={provider.id}>
              <Card className="space-y-2">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="flex flex-wrap items-center gap-2 text-lg font-semibold">
                      {provider.name}
                      <Badge className="!border-accent/40 !text-accent">Custom</Badge>
                      {provider.enabled ? <Badge className="!border-success/40 !text-success">Enabled</Badge> : <Badge className="!border-warning/40 !text-warning">Disabled</Badge>}
                    </h3>
                    <p className="mt-0.5 truncate text-sm text-ink-2">{provider.base_url}</p>
                    <p className="text-xs text-ink-3">Key {provider.key_mask}{provider.last_verified_at ? ` · verified ${new Date(provider.last_verified_at).toLocaleString()}` : ""}</p>
                    {provider.last_error ? <p className="text-xs text-danger">{provider.last_error}</p> : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button variant="outline" className="!min-h-8 !px-2.5 !py-1 text-xs" onClick={() => void mutateProvider(provider.id, { test: true })} disabled={Boolean(customBusy)}>
                      {customBusy === provider.id ? <Spinner /> : <Activity size={13} />} Test
                    </Button>
                    <button
                      type="button" role="switch" aria-checked={provider.enabled} aria-label={`Use ${provider.name}`}
                      onClick={() => void mutateProvider(provider.id, { enabled: !provider.enabled })}
                      className={cn("relative h-6 w-11 shrink-0 rounded-full transition-colors", provider.enabled ? "bg-accent-solid" : "bg-surface-2 ring-1 ring-inset ring-border")}
                    >
                      <span className={cn("absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-[left]", provider.enabled ? "left-[22px]" : "left-0.5")} />
                    </button>
                    <Button variant="ghost" className="!min-h-8 !px-2.5 !py-1 text-xs !text-danger" onClick={() => void deleteProvider(provider.id)} disabled={Boolean(customBusy)}>Delete</Button>
                  </div>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {provider.models.map((m) => <Badge key={m.id}>{m.label || m.id}</Badge>)}
                </div>
              </Card>
            </li>
          ))}
        </ul>
      </section>
    </> : null}
  </div>;
}
