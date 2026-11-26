// =============================================================================
// QORVYNA AI — Firebase Lifecycle Monitoring & Backup Verification (server-only).
//
//   • Bounded collection probes (never scans full collections — max 50 docs per
//     sample) to inspect database liveness, ephemeral TTL backlogs, and
//     maintenance worker freshness.
//   • Cryptographic SHA-256 verification of backup manifests for staging
//     recovery drills without ever claiming an unrun cloud backup succeeded.
// =============================================================================

import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { nowTs, type Db } from "@/lib/firebase/admin";

export type CollectionLifecycle = {
  collection: string;
  category: string;
  retentionPolicy: string;
  sampledCount: number;
  sampleCapped: boolean;
  staleSampledCount: number;
  reachable: boolean;
};

export type LifecycleSnapshot = {
  generatedAt: string;
  collections: CollectionLifecycle[];
  maintenanceWorker: {
    lastRunAt: string | null;
    healthy: boolean;
    errors: string[];
  };
  lastVerifiedBackup: {
    manifestId: string;
    verifiedAt: string;
    verifiedBy: string;
    collectionCount: number;
    sha256: string;
  } | null;
};

const SAMPLE_CAP = 50;

export async function inspectFirebaseLifecycle(db: Db, now = Date.now()): Promise<LifecycleSnapshot> {
  // Each entry carries the governance metadata the admin UI renders (review P0-4):
  // the table must show a real Category / Retention Policy per collection rather
  // than blank cells.
  const canonical = [
    { name: "profiles", ttlField: null, category: "Account", retentionPolicy: "Retained until account deletion" },
    { name: "conversations", ttlField: null, category: "Conversation", retentionPolicy: "Active 90 days, then pruned" },
    { name: "projects", ttlField: null, category: "Generated project", retentionPolicy: "Retained until owner deletes" },
    { name: "agent_tasks", ttlField: null, category: "Agent task", retentionPolicy: "30-day active window" },
    { name: "execution_sessions", ttlField: "heartbeat_at", category: "Observability", retentionPolicy: "Heartbeat TTL · 30-day expiry" },
    { name: "tool_approvals", ttlField: "expires_at", category: "Governance", retentionPolicy: "Approval expires in 24h" },
    { name: "provider_quota_windows", ttlField: "expire_at", category: "Quota", retentionPolicy: "Sliding hourly window" },
    { name: "agentops_executions", ttlField: null, category: "Observability", retentionPolicy: "30-day AgentOps retention" },
    { name: "agentops_audit", ttlField: null, category: "Audit", retentionPolicy: "Immutable · 1-year retention" },
  ] as const;

  const collections: CollectionLifecycle[] = [];
  for (const item of canonical) {
    try {
      const snap = await db.collection(item.name).limit(SAMPLE_CAP).get();
      let expiredInSample = 0;
      if (item.ttlField) {
        expiredInSample = snap.docs.filter((doc) => {
          const val = doc.data()?.[item.ttlField];
          if (typeof val === "number") return val > 0 && val < now;
          if (val && typeof val.toMillis === "function") return val.toMillis() < now;
          if (val instanceof Date) return val.getTime() < now;
          return false;
        }).length;
      }
      collections.push({
        collection: item.name,
        category: item.category,
        retentionPolicy: item.retentionPolicy,
        sampledCount: snap.docs.length,
        sampleCapped: snap.docs.length >= SAMPLE_CAP,
        staleSampledCount: expiredInSample,
        reachable: true,
      });
    } catch {
      collections.push({
        collection: item.name,
        category: item.category,
        retentionPolicy: item.retentionPolicy,
        sampledCount: 0,
        sampleCapped: false,
        staleSampledCount: 0,
        reachable: false,
      });
    }
  }

  let lastRunAt: string | null = null;
  let workerErrors: string[] = [];
  try {
    const maint = await db.collection("system_settings").doc("maintenance_worker").get();
    if (maint.exists) {
      const d = maint.data()!;
      lastRunAt = d.last_run_at?.toDate?.()?.toISOString?.() ?? (typeof d.last_run_at === "string" ? d.last_run_at : null);
      workerErrors = Array.isArray(d.errors) ? d.errors.map(String) : [];
    }
  } catch {
    /* best-effort */
  }
  // The worker is "healthy" only when it has reported recently and without
  // errors; otherwise the UI surfaces a "Needs Cron Check" state instead of a
  // misleading green badge (review P0-4).
  const workerHealthy =
    lastRunAt !== null &&
    workerErrors.length === 0 &&
    Date.now() - new Date(lastRunAt).getTime() <= 48 * 3_600_000;

  let lastVerifiedBackup: LifecycleSnapshot["lastVerifiedBackup"] = null;
  try {
    const bk = await db.collection("system_settings").doc("backup_verification").get();
    if (bk.exists) {
      const d = bk.data()!;
      if (d.verified) {
        lastVerifiedBackup = {
          manifestId: typeof d.manifest_id === "string" ? d.manifest_id : "unknown",
          verifiedAt:
            d.verified_at?.toDate?.()?.toISOString?.() ?? (typeof d.verified_at === "string" ? d.verified_at : ""),
          verifiedBy: typeof d.verified_by === "string" ? d.verified_by : "unknown",
          collectionCount:
            d.collections && typeof d.collections === "object" ? Object.keys(d.collections).length : 0,
          sha256: typeof d.sha256 === "string" ? d.sha256 : "",
        };
      }
    }
  } catch {
    /* best-effort */
  }

  return {
    generatedAt: new Date(now).toISOString(),
    collections,
    maintenanceWorker: { lastRunAt, healthy: workerHealthy, errors: workerErrors },
    lastVerifiedBackup,
  };
}

export const backupManifestSchema = z.object({
  manifestId: z.string().min(4).max(120),
  projectId: z.string().min(2).max(120),
  exportedAt: z.string().min(10).max(60),
  targetEnvironment: z.enum(["staging", "local_dr", "isolated_restore"]),
  collections: z.record(z.string(), z.number().int().min(0)),
  expectedSha256: z.string().regex(/^[a-f0-9]{64}$/i),
});

export type BackupManifestInput = z.infer<typeof backupManifestSchema>;

/** Compute canonical SHA-256 of the backup manifest's collection inventory. */
export function computeBackupInventoryDigest(input: {
  manifestId: string;
  projectId: string;
  exportedAt: string;
  collections: Record<string, number>;
}): string {
  const ordered = Object.keys(input.collections)
    .sort()
    .map((k) => `${k}:${input.collections[k]}`)
    .join("|");
  const payload = `${input.manifestId}\n${input.projectId}\n${input.exportedAt}\n${ordered}`;
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

export function verifyBackupManifest(raw: unknown): {
  valid: boolean;
  computedSha256: string | null;
  reason: string;
  manifest?: BackupManifestInput;
} {
  const parsed = backupManifestSchema.safeParse(raw);
  if (!parsed.success) {
    return { valid: false, computedSha256: null, reason: "MANIFEST_SCHEMA_INVALID" };
  }
  const m = parsed.data;
  const computed = computeBackupInventoryDigest(m);
  if (computed.toLowerCase() !== m.expectedSha256.toLowerCase()) {
    return { valid: false, computedSha256: computed, reason: "MANIFEST_DIGEST_MISMATCH" };
  }
  if (Object.keys(m.collections).length === 0) {
    return { valid: false, computedSha256: computed, reason: "MANIFEST_EMPTY_COLLECTIONS" };
  }
  return { valid: true, computedSha256: computed, reason: "VERIFIED", manifest: m };
}

export async function recordVerifiedBackupDrill(
  db: Db,
  actorId: string,
  raw: unknown,
): Promise<{ valid: boolean; computedSha256: string | null; reason: string }> {
  const check = verifyBackupManifest(raw);
  if (!check.valid || !check.manifest) return check;
  const m = check.manifest;
  await db
    .collection("system_settings")
    .doc("backup_verification")
    .set(
      {
        verified: true,
        manifest_id: m.manifestId,
        project_id: m.projectId,
        exported_at: m.exportedAt,
        target_environment: m.targetEnvironment,
        collections: m.collections,
        sha256: check.computedSha256,
        verified_by: actorId,
        verified_at: nowTs(),
        note: `Verified manifest ${m.manifestId} against ${m.targetEnvironment} (${Object.keys(m.collections).length} collections).`,
      },
      { merge: true },
    );
  await db.collection("audit_logs").add({
    actor_id: actorId,
    action: "backup.drill_verified",
    target_type: "backup_manifest",
    target_id: m.manifestId,
    reason: `Staging restore manifest verified (${m.targetEnvironment})`,
    metadata: { sha256: check.computedSha256, collections: m.collections },
    created_at: nowTs(),
  });
  return { valid: true, computedSha256: check.computedSha256, reason: "VERIFIED" };
}
