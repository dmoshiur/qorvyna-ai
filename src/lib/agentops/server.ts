// =============================================================================
// QORVYNA AI — AgentOps server bridge (server-only).
//
//   • Resolves the shared engine (Firestore-backed in production, in-memory in
//     dev/preview/tests) so the dashboard and the live chat share one source.
//   • Enforces authentication, ownership and admin authorization on every
//     sensitive operation.
//   • Applies human-in-the-loop governance control actions with immutable audit.
// =============================================================================

import "server-only";
import crypto from "node:crypto";
import { adminConfigured, adminDb, type Db } from "@/lib/firebase/admin";
import type { SessionUser } from "@/lib/firebase/session";
import { getApiSessionUser } from "@/lib/firebase/device-session";
import { decideToolApproval } from "@/lib/server/tool-approvals";
import type { CollaborationEvent } from "@/lib/ai/orchestrator/run";
import { AgentOpsEngine, type AgentOpsStorage } from "./index";
import { FirestoreAgentOpsStorage } from "./firestore-storage";
import {
  applyGovernanceAction,
  GovernanceError,
  scrubSecrets,
} from "./governance";
import type {
  AgentOpsEvent,
  AuditEntry,
  ExecutionOutcome,
  ExecutionRecord,
  GovernanceAction,
} from "./types";

/** HTTP-friendly error for route handlers. */
export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

let serverEngine: AgentOpsEngine | null = null;

export function safeAdminDb(): Db | null {
  try {
    return adminConfigured() ? adminDb() : null;
  } catch {
    return null;
  }
}

/** One engine for the whole server process (chat writes + dashboard reads). */
export function getServerAgentOps(): AgentOpsEngine {
  if (!serverEngine) {
    const db = safeAdminDb();
    const storage = db ? new FirestoreAgentOpsStorage(db) : undefined;
    serverEngine = new AgentOpsEngine(storage);
  }
  return serverEngine;
}

export function resetServerAgentOpsForTests(storage?: AgentOpsStorage): AgentOpsEngine {
  serverEngine = new AgentOpsEngine(storage);
  return serverEngine;
}

/** Get the signed-in user or throw 401. */
export async function requireUser(request?: Request): Promise<SessionUser> {
  const user = await getApiSessionUser(request);
  if (!user) throw new HttpError(401, "UNAUTHENTICATED", "Sign in to access AgentOps.");
  return user;
}

/** Authorized operators: the execution owner, or any platform admin. */
export async function isPlatformAdmin(d: Db | null, uid: string): Promise<boolean> {
  if (!d) return false;
  try {
    const snap = await d.collection("admin_role_assignments").doc(uid).get();
    return snap.exists;
  } catch {
    return false;
  }
}

export async function requireOperatorForExecution(
  request: Request,
  executionId: string,
  dbOverride?: Db | null,
): Promise<{ user: SessionUser; record: ExecutionRecord; db: Db | null }> {
  const user = await requireUser(request);
  const db = dbOverride !== undefined ? dbOverride : safeAdminDb();
  const engine = getServerAgentOps();
  const record = await engine.getExecution(executionId);
  if (!record) throw new HttpError(404, "NOT_FOUND", "Execution not found.");
  const owner = record.userId === user.uid;
  const admin = await isPlatformAdmin(db, user.uid);
  if (!owner && !admin) {
    throw new HttpError(403, "FORBIDDEN", "You are not authorized to control this execution.");
  }
  return { user, record, db };
}

// --- write helpers used by the chat/agent routes (fire-and-forget safe) ------

export async function agentOpsStart(input: {
  executionId?: string;
  requestId?: string;
  userId?: string;
  conversationId?: string;
  mode: string;
  modelPool: string[];
}): Promise<string> {
  try {
    return await getServerAgentOps().start(input);
  } catch {
    return input.executionId ?? newExecutionId();
  }
}

export async function agentOpsHandle(events: AgentOpsEvent | AgentOpsEvent[]): Promise<void> {
  const engine = getServerAgentOps();
  const list = Array.isArray(events) ? events : [events];
  for (const event of list) {
    await engine.handle(event).catch(() => {});
  }
}

/**
 * Finalize a chat/agent execution so it becomes terminal ("completed",
 * "failed" or "circuit_open"). Without this call an execution is started and
 * instrumented but never closed, so it stays "running" forever and is never
 * counted in the Live Monitor / economics dashboards — the P0-1 gap where the
 * flagship dashboard records nothing. Fire-and-forget safe.
 */
export async function agentOpsEnd(input: {
  executionId: string;
  outcome: ExecutionOutcome;
  status?: ExecutionRecord["status"];
}): Promise<void> {
  try {
    await getServerAgentOps().end(input.executionId, input.outcome, input.status);
  } catch {
    /* telemetry must never break the chat response */
  }
}

export function agentOpsComposeOnEvent(
  executionId: string,
  original?: (event: CollaborationEvent) => void,
  signal?: { abort: () => void },
): (event: CollaborationEvent) => void {
  return getServerAgentOps().composeOnEvent(executionId, original, signal);
}

// --- governance control -------------------------------------------------------

/**
 * Apply a governance action and persist both the updated record and an immutable
 * audit entry. Authorization is enforced by the caller (requireOperator...).
 */
export async function applyControl(
  db: Db | null,
  record: ExecutionRecord,
  user: SessionUser,
  action: GovernanceAction,
): Promise<ExecutionRecord> {
  let effect;
  try {
    effect = applyGovernanceAction(record, action);
  } catch (error) {
    if (error instanceof GovernanceError) throw new HttpError(409, error.code, error.message);
    throw new HttpError(400, "BAD_REQUEST", error instanceof Error ? error.message : "Invalid control action.");
  }
  const engine = getServerAgentOps();
  const storage = engine.getStorage();

  // Persist controlled working-memory mutation (protected targets already rejected by applyGovernanceAction).
  if (action.kind === "edit_memory") {
    const cleanTarget = action.target.trim().slice(0, 80);
    if (action.operation === "delete") {
      await storage.deleteMemory(record.executionId, cleanTarget).catch(() => {});
    } else {
      const cleanContent = scrubSecrets(action.content ?? "").slice(0, 4000);
      if (action.operation === "append") {
        const existing = await storage.listMemory(record.executionId).catch(() => []);
        const prev = existing.find((m) => m.target === cleanTarget)?.content ?? "";
        const next = prev ? `${prev}\n${cleanContent}` : cleanContent;
        await storage.putMemory({
          executionId: record.executionId,
          target: cleanTarget,
          content: next.slice(0, 8000),
          updatedBy: user.uid,
          updatedAt: Date.now(),
        }).catch(() => {});
      } else {
        await storage.putMemory({
          executionId: record.executionId,
          target: cleanTarget,
          content: cleanContent,
          updatedBy: user.uid,
          updatedAt: Date.now(),
        }).catch(() => {});
      }
    }
  }

  // Sync tool approval decision with the underlying tool_approvals store when present.
  if ((action.kind === "approve" || action.kind === "reject") && db) {
    await decideToolApproval(db, user, action.approvalId, action.kind === "approve").catch(() => {});
  }

  engine.setRecord(effect.record);
  await engine.persistRecord(effect.record);
  const auditEntry: AuditEntry = effect.audit;
  await storage.appendAudit(auditEntry).catch(() => {});
  if (db) await writeAuditLog(db, user, auditEntry).catch(() => {});
  return effect.record;
}

/** Mirror governance decisions into the existing audit_logs collection. */
async function writeAuditLog(db: Db, user: SessionUser, entry: AuditEntry): Promise<void> {
  try {
    await db.collection("audit_logs").add({
      actor_id: user.uid,
      action: entry.action,
      target_type: "agentops_execution",
      target_id: entry.executionId,
      reason: entry.detail.slice(0, 300),
      metadata: { agentops: true, entry_id: entry.entryId, immutable: true },
      created_at: new Date(entry.at),
    });
  } catch {
    /* best-effort */
  }
}

export function newExecutionId(): string {
  return `exec_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
}
