"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { Activity, Plug, Terminal } from "lucide-react";
import { Badge, Card } from "@/components/ui";

interface ConnectorDescriptor {
  id: string;
  label: string;
  provider: string;
  transport: string;
  operations: string[];
  status: "ready" | "disabled" | "not_connected" | "not_configured";
  detail: string;
  lastVerifiedAt: string | null;
}

export function McpConnectorsPanel() {
  const [connectors, setConnectors] = useState<ConnectorDescriptor[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let active = true;
    fetch("/api/mcp/connectors", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { connectors: [] }))
      .then((d) => {
        if (active) {
          setConnectors(Array.isArray(d.connectors) ? d.connectors : []);
          setLoaded(true);
        }
      })
      .catch(() => {
        if (active) setLoaded(true);
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="mx-auto max-w-6xl space-y-4 px-4 pb-8 md:px-6">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card className="p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-sky-400" />
              <h2 className="text-sm font-semibold">CloudCampBD AgentOps Control Center</h2>
            </div>
            <Badge tone="accent">Live Telemetry</Badge>
          </div>
          <p className="mt-1.5 text-xs text-[var(--fg-muted)]">
            Inspect live agent execution graphs, intelligent circuit-breaker states, Human-in-the-Loop approvals, OpenTelemetry spans, and provider token economics.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Link
              href="/agentops"
              className="inline-flex items-center gap-1.5 rounded-lg bg-sky-500/15 px-3 py-1.5 text-xs font-medium text-sky-300 hover:bg-sky-500/25"
            >
              <Activity className="h-3.5 w-3.5" />
              Open AgentOps Control Center
            </Link>
            <Link
              href="/terminal"
              className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-medium hover:bg-[var(--bg-subtle)]"
            >
              <Terminal className="h-3.5 w-3.5 text-emerald-400" />
              Open AI Terminal &amp; Coding Workspace
            </Link>
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Plug className="h-4 w-4 text-violet-400" />
              <h2 className="text-sm font-semibold">Governed MCP Connectors</h2>
            </div>
            <Badge tone="neutral">{loaded ? `${connectors.length} registered` : "Loading…"}</Badge>
          </div>
          <div className="mt-2.5 space-y-2">
            {connectors.map((c) => (
              <div
                key={c.id}
                className="flex items-start justify-between gap-2 rounded-md border border-[var(--border)] p-2 text-xs"
              >
                <div className="min-w-0">
                  <div className="font-medium">{c.label}</div>
                  <div className="text-[11px] text-[var(--fg-muted)]">{c.detail}</div>
                  {c.lastVerifiedAt ? (
                    <div className="mt-0.5 text-[10.5px] text-[var(--fg-muted)]">
                      verified {new Date(c.lastVerifiedAt).toLocaleString()}
                    </div>
                  ) : null}
                </div>
                <Badge
                  tone={
                    c.status === "ready"
                      ? "success"
                      : c.status === "not_connected" || c.status === "disabled"
                        ? "warning"
                        : "neutral"
                  }
                >
                  {c.status === "ready"
                    ? "ready"
                    : c.status === "not_connected"
                      ? "needs connection"
                      : c.status === "disabled"
                        ? "disabled"
                        : "not configured"}
                </Badge>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
