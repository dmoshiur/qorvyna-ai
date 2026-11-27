// =============================================================================
// QORVYNA AI — Human-in-the-Loop Governance (pure logic, fully testable).
//
// Authorized operators may pause, resume, cancel, approve/reject pending tool
// calls, review dangerous actions, edit permitted agent memory through
// controlled operations, override eligible decisions, and inspect history.
//
// Hard guarantees:
//   • Never modifies protected memory (system instructions / credentials).
//   • Never silently destroys user data or permanently disables an agent.
//   • Every decision is written to an IMMUTABLE audit log.
//   • Authorization (ownership / operator role) is enforced by the API layer;
//     this module enforces the state machine and produces auditable effects.
// =============================================================================

import crypto from "node:crypto";
import type {
  AuditEntry,
  ExecutionRecord,
  GovernanceAction,
  TransitionEvent,
} from "./types";

/** Memory targets that operators may NEVER edit through this control plane. */
export const PROTECTED_MEMORY_TARGETS = new Set([
  "system_instructions",
  "system_instruction",
  "system_prompt",
  "credentials",
  "credential",
  "secrets",
  "secret",
  "api_keys",
  "api_key",
  "password",
  "passwords",
  "access_token",
  "refresh_token",
  "private_key",
]);

/** Keys whose values are scrubbed before any audit/record persistence. */
const SECRET_KEY_RE = /(key|token|secret|password|passwd|credential|authorization|cookie|session)/i;

export function scrubSecrets(text: string): string {
  if (!text) return text;
  return text
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gi, "<redacted-private-key>")
    .replace(/"([^"]*?(?:key|token|secret|password|passwd|credential|authorization|cookie)[^"]*?)":\s*"[^"]{3,}"/gi, (_m, key) => `"${key}": "<redacted>"`)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer <redacted>")
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|gsk_[A-Za-z0-9_-]{12,}|AIza[0-9A-Za-z_-]{20,}|AQ\.Ab[A-Za-z0-9_-]{40,56}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g, "<redacted>");
}

export function containsSecretField(target: string, content?: string): boolean {
  if (PROTECTED_MEMORY_TARGETS.has(target.toLowerCase())) return true;
  if (SECRET_KEY_RE.test(target)) return true;
  if (content && /\b(sk-[A-Za-z0-9]{8,}|AIza[0-9A-Za-z_-]{20,}|AQ\.Ab[A-Za-z0-9_-]{40,56}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/.test(content)) {
    return true;
  }
  return false;
}

export class GovernanceError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "GovernanceError";
  }
}

export type GovernanceEffect = {
  record: ExecutionRecord;
  audit: AuditEntry;
  transition?: TransitionEvent;
};

function audit(record: ExecutionRecord, actorId: string, action: string, detail: string): AuditEntry {
  return {
    entryId: `aud_${crypto.randomBytes(6).toString("hex")}`,
    executionId: record.executionId,
    actorId,
    action,
    detail: scrubSecrets(detail).slice(0, 500),
    at: Date.now(),
    immutable: true,
  };
}

function transition(record: ExecutionRecord, to: ExecutionRecord["status"], reason?: string, operatorId?: string): TransitionEvent {
  const from = record.status;
  record.status = to;
  const t: TransitionEvent = { from, to, at: Date.now(), reason };
  if (operatorId) t.operatorId = operatorId;
  record.transitions.push(t);
  return t;
}

/** Apply a single governance action to a copy of the record. */
export function applyGovernanceAction(input: ExecutionRecord, action: GovernanceAction): GovernanceEffect {
  const record: ExecutionRecord = structuredClone(input);
  switch (action.kind) {
    case "pause": {
      if (!["running", "awaiting_approval", "recovered"].includes(record.status)) {
        throw new GovernanceError("INVALID_STATE", `Cannot pause execution in state ${record.status}`);
      }
      const t = transition(record, "paused", action.reason ?? "operator pause", action.operatorId);
      const a = audit(record, action.operatorId, "governance.pause", `Paused by operator (${action.operatorId})${action.reason ? `: ${action.reason}` : ""}`);
      return { record, audit: a, transition: t };
    }
    case "resume": {
      if (record.status !== "paused") {
        throw new GovernanceError("INVALID_STATE", `Cannot resume execution in state ${record.status}`);
      }
      const t = transition(record, "running", action.reason ?? "operator resume", action.operatorId);
      const a = audit(record, action.operatorId, "governance.resume", `Resumed by operator (${action.operatorId})`);
      return { record, audit: a, transition: t };
    }
    case "cancel": {
      if (["completed", "failed", "cancelled", "circuit_open"].includes(record.status)) {
        throw new GovernanceError("INVALID_STATE", `Cannot cancel execution in state ${record.status}`);
      }
      const t = transition(record, "cancelled", action.reason ?? "operator cancel", action.operatorId);
      record.endedAt = Date.now();
      if (record.totalDurationMs == null) record.totalDurationMs = record.endedAt - record.startedAt;
      const a = audit(record, action.operatorId, "governance.cancel", `Cancelled by operator (${action.operatorId})`);
      return { record, audit: a, transition: t };
    }
    case "approve":
    case "reject": {
      const pending = record.pendingApprovals.find((p) => p.approvalId === action.approvalId && p.status === "pending");
      if (!pending) {
        throw new GovernanceError("APPROVAL_NOT_FOUND", `No pending approval ${action.approvalId} on this execution`);
      }
      pending.status = action.kind === "approve" ? "approved" : "rejected";
      pending.decidedAt = Date.now();
      pending.decidedBy = action.operatorId;
      const verb = action.kind === "approve" ? "approved" : "rejected";
      const a = audit(
        record,
        action.operatorId,
        `governance.approval.${verb}`,
        `Tool "${pending.toolId}" (risk ${pending.risk}) ${verb} by operator (${action.operatorId})`,
      );
      // Approving a pending tool call returns the execution to running.
      let t: TransitionEvent | undefined;
      if (action.kind === "approve" && record.status === "awaiting_approval") {
        t = transition(record, "running", "approval granted", action.operatorId);
      }
      return { record, audit: a, transition: t };
    }
    case "edit_memory": {
      if (containsSecretField(action.target, action.content)) {
        throw new GovernanceError("PROTECTED_MEMORY", `Refusing to edit protected memory target "${action.target}"`);
      }
      const a = audit(
        record,
        action.operatorId,
        "governance.edit_memory",
        `Memory ${action.operation} on "${action.target}" by operator (${action.operatorId})${action.reason ? `: ${action.reason}` : ""}`,
      );
      record.tags = Array.from(new Set([...record.tags, `memory:${action.operation}:${action.target}`]));
      return { record, audit: a };
    }
    case "override": {
      record.guard.operatorOverride = { by: action.operatorId, at: Date.now(), note: action.reason };
      record.guard.open = false;
      record.guard.cooldownUntil = undefined;
      const a = audit(record, action.operatorId, "governance.override", `Operator override: ${action.decision}${action.reason ? ` — ${action.reason}` : ""}`);
      return { record, audit: a };
    }
    default: {
      const _exhaustive: never = action;
      throw new GovernanceError("UNKNOWN_ACTION", `Unknown governance action: ${(_exhaustive as { kind: string }).kind}`);
    }
  }
}

/**
 * Convenience: raise a pending approval on an execution (called by the tool
 * gateway when a risky tool needs human sign-off). The execution's status is
 * moved to awaiting_approval only if currently running.
 */
export function raiseApproval(
  input: ExecutionRecord,
  approvalId: string,
  toolId: string,
  agentId: string,
  risk: string,
): { record: ExecutionRecord; audit: AuditEntry } {
  const record: ExecutionRecord = structuredClone(input);
  const existing = record.pendingApprovals.find((p) => p.approvalId === approvalId);
  if (!existing) {
    record.pendingApprovals.push({
      approvalId,
      toolId,
      agentId,
      risk,
      raisedAt: Date.now(),
      status: "pending",
    });
  }
  let t: TransitionEvent | undefined;
  if (record.status === "running") {
    t = transition(record, "awaiting_approval", "tool approval required", undefined);
  }
  void t;
  const a = audit(record, agentId, "governance.approval.raised", `Approval required for tool "${toolId}" (risk ${risk})`);
  return { record, audit: a };
}
