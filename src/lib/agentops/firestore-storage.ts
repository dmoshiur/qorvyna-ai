// =============================================================================
// QORVYNA AI — Firestore-backed AgentOps storage (server-only).
//
// Used in production when Firebase Admin is configured. Falls back to the
// in-memory store (see storage.ts) when Admin is unavailable so the engine
// always works (dev, tests, local preview). All writes are best-effort and
// never throw into the caller's request path.
// =============================================================================

import "server-only";
import { adminDb, type Db } from "@/lib/firebase/admin";
import type {
  AgentOpsStorage,
  ExecutionFilter,
} from "./storage";
import type {
  AgentOpsEvent,
  AuditEntry,
  ControlledMemoryEntry,
  EvaluationDataset,
  EvaluationRun,
  ExecutionRecord,
  Span,
} from "./types";

const COL_EXEC = "agentops_executions";
const COL_AUDIT = "agentops_audit";
const COL_SPANS = "agentops_spans";
const COL_DATASETS = "agentops_datasets";
const COL_RUNS = "agentops_runs";
const COL_MEMORY = "agentops_memory";

export class FirestoreAgentOpsStorage implements AgentOpsStorage {
  constructor(private db: Db = adminDb()) {}

  async recordEvent(_event: AgentOpsEvent): Promise<void> {
    // Folding happens in the engine; the persisted record is written via putExecution.
    return;
  }

  async putExecution(record: ExecutionRecord): Promise<void> {
    try {
      await this.db
        .collection(COL_EXEC)
        .doc(record.executionId)
        .set(
          {
            ...record,
            // keep arrays bounded in the doc
            steps: record.steps.slice(-200),
            toolCalls: record.toolCalls.slice(-200),
            loops: record.loops.slice(-100),
            circuitEvents: record.circuitEvents.slice(-100),
            errors: record.errors.slice(-100),
            recoveries: record.recoveries.slice(-100),
            transitions: record.transitions.slice(-100),
            agents: record.agents.slice(-100),
          },
          { merge: true },
        );
    } catch (error) {
      console.warn("[QORVYNA AgentOps] putExecution failed", error instanceof Error ? error.message : String(error));
    }
  }

  async getExecution(executionId: string): Promise<ExecutionRecord | null> {
    try {
      const snap = await this.db.collection(COL_EXEC).doc(executionId).get();
      return snap.exists ? (snap.data() as ExecutionRecord) : null;
    } catch {
      return null;
    }
  }

  async listExecutions(filter: ExecutionFilter = {}): Promise<ExecutionRecord[]> {
    try {
      let query: FirebaseFirestore.Query = this.db.collection(COL_EXEC);
      if (filter.userId) query = query.where("userId", "==", filter.userId);
      if (filter.conversationId) query = query.where("conversationId", "==", filter.conversationId);
      if (filter.status) query = query.where("status", "==", filter.status);
      if (filter.mode) query = query.where("mode", "==", filter.mode);
      if (filter.since) query = query.where("startedAt", ">=", filter.since);
      const limit = filter.limit ?? 50;
      const snap = await query.orderBy("startedAt", "desc").limit(Math.max(1, limit)).get();
      return snap.docs.map((d) => d.data() as ExecutionRecord);
    } catch (error) {
      console.warn("[QORVYNA AgentOps] listExecutions failed", error instanceof Error ? error.message : String(error));
      return [];
    }
  }

  async deleteExecution(executionId: string): Promise<void> {
    try {
      await this.db.collection(COL_EXEC).doc(executionId).delete();
    } catch {
      /* best-effort */
    }
  }

  async appendAudit(entry: AuditEntry): Promise<void> {
    try {
      await this.db.collection(COL_AUDIT).add(entry);
    } catch {
      /* best-effort */
    }
  }

  async listAudit(executionId: string, limit = 200): Promise<AuditEntry[]> {
    try {
      const snap = await this.db
        .collection(COL_AUDIT)
        .where("executionId", "==", executionId)
        .orderBy("at", "desc")
        .limit(limit)
        .get();
      return snap.docs.map((d) => d.data() as AuditEntry);
    } catch {
      return [];
    }
  }

  async appendSpan(span: Span): Promise<void> {
    try {
      await this.db
        .collection(COL_SPANS)
        .doc(`${span.traceId}_${span.spanId}`)
        .set(span, { merge: true });
    } catch {
      /* best-effort */
    }
  }

  async listSpans(traceId: string, limit = 500): Promise<Span[]> {
    try {
      const snap = await this.db
        .collection(COL_SPANS)
        .where("traceId", "==", traceId)
        .orderBy("startTime", "asc")
        .limit(limit)
        .get();
      return snap.docs.map((d) => d.data() as Span);
    } catch {
      return [];
    }
  }

  async listTraces(limit = 200): Promise<Span[]> {
    try {
      const snap = await this.db.collection(COL_SPANS).orderBy("startTime", "desc").limit(limit).get();
      return snap.docs.map((d) => d.data() as Span);
    } catch {
      return [];
    }
  }

  async putDataset(dataset: EvaluationDataset): Promise<void> {
    try {
      await this.db.collection(COL_DATASETS).doc(dataset.id).set(dataset, { merge: true });
    } catch {
      /* best-effort */
    }
  }

  async getDataset(id: string): Promise<EvaluationDataset | null> {
    try {
      const snap = await this.db.collection(COL_DATASETS).doc(id).get();
      return snap.exists ? (snap.data() as EvaluationDataset) : null;
    } catch {
      return null;
    }
  }

  async listDatasets(): Promise<EvaluationDataset[]> {
    try {
      const snap = await this.db.collection(COL_DATASETS).orderBy("createdAt", "desc").get();
      return snap.docs.map((d) => d.data() as EvaluationDataset);
    } catch {
      return [];
    }
  }

  async putRun(run: EvaluationRun): Promise<void> {
    try {
      await this.db.collection(COL_RUNS).doc(run.id).set(run, { merge: true });
    } catch {
      /* best-effort */
    }
  }

  async getRun(id: string): Promise<EvaluationRun | null> {
    try {
      const snap = await this.db.collection(COL_RUNS).doc(id).get();
      return snap.exists ? (snap.data() as EvaluationRun) : null;
    } catch {
      return null;
    }
  }

  async listRuns(datasetId?: string): Promise<EvaluationRun[]> {
    try {
      let query: FirebaseFirestore.Query = this.db.collection(COL_RUNS);
      if (datasetId) query = query.where("datasetId", "==", datasetId);
      const snap = await query.orderBy("startedAt", "desc").get();
      return snap.docs.map((d) => d.data() as EvaluationRun);
    } catch {
      return [];
    }
  }

  async listMemory(executionId: string): Promise<ControlledMemoryEntry[]> {
    try {
      const snap = await this.db
        .collection(COL_MEMORY)
        .where("executionId", "==", executionId)
        .limit(100)
        .get();
      return snap.docs
        .map((d) => d.data() as ControlledMemoryEntry)
        .sort((a, b) => b.updatedAt - a.updatedAt);
    } catch {
      return [];
    }
  }

  async putMemory(entry: ControlledMemoryEntry): Promise<void> {
    try {
      await this.db
        .collection(COL_MEMORY)
        .doc(`${entry.executionId}__${entry.target}`)
        .set(entry, { merge: true });
    } catch {
      /* best-effort */
    }
  }

  async deleteMemory(executionId: string, target: string): Promise<void> {
    try {
      await this.db.collection(COL_MEMORY).doc(`${executionId}__${target}`).delete();
    } catch {
      /* best-effort */
    }
  }

  async pruneExpired(olderThanMs: number): Promise<number> {
    try {
      const cutoff = Date.now() - Math.max(0, olderThanMs);
      const snap = await this.db
        .collection(COL_EXEC)
        .where("startedAt", "<", cutoff)
        .limit(200)
        .get();
      let pruned = 0;
      for (const doc of snap.docs) {
        const data = doc.data() as ExecutionRecord;
        const terminal = ["completed", "failed", "cancelled", "circuit_open"].includes(data.status);
        if (terminal && (data.endedAt ?? data.startedAt) < cutoff) {
          await doc.ref.delete();
          pruned += 1;
        }
      }
      return pruned;
    } catch {
      return 0;
    }
  }
}
