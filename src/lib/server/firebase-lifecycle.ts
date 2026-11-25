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

export type CollectionProbe = {
  collection: string;
  reachable: boolean;
  sampleCount: number;
  cappedAt: number;
  expiredInSample?: number;
};

export type LifecycleSnapshot = {
  checkedAt: string;
  collections: CollectionProbe[];
  maintenanceWorker: {
    lastRunAt: string | null;
    errors: string[];
  };
  backupVerification: {
    verified: boolean;
    lastVerifiedAt: string | null;
    manifestId: string | null;
    targetEnvironment: string | null;
    note: string;
  };
};

const SAMPLE_CAP = 50;

export async function inspectFirebaseLifecycle(db: Db, now = Date.now()): Promise<LifecycleSnapshot> {
  const canonical = [
    { name: "profiles", ttlField: null },
    { name: "conversations", ttlField: null },
    { name: "projects", ttlField: null },
    { name: "agent_tasks", ttlField: null },
    { name: "execution_sessions", ttlField: "heartbeat_at" },
    { name: "tool_approvals", ttlField: "expires_at" },
    { name: "provider_quota_windows", ttlField: "expire_at" },
    { name: "agentops_executions", ttlField: null },
    { name: "agentops_audit", ttlField: null },
  ] as const;

  const collections: CollectionProbe[] = [];
  for (const item of canonical) {
    try {
      const snap = await db.collection(item.name).limit(SAMPLE_CAP).get();
      let expiredInSample: number | undefined;
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
        reachable: true,
        sampleCount: snap.docs.length,
        cappedAt: SAMPLE_CAP,
        ...(expiredInSample !== undefined ? { expiredInSample } : {}),
      });
    } catch {
      collections.push({
        collection: item.name,
        reachable: false,
        sampleCount: 0,
        cappedAt: SAMPLE_CAP,
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

  let backupVerification: LifecycleSnapshot["backupVerification"] = {
    verified: false,
    lastVerifiedAt: null,
    manifestId: null,
    targetEnvironment: null,
    note: "No verified staging restore drill recorded yet. Follow docs/BACKUP_AND_RECOVERY.md.",
  };
  try {
    const bk = await db.collection("system_settings").doc("backup_verification").get();
    if (bk.exists) {
      const d = bk.data()!;
      backupVerification = {
        verified: Boolean(d.verified),
        lastVerifiedAt: d.verified_at?.toDate?.()?.toISOString?.() ?? (typeof d.verified_at === "string" ? d.verified_at : null),
        manifestId: typeof d.manifest_id === "string" ? d.manifest_id : null,
        targetEnvironment: typeof d.target_environment === "string" ? d.target_environment : null,
        note: typeof d.note === "string" ? d.note : backupVerification.note,
      };
    }
  } catch {
    /* best-effort */
  }

  return {
    checkedAt: new Date(now).toISOString(),
    collections,
    maintenanceWorker: { lastRunAt, errors: workerErrors },
    backupVerification,
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
