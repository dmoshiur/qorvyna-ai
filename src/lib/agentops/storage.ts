// =============================================================================
// QORVYNA AI — AgentOps storage abstraction.
//
// The AgentOps engine persists everything through this interface so the core
// logic never depends on Firestore directly. A process-local in-memory store
// backs the engine by default and in tests; production uses the Firestore
// adapter (src/lib/agentops/firestore-storage.ts) when Admin is configured.
// =============================================================================

import type {
  AgentOpsEvent,
  AuditEntry,
  ControlledMemoryEntry,
  EvaluationDataset,
  EvaluationRun,
  ExecutionRecord,
  Span,
} from "./types";

/** Filter for listing executions. All fields optional. */
export type ExecutionFilter = {
  userId?: string;
  conversationId?: string;
  status?: string;
  mode?: string;
  since?: number;
  until?: number;
  limit?: number;
  cursor?: string;
};

export interface AgentOpsStorage {
  /** Persist an atomic runtime event and fold it into the live record. */
  recordEvent(event: AgentOpsEvent): Promise<void>;
  /** Upsert a full execution record (used by the engine after folding). */
  putExecution(record: ExecutionRecord): Promise<void>;
  getExecution(executionId: string): Promise<ExecutionRecord | null>;
  listExecutions(filter?: ExecutionFilter): Promise<ExecutionRecord[]>;
  deleteExecution(executionId: string): Promise<void>;

  /** Immutable audit log entries. */
  appendAudit(entry: AuditEntry): Promise<void>;
  listAudit(executionId: string, limit?: number): Promise<AuditEntry[]>;

  /** OpenTelemetry-compatible spans. */
  appendSpan(span: Span): Promise<void>;
  listSpans(traceId: string, limit?: number): Promise<Span[]>;
  listTraces(limit?: number): Promise<Span[]>;

  /** Evaluation datasets and runs. */
  putDataset(dataset: EvaluationDataset): Promise<void>;
  getDataset(id: string): Promise<EvaluationDataset | null>;
  listDatasets(): Promise<EvaluationDataset[]>;
  putRun(run: EvaluationRun): Promise<void>;
  getRun(id: string): Promise<EvaluationRun | null>;
  listRuns(datasetId?: string): Promise<EvaluationRun[]>;

  /** Controlled working memory & retention pruning. */
  listMemory(executionId: string): Promise<ControlledMemoryEntry[]>;
  putMemory(entry: ControlledMemoryEntry): Promise<void>;
  deleteMemory(executionId: string, target: string): Promise<void>;
  pruneExpired(olderThanMs: number): Promise<number>;
}

function emptyMetrics(): ExecutionRecord["metrics"] {
  return {
    totalTokensIn: 0,
    totalTokensOut: 0,
    totalTokens: 0,
    estimatedCostUsd: 0,
    costSource: "estimate",
    latencyMs: 0,
    toolCalls: 0,
    toolFailures: 0,
    retries: 0,
    errors: 0,
    loopsDetected: 0,
    circuitTrips: 0,
    stepsCompleted: 0,
    stepsFailed: 0,
    childAgents: 0,
    modelsUsed: [],
    providersUsed: [],
  };
}

export function emptyExecutionRecord(executionId: string): ExecutionRecord {
  return {
    executionId,
    mode: "unknown",
    modelPool: [],
    status: "queued",
    startedAt: Date.now(),
    agents: [],
    steps: [],
    toolCalls: [],
    pendingApprovals: [],
    loops: [],
    circuitEvents: [],
    transitions: [],
    errors: [],
    recoveries: [],
    retries: 0,
    usageByModel: {},
    metrics: emptyMetrics(),
    guard: {
      reasoningCycles: 0,
      repeatedToolSignatures: {},
      recursionDepth: 0,
      retries: 0,
      providerFailures: 0,
      consecutiveProviderFailures: 0,
      tokensConsumed: 0,
      open: false,
      triggered: [],
    },
    tags: [],
  };
}

/**
 * Process-local store. Suitable for dev, tests, and serverless warm pools.
 * Not durable across processes — production deployments should configure
 * Firestore (see firestore-storage.ts). Bounds memory with a max capacity.
 */
export class InMemoryAgentOpsStorage implements AgentOpsStorage {
  private executions = new Map<string, ExecutionRecord>();
  private audit = new Map<string, AuditEntry[]>();
  private spans = new Map<string, Span[]>();
  private datasets = new Map<string, EvaluationDataset>();
  private runs = new Map<string, EvaluationRun>();
  private memory = new Map<string, Map<string, ControlledMemoryEntry>>();
  private maxExecutions: number;

  constructor(maxExecutions = 1000) {
    this.maxExecutions = maxExecutions;
  }

  async recordEvent(event: AgentOpsEvent): Promise<void> {
    const record = this.executions.get(event.executionId) ?? emptyExecutionRecord(event.executionId);
    this.executions.set(event.executionId, record);
  }

  async putExecution(record: ExecutionRecord): Promise<void> {
    this.executions.set(record.executionId, record);
    if (this.executions.size > this.maxExecutions) {
      const oldest = [...this.executions.values()].sort((a, b) => a.startedAt - b.startedAt)[0];
      if (oldest) this.executions.delete(oldest.executionId);
    }
  }

  async getExecution(executionId: string): Promise<ExecutionRecord | null> {
    return this.executions.get(executionId) ?? null;
  }

  async listExecutions(filter: ExecutionFilter = {}): Promise<ExecutionRecord[]> {
    let rows = [...this.executions.values()];
    if (filter.userId) rows = rows.filter((r) => r.userId === filter.userId);
    if (filter.conversationId) rows = rows.filter((r) => r.conversationId === filter.conversationId);
    if (filter.status) rows = rows.filter((r) => r.status === filter.status);
    if (filter.mode) rows = rows.filter((r) => r.mode === filter.mode);
    if (filter.since) rows = rows.filter((r) => r.startedAt >= filter.since!);
    if (filter.until) rows = rows.filter((r) => r.startedAt <= filter.until!);
    rows.sort((a, b) => b.startedAt - a.startedAt);
    if (filter.limit) rows = rows.slice(0, filter.limit);
    return rows;
  }

  async deleteExecution(executionId: string): Promise<void> {
    this.executions.delete(executionId);
  }

  async appendAudit(entry: AuditEntry): Promise<void> {
    const list = this.audit.get(entry.executionId) ?? [];
    list.push(entry);
    this.audit.set(entry.executionId, list);
  }

  async listAudit(executionId: string, limit = 200): Promise<AuditEntry[]> {
    const list = this.audit.get(executionId) ?? [];
    return list.slice(-limit);
  }

  async appendSpan(span: Span): Promise<void> {
    const list = this.spans.get(span.traceId) ?? [];
    const idx = list.findIndex((s) => s.spanId === span.spanId);
    if (idx >= 0) list[idx] = span;
    else list.push(span);
    this.spans.set(span.traceId, list);
  }

  async listSpans(traceId: string, limit = 500): Promise<Span[]> {
    return (this.spans.get(traceId) ?? []).slice(-limit);
  }

  async listTraces(limit = 200): Promise<Span[]> {
    const all = [...this.spans.values()].flat();
    all.sort((a, b) => b.startTime - a.startTime);
    return all.slice(0, limit);
  }

  async putDataset(dataset: EvaluationDataset): Promise<void> {
    this.datasets.set(dataset.id, dataset);
  }

  async getDataset(id: string): Promise<EvaluationDataset | null> {
    return this.datasets.get(id) ?? null;
  }

  async listDatasets(): Promise<EvaluationDataset[]> {
    return [...this.datasets.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  async putRun(run: EvaluationRun): Promise<void> {
    this.runs.set(run.id, run);
  }

  async getRun(id: string): Promise<EvaluationRun | null> {
    return this.runs.get(id) ?? null;
  }

  async listRuns(datasetId?: string): Promise<EvaluationRun[]> {
    let rows = [...this.runs.values()];
    if (datasetId) rows = rows.filter((r) => r.datasetId === datasetId);
    rows.sort((a, b) => b.startedAt - a.startedAt);
    return rows;
  }

  async listMemory(executionId: string): Promise<ControlledMemoryEntry[]> {
    return [...(this.memory.get(executionId)?.values() ?? [])].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async putMemory(entry: ControlledMemoryEntry): Promise<void> {
    const map = this.memory.get(entry.executionId) ?? new Map<string, ControlledMemoryEntry>();
    map.set(entry.target, entry);
    this.memory.set(entry.executionId, map);
  }

  async deleteMemory(executionId: string, target: string): Promise<void> {
    this.memory.get(executionId)?.delete(target);
  }

  async pruneExpired(olderThanMs: number): Promise<number> {
    const cutoff = Date.now() - Math.max(0, olderThanMs);
    let pruned = 0;
    for (const [id, rec] of this.executions.entries()) {
      const terminal = ["completed", "failed", "cancelled", "circuit_open"].includes(rec.status);
      if (terminal && (rec.endedAt ?? rec.startedAt) < cutoff) {
        this.executions.delete(id);
        pruned += 1;
      }
    }
    return pruned;
  }
}
