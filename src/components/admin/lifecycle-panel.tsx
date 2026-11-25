"use client";

import React, { useCallback, useEffect, useState } from "react";
import { Database, RefreshCw, ShieldCheck } from "lucide-react";
import { Alert, Badge, Button, Card } from "@/components/ui";

interface LifecycleSnapshot {
  generatedAt: string;
  collections: Array<{
    collection: string;
    category: string;
    retentionPolicy: string;
    sampledCount: number;
    sampleCapped: boolean;
    staleSampledCount: number;
  }>;
  maintenanceWorker: {
    lastRunAt: string | null;
    healthy: boolean;
  };
  lastVerifiedBackup: {
    manifestId: string;
    verifiedAt: string;
    verifiedBy: string;
    collectionCount: number;
    sha256: string;
  } | null;
}

export function LifecycleAdminPanel() {
  const [snapshot, setSnapshot] = useState<LifecycleSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "info" | "success" | "warning" | "danger"; text: string } | null>(null);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/admin/lifecycle", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        setSnapshot(data.lifecycle ?? null);
      }
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runCleanup = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/lifecycle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cleanup_ephemeral" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Cleanup failed");
      setNotice({ tone: "success", text: "Executed bounded ephemeral session cleanup." });
      await refresh();
    } catch (err) {
      setNotice({ tone: "danger", text: err instanceof Error ? err.message : "Cleanup failed" });
    } finally {
      setBusy(false);
    }
  };

  if (!snapshot) return null;

  return (
    <Card className="mt-6 space-y-4 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Database className="h-4 w-4 text-sky-400" />
          <h3 className="text-sm font-semibold">
            Firebase Lifecycle, TTL Hygiene &amp; Backup Verification
          </h3>
          <Badge tone={snapshot.maintenanceWorker.healthy ? "success" : "warning"}>
            Worker: {snapshot.maintenanceWorker.healthy ? "Fresh" : "Needs Cron Check"}
          </Badge>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => void refresh()} disabled={busy}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            Refresh
          </Button>
          <Button variant="secondary" onClick={() => void runCleanup()} disabled={busy}>
            Prune Ephemeral Sessions
          </Button>
        </div>
      </div>

      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}

      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="border-b border-[var(--border)] text-[var(--fg-muted)]">
            <tr>
              <th className="py-2 pr-3">Collection</th>
              <th className="py-2 pr-3">Category</th>
              <th className="py-2 pr-3">Retention Policy</th>
              <th className="py-2 pr-3">Bounded Sample</th>
              <th className="py-2">Stale in Sample</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)]">
            {snapshot.collections.map((c) => (
              <tr key={c.collection}>
                <td className="py-2 pr-3 font-mono">{c.collection}</td>
                <td className="py-2 pr-3">{c.category}</td>
                <td className="py-2 pr-3 text-[var(--fg-muted)]">{c.retentionPolicy}</td>
                <td className="py-2 pr-3 font-mono">
                  {c.sampledCount}
                  {c.sampleCapped ? "+" : ""}
                </td>
                <td className="py-2 font-mono">{c.staleSampledCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between rounded-lg border border-[var(--border)] bg-[var(--bg-subtle)] p-3 text-xs">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-emerald-400" />
          <div>
            <div className="font-medium">Staging Backup &amp; Recovery Drill Status</div>
            <div className="text-[var(--fg-muted)]">
              {snapshot.lastVerifiedBackup
                ? `Verified manifest ${snapshot.lastVerifiedBackup.manifestId} (${snapshot.lastVerifiedBackup.collectionCount} collections · SHA-256 ${snapshot.lastVerifiedBackup.sha256.slice(0, 12)}…) at ${snapshot.lastVerifiedBackup.verifiedAt}`
                : "No verified staging restore manifest recorded yet. Run scripts/verify-backup.mjs and POST to /api/admin/lifecycle."}
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}
