"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, CloudCog, KeyRound, Loader2, Play, ShieldCheck, Trash2 } from "lucide-react";
import { Button, Input, Select } from "@/components/ui";
import { mintSessionCookie, optionalAuthHeaders } from "@/lib/client/api";
import { fbAuth, firebaseBrowserConfigured } from "@/lib/firebase/client";

export type DaytonaClientStatus = {
  configured: boolean;
  encryptionAvailable: boolean;
  source: "user" | "system" | "env" | "none";
  keyLast4: string | null;
  keyMask: string | null;
  target: string;
  sdk: "@daytona/sdk";
};

async function daytonaFetch(url: string, init?: RequestInit): Promise<Response> {
  const auth = await optionalAuthHeaders();
  const hasAuth = Object.keys(auth).length > 0;
  const merged: RequestInit | undefined =
    init || hasAuth
      ? {
          ...init,
          headers: {
            ...auth,
            ...(init?.headers ?? {}),
          },
        }
      : undefined;

  let res = merged ? await fetch(url, merged) : await fetch(url);
  if (res.status === 401 && firebaseBrowserConfigured) {
    try {
      const current = fbAuth().currentUser;
      if (current) {
        await mintSessionCookie(current, { forceRefresh: true });
        const retryAuth = await optionalAuthHeaders(true);
        res = await fetch(url, {
          ...init,
          headers: {
            ...retryAuth,
            ...(init?.headers ?? {}),
          },
        });
      }
    } catch {
      // keep 401
    }
  }
  return res;
}

export function DaytonaConnection({
  compact = false,
  projectId,
  onStatusChange,
}: {
  compact?: boolean;
  projectId?: string;
  onStatusChange?: (status: DaytonaClientStatus) => void;
}) {
  const [status, setStatus] = useState<DaytonaClientStatus | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [target, setTarget] = useState("");
  const [language, setLanguage] = useState<"typescript" | "javascript" | "python">("typescript");
  const [code, setCode] = useState('console.log("Hello World from Daytona Sandbox!");');
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [runOutput, setRunOutput] = useState<{
    exitCode: number;
    stdout: string;
    sandboxId: string;
    durationMs: number;
  } | null>(null);
  const [editingKey, setEditingKey] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      const res = await daytonaFetch("/api/daytona", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as DaytonaClientStatus;
      setStatus(data);
      setTarget((prev) => prev || data.target || "");
      onStatusChange?.(data);
    } catch {
      // keep current state
    }
  }, [onStatusChange]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  async function handleSaveKey() {
    const trimmed = apiKey.trim();
    if (trimmed.length < 16) {
      setNotice("Enter a valid Daytona API key (for example dtn_...).");
      return;
    }
    setSaving(true);
    setNotice(null);
    try {
      const res = await daytonaFetch("/api/daytona", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "configure",
          apiKey: trimmed,
          target: target.trim() || undefined,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as DaytonaClientStatus & { error?: string };
      if (!res.ok || !data.configured) {
        setNotice(
          data.error === "DAYTONA_SECRET_KEY_MISSING"
            ? "Server secret encryption key is not set (configure GITHUB_TOKEN_ENCRYPTION_KEY or PROVIDER_SECRET_KEY)."
            : "Could not save Daytona API key. Check the key format and try again.",
        );
        return;
      }
      setApiKey("");
      setEditingKey(false);
      setStatus(data);
      onStatusChange?.(data);
      setNotice(`Saved Daytona API key (${data.keyMask ?? "encrypted"}).`);
    } catch {
      setNotice("Could not save Daytona API key right now.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDisconnect() {
    setSaving(true);
    setNotice(null);
    try {
      const res = await daytonaFetch("/api/daytona", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "disconnect" }),
      });
      if (!res.ok) throw new Error("disconnect");
      const data = (await res.json()) as DaytonaClientStatus;
      setStatus(data);
      onStatusChange?.(data);
      setRunOutput(null);
      setNotice("Removed saved user Daytona API key.");
    } catch {
      setNotice("Could not remove Daytona API key right now.");
    } finally {
      setSaving(false);
    }
  }

  async function handleRunCode() {
    if (!code.trim()) return;
    setRunning(true);
    setNotice(null);
    setRunOutput(null);
    try {
      const res = await daytonaFetch("/api/daytona", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "code_run",
          code,
          language,
          ...(projectId ? { projectId } : {}),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        result?: { exitCode: number; stdout: string; result: string; sandboxId: string; durationMs: number };
        error?: string;
      };
      if (!res.ok || !data.result) {
        setNotice(
          data.error === "DAYTONA_NOT_CONFIGURED"
            ? "Configure your Daytona API key first."
            : "Daytona sandbox execution failed — verify that your Daytona API key is active.",
        );
        return;
      }
      setRunOutput({
        exitCode: data.result.exitCode,
        stdout: data.result.stdout || data.result.result || "(no output)",
        sandboxId: data.result.sandboxId,
        durationMs: data.result.durationMs,
      });
    } catch {
      setNotice("Network error while contacting Daytona Sandbox.");
    } finally {
      setRunning(false);
    }
  }

  if (!status) {
    return (
      <div className="flex items-center gap-2 py-3 text-xs text-ink-3">
        <Loader2 className="animate-spin" size={14} /> Checking Daytona Cloud Sandbox…
      </div>
    );
  }

  const showConfigForm = !status.configured || editingKey;

  return (
    <div className="space-y-3 rounded-xl border border-border bg-surface-2 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-border-strong bg-surface">
            <CloudCog size={17} />
          </span>
          <div>
            <p className="text-sm font-semibold text-ink">Daytona Cloud Sandbox</p>
            {status.configured ? (
              <p className="flex items-center gap-1 text-[11px] text-success">
                <ShieldCheck size={11} /> Connected via {status.sdk} ({status.keyMask ?? status.source}
                {status.target ? ` · ${status.target}` : ""})
              </p>
            ) : (
              <p className="text-xs text-ink-2">
                Configure your Daytona API key (<span className="font-mono">dtn_...</span>) for isolated remote code &amp; shell sandboxes instead of Codespaces.
              </p>
            )}
          </div>
        </div>
        {status.configured ? (
          <div className="flex items-center gap-1.5">
            <Button variant="secondary" onClick={() => setEditingKey((prev) => !prev)}>
              <KeyRound size={13} /> {editingKey ? "Cancel" : "Update key"}
            </Button>
            {status.source === "user" ? (
              <button
                type="button"
                onClick={() => void handleDisconnect()}
                disabled={saving}
                aria-label="Remove Daytona key"
                title="Remove Daytona key"
                className="grid h-9 w-9 place-items-center rounded-lg text-ink-3 hover:bg-surface hover:text-danger"
              >
                <Trash2 size={14} />
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      {showConfigForm ? (
        <div className="space-y-2.5 rounded-lg border border-border bg-surface p-3">
          <div className="grid gap-2 sm:grid-cols-[1fr_9rem]">
            <div>
              <label htmlFor="daytona-api-key" className="mb-1 block text-xs font-medium text-ink-2">
                Daytona API key
              </label>
              <Input
                id="daytona-api-key"
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder="dtn_..."
                autoComplete="off"
                disabled={saving}
              />
            </div>
            <div>
              <label htmlFor="daytona-target" className="mb-1 block text-xs font-medium text-ink-2">
                Target (optional)
              </label>
              <Input
                id="daytona-target"
                value={target}
                onChange={(event) => setTarget(event.target.value)}
                placeholder="us / eu"
                disabled={saving}
              />
            </div>
          </div>
          <p className="text-[11px] text-ink-3">
            Stored AES-256-GCM encrypted server-side and executed via <span className="font-mono">@daytona/sdk</span> (<span className="font-mono">daytona.create(&#123; language &#125;)</span>). Never exposed to the browser.
          </p>
          <Button
            onClick={() => void handleSaveKey()}
            disabled={saving || apiKey.trim().length < 16}
            className="w-full"
          >
            {saving ? <Loader2 className="animate-spin" size={14} /> : <KeyRound size={14} />}
            Save Daytona API key
          </Button>
        </div>
      ) : null}

      {status.configured && !compact ? (
        <div className="space-y-2 rounded-lg border border-border bg-surface p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-semibold text-ink">Sandbox Code Runner (@daytona/sdk)</span>
            <div className="w-36">
              <Select
                aria-label="Sandbox language"
                value={language}
                onChange={(event) => {
                  const nextLang = event.target.value as "typescript" | "javascript" | "python";
                  setLanguage(nextLang);
                  if (nextLang === "python" && code.startsWith("console.log")) {
                    setCode('print("Hello World from Daytona Sandbox!")');
                  } else if (nextLang !== "python" && code.startsWith("print(")) {
                    setCode('console.log("Hello World from Daytona Sandbox!");');
                  }
                }}
                disabled={running}
              >
                <option value="typescript">TypeScript</option>
                <option value="javascript">JavaScript</option>
                <option value="python">Python</option>
              </Select>
            </div>
          </div>
          <textarea
            value={code}
            onChange={(event) => setCode(event.target.value)}
            rows={4}
            spellCheck={false}
            className="w-full rounded-lg border border-border bg-bg p-2.5 font-mono text-xs text-ink focus:outline-none"
          />
          <Button onClick={() => void handleRunCode()} disabled={running || !code.trim()} className="w-full">
            {running ? <Loader2 className="animate-spin" size={14} /> : <Play size={14} />}
            {running ? "Running in Daytona Sandbox…" : "Run in Daytona Sandbox"}
          </Button>
          {runOutput ? (
            <div className="rounded-lg border border-border bg-bg p-2.5 font-mono text-xs">
              <p className="mb-1 text-[10px] text-ink-3">
                sandbox={runOutput.sandboxId} · exit={runOutput.exitCode} · {runOutput.durationMs}ms
              </p>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap text-ink">{runOutput.stdout}</pre>
            </div>
          ) : null}
        </div>
      ) : null}

      {notice ? (
        <p className="flex items-center gap-1.5 text-xs text-ink-2">
          <Check size={12} className="text-success" /> {notice}
        </p>
      ) : null}
    </div>
  );
}
