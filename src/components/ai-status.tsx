"use client";

// Configuration checks do not consume inference quota. Only a successful chat
// response can mark the service online; configuration alone is unknown.

import { useCallback, useEffect, useState } from "react";
import { firebaseBrowserConfigured } from "@/lib/firebase/client";
import { cachedRequest, peekCache, publishCache, subscribe } from "@/lib/client/cache";
import { cn } from "@/lib/utils";

const CACHE_KEY = "ai:health";
// The status pill can be mounted more than once (mobile top bar + sidebar).
// A shared cache serves every copy of an explicit check.
const CACHE_TTL_MS = 60_000;
const CHECK_TIMEOUT_MS = 6_000;

type AiState = "unknown" | "checking" | "online" | "unavailable" | "not-configured";

const LABEL: Record<AiState, string> = {
  unknown: "Check AI status",
  checking: "Checking…",
  online: "AI Online",
  unavailable: "AI Unavailable",
  "not-configured": "AI not configured",
};

let lastSuccess = 0;
/** A real provider reply is stronger evidence than a possibly stale health
 * probe. Keep it short-lived; the next scheduled probe still checks liveness. */
export function reportSuccessfulAiResponse(): void {
  lastSuccess = Date.now();
  publishCache<AiState>(CACHE_KEY, "online", 30_000);
}

async function probe(): Promise<AiState> {
  try {
    // Chat and Agent can have different configured routes. Neither a failed
    // chat-model probe nor a successful one says anything about Agent readiness.
    let configured = false;
    for (const mode of ["general", "agent"] as const) {
      const res = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "health", mode }),
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      });
      const data = (await res.json().catch(() => ({}))) as { status?: string };
      if (res.ok && data.status === "unknown") configured = true;
      else if (data.status !== "unconfigured") return "unavailable";
    }
    if (Date.now() - lastSuccess < 30_000) return "online";
    return configured ? "unknown" : "not-configured";
  } catch {
    return Date.now() - lastSuccess < 30_000 ? "online" : "unavailable";
  }
}

export function AiStatus({ className }: { className?: string }) {
  const [state, setState] = useState<AiState>(
    firebaseBrowserConfigured ? "unknown" : "not-configured",
  );

  const check = useCallback(async (force = false) => {
    if (!firebaseBrowserConfigured) {
      setState("not-configured");
      return;
    }
    setState("checking");
    setState(await cachedRequest(CACHE_KEY, probe, { ttlMs: CACHE_TTL_MS, force }));
  }, []);

  useEffect(() => {
    if (!firebaseBrowserConfigured) return;
    const cached = peekCache<AiState>(CACHE_KEY);
    if (cached) setState(cached);
    // Keep mounted pills in sync without spending inference quota on polling.
    return subscribe<AiState>(CACHE_KEY, setState);
  }, [check]);

  // A successful probe is evidence from the past, not permanent liveness.
  useEffect(() => {
    if (state !== "online" && state !== "unavailable") return;
    const timer = window.setTimeout(() => setState("unknown"), CACHE_TTL_MS);
    return () => window.clearTimeout(timer);
  }, [state]);

  return (
    <button
      type="button"
      onClick={() => void check(true)}
      title={state === "unavailable" ? "The AI service is unavailable — press to retry the check" : `Service status: ${LABEL[state]}`}
      aria-live="polite"
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[10.5px] font-medium uppercase tracking-[0.14em] transition-colors",
        state === "online" && "text-success",
        state === "unavailable" && "text-danger",
        (state === "checking" || state === "unknown") && "text-ink-3",
        state === "not-configured" && "text-warning",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "h-1.5 w-1.5 shrink-0 rounded-full",
          state === "online" && "bg-success",
          state === "unavailable" && "bg-danger",
          state === "checking" && "animate-pulse bg-ink-3",
          state === "not-configured" && "bg-warning",
        )}
      />
      {/* Its own box, so a tight row shortens the label with an ellipsis
          instead of cutting a letter in half. */}
      <span className="min-w-0 truncate">{LABEL[state]}</span>
    </button>
  );
}
