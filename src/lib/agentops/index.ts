// =============================================================================
// QORVYNA AI — AgentOps Engine (framework-agnostic core).
//
// Folds real runtime events from the existing orchestrator, tool gateway and
// provider calls into durable ExecutionRecords, runs the intelligent circuit
// breaker, and persists through the storage adapter. No Fabric/Firebase import
// here so the core is fully unit-testable offline.
//
// Integration is additive and defensive: every call from the chat/agent routes
// is fire-and-forget and never throws into the request path.
// =============================================================================

import type { CollaborationEvent } from "@/lib/ai/orchestrator/run";
import {
  CircuitGuard,
  type GuardDecision,
  reasoningSignature,
  toolSignature,
} from "./circuit-breaker";
import {
  AgentOpsStorage,
  emptyExecutionRecord,
  InMemoryAgentOpsStorage,
  type ExecutionFilter,
} from "./storage";
import { raiseApproval, scrubSecrets } from "./governance";
import { estimateCost } from "./evaluation";
import {
  DEFAULT_CIRCUIT_CONFIG,
  DEFAULT_OBSERVABILITY_CONFIG,
  type AgentOpsEvent,
  type CircuitBreakerConfig,
  type ExecutionOutcome,
  type ExecutionRecord,
  type ObservabilityConfig,
  type PendingApproval,
  type Span,
  type TokenUsage,
} from "./types";
import { recordToSpans } from "./telemetry";

export type { AgentOpsStorage, ExecutionFilter } from "./storage";
export type { AgentOpsEvent, ExecutionRecord, Span } from "./types";
export { DEFAULT_CIRCUIT_CONFIG } from "./types";

const ZERO: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

export class AgentOpsEngine {
  private storage: AgentOpsStorage;
  private config: CircuitBreakerConfig;
  private observability: ObservabilityConfig;
  private cache = new Map<string, ExecutionRecord>();
  private guards = new Map<string, CircuitGuard>();
  private recentOutputs = new Map<string, Map<string, number>>();
  private unsampled = new Set<string>();

  constructor(
    storage?: AgentOpsStorage,
    config: CircuitBreakerConfig = DEFAULT_CIRCUIT_CONFIG,
    observability: ObservabilityConfig = DEFAULT_OBSERVABILITY_CONFIG,
  ) {
    this.storage = storage ?? new InMemoryAgentOpsStorage();
    this.config = config;
    this.observability = { ...observability };
  }

  /** Active in-memory record (live evaluation without a storage round-trip). */
  private live(executionId: string): ExecutionRecord {
    let rec = this.cache.get(executionId);
    if (!rec) {
      rec = emptyExecutionRecord(executionId);
      this.cache.set(executionId, rec);
    }
    return rec;
  }
  private guard(executionId: string): CircuitGuard {
    let g = this.guards.get(executionId);
    if (!g) {
      g = new CircuitGuard(this.live(executionId).guard, this.config);
      this.guards.set(executionId, g);
    }
    return g;
  }

  rootAgentId(executionId: string): string {
    return `agent-root-${executionId}`;
  }

  /** Begin an execution. Returns the execution id. */
  async start(input: {
    executionId?: string;
    requestId?: string;
    userId?: string;
    conversationId?: string;
    mode: string;
    modelPool: string[];
    metadata?: Record<string, unknown>;
  }): Promise<string> {
    const executionId = input.executionId ?? `exec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const rec = this.live(executionId);
    rec.executionId = executionId;
    rec.requestId = input.requestId;
    rec.userId = input.userId;
    rec.conversationId = input.conversationId;
    rec.mode = input.mode;
    rec.modelPool = input.modelPool;
    rec.status = "running";
    rec.startedAt = rec.startedAt || Date.now();
    rec.rootAgentId = this.rootAgentId(executionId);
    rec.agents.push({ agentId: rec.rootAgentId, role: "root", label: input.mode, depth: 0, startedAt: rec.startedAt });
    rec.transitions.push({ from: "queued", to: "running", at: rec.startedAt });
    if (input.metadata) rec.tags.push("meta");
    await this.persist(executionId);
    return executionId;
  }

  /**
   * Synchronous evaluation of one event: updates the live record + circuit
   * guard and returns a decision the caller may act on (e.g. abort). The async
   * persistence happens via persist() afterwards.
   */
  evaluate(event: AgentOpsEvent): GuardDecision {
    const rec = this.live(event.executionId);
    const guard = this.guard(event.executionId);
    let decision: GuardDecision = { kind: "continue" };

    const foldUsage = (model: string, provider: string | undefined, usage: TokenUsage) => {
      const prev = rec.usageByModel[model] ?? ZERO;
      rec.usageByModel[model] = {
        promptTokens: prev.promptTokens + usage.promptTokens,
        completionTokens: prev.completionTokens + usage.completionTokens,
        totalTokens: prev.totalTokens + usage.totalTokens,
      };
      rec.metrics.totalTokensIn += usage.promptTokens;
      rec.metrics.totalTokensOut += usage.completionTokens;
      rec.metrics.totalTokens += usage.totalTokens;
      const { costUsd } = estimateCost(usage, model);
      rec.metrics.estimatedCostUsd += costUsd;
      if (!rec.metrics.modelsUsed.includes(model)) rec.metrics.modelsUsed.push(model);
      if (provider && provider !== "unknown" && !rec.metrics.providersUsed.includes(provider)) {
        rec.metrics.providersUsed.push(provider);
      }
    };

    switch (event.type) {
      case "execution.start": {
        Object.assign(rec, {
          requestId: event.requestId ?? rec.requestId,
          userId: event.userId ?? rec.userId,
          conversationId: event.conversationId ?? rec.conversationId,
          mode: event.mode,
          modelPool: event.modelPool,
        });
        rec.status = "running";
        rec.rootAgentId = this.rootAgentId(event.executionId);
        if (!rec.agents.some((a) => a.agentId === rec.rootAgentId)) {
          rec.agents.push({ agentId: rec.rootAgentId, role: "root", label: event.mode, depth: 0, startedAt: event.startedAt });
        }
        rec.transitions.push({ from: "queued", to: "running", at: event.startedAt });
        break;
      }
      case "agent.spawn": {
        const d = this.guard(event.executionId).observeAgentSpawn(event.depth);
        if (d.kind === "open") decision = d;
        rec.agents.push({ agentId: event.agentId, parentAgentId: event.parentAgentId, role: event.role, label: event.label, depth: event.depth, startedAt: event.startedAt });
        rec.metrics.childAgents = rec.agents.filter((a) => a.role !== "root").length;
        break;
      }
      case "step.start": {
        const existing = rec.steps.find((s) => s.stepId === event.stepId);
        if (existing) {
          existing.status = "running";
          existing.startedAt = event.startedAt;
        } else {
          rec.steps.push({
            stepId: event.stepId,
            agentId: event.agentId,
            label: event.label,
            model: event.model,
            provider: event.provider,
            status: "running",
            startedAt: event.startedAt,
            attempts: [],
            usage: ZERO,
          });
        }
        break;
      }
      case "step.done": {
        const cleanDetail = event.detail ? scrubSecrets(event.detail) : undefined;
        const step = rec.steps.find((s) => s.stepId === event.stepId);
        if (step) {
          step.status = event.status;
          step.model = event.model;
          step.attempts = event.attempts;
          step.durationMs = event.durationMs;
          step.usage = event.usage;
          step.finishedAt = event.finishedAt;
          step.detail = cleanDetail;
        } else {
          rec.steps.push({
            stepId: event.stepId,
            agentId: event.agentId,
            label: event.stepId,
            model: event.model,
            provider: "unknown",
            status: event.status,
            startedAt: event.finishedAt - event.durationMs,
            attempts: event.attempts,
            usage: event.usage,
            finishedAt: event.finishedAt,
            detail: cleanDetail,
          });
        }
        const agent = rec.agents.find((a) => a.agentId === event.agentId);
        if (agent && agent.role !== "root") agent.endedAt = event.finishedAt;
        foldUsage(event.model, "unknown", event.usage);
        if (event.status === "done") {
          rec.metrics.stepsCompleted += 1;
          decision = this.detectReasoningCycle(event.executionId, cleanDetail ?? "");
          // a completed step that produced output implies a (partial) success
          this.guard(event.executionId).observeProviderSuccess();
        } else {
          rec.metrics.stepsFailed += 1;
          const d = this.guard(event.executionId).observeProviderFailure();
          if (d.kind === "open") decision = d;
        }
        break;
      }
      case "tool.call": {
        rec.toolCalls.push({
          toolId: event.toolId,
          agentId: event.agentId,
          argsHash: event.argsHash,
          risk: event.risk,
          approvalRequired: event.approvalRequired,
          ok: false,
          durationMs: 0,
          startedAt: event.startedAt,
          finishedAt: event.startedAt,
        });
        const sig = toolSignature(event.toolId, event.argsHash);
        const d = this.guard(event.executionId).observeToolCall(sig);
        if (d.kind === "open") {
          decision = d;
          rec.loops.push({ loopKind: "tool_echo", count: d.actual, signature: sig, detectedAt: Date.now(), action: "open" });
          rec.metrics.loopsDetected += 1;
        } else if (d.kind === "warn") {
          rec.loops.push({ loopKind: "tool_echo", count: d.count, signature: sig, detectedAt: Date.now(), action: "warn" });
          rec.metrics.loopsDetected += 1;
        }
        if (event.requestId) rec.requestId = event.requestId;
        break;
      }
      case "tool.result": {
        const cleanErr = event.error ? scrubSecrets(event.error) : undefined;
        const open = [...rec.toolCalls].reverse().find((t) => t.toolId === event.toolId && t.finishedAt === t.startedAt);
        if (open) {
          open.ok = event.ok;
          open.error = cleanErr;
          open.durationMs = event.durationMs;
          open.finishedAt = event.finishedAt;
        }
        rec.metrics.toolCalls += 1;
        if (!event.ok) rec.metrics.toolFailures += 1;
        break;
      }
      case "tool.approval_required": {
        const { record, audit } = raiseApproval(rec, event.approvalId, event.toolId, event.agentId, event.risk);
        Object.assign(rec, record);
        rec.pendingApprovals = record.pendingApprovals;
        rec.transitions = record.transitions;
        void audit;
        break;
      }
      case "loop.detected": {
        rec.loops.push({ loopKind: event.loopKind, count: event.count, signature: event.signature, detectedAt: event.detectedAt, action: event.action });
        rec.metrics.loopsDetected += 1;
        break;
      }
      case "circuit.tripped": {
        rec.circuitEvents.push({ reason: event.reason, threshold: event.threshold, actual: event.actual, trippedAt: event.trippedAt, resolution: event.resolution });
        rec.metrics.circuitTrips += 1;
        rec.status = "circuit_open";
        rec.guard.open = true;
        rec.guard.openedAt = event.trippedAt;
        decision = { kind: "open", reason: event.reason, threshold: event.threshold, actual: event.actual, resolution: event.resolution };
        break;
      }
      case "state.transition": {
        rec.transitions.push({ from: event.from, to: event.to, reason: event.reason, at: event.at, operatorId: event.operatorId });
        rec.status = event.to;
        break;
      }
      case "error": {
        rec.errors.push({
          agentId: event.agentId,
          stepId: event.stepId,
          kind: event.kind,
          message: scrubSecrets(event.message),
          isRetryable: event.isRetryable,
          at: event.at,
        });
        rec.metrics.errors += 1;
        break;
      }
      case "retry": {
        rec.metrics.retries += 1;
        rec.retries += 1;
        const d = this.guard(event.executionId).observeRetry();
        if (d.kind === "open") decision = d;
        break;
      }
      case "recovery": {
        rec.recoveries.push({ agentId: event.agentId, strategy: event.strategy, at: event.at });
        break;
      }
      case "token.usage": {
        foldUsage(event.model, event.provider, event.usage);
        const dTokens = this.guard(event.executionId).observeTokens(event.usage.totalTokens);
        if (dTokens.kind === "open") decision = dTokens;
        if (event.status === "error" || event.status === "partial" || event.status === "refused") {
          const d = this.guard(event.executionId).observeProviderFailure();
          if (d.kind === "open") decision = d;
        } else {
          this.guard(event.executionId).observeProviderSuccess();
        }
        break;
      }
      case "execution.end": {
        rec.status = event.status;
        rec.outcome = event.outcome;
        rec.endedAt = event.endedAt;
        rec.totalDurationMs = event.totalDurationMs;
        rec.metrics.latencyMs = event.totalDurationMs;
        const t = this.guard(event.executionId).checkTimeout(rec.startedAt, event.endedAt);
        if (t.kind === "open" && rec.status !== "cancelled") {
          rec.circuitEvents.push({ reason: t.reason, threshold: t.threshold, actual: t.actual, trippedAt: event.endedAt, resolution: t.resolution });
          rec.metrics.circuitTrips += 1;
          rec.status = "circuit_open";
          decision = t;
        }
        break;
      }
    }

    if (decision.kind === "open") {
      rec.status = "circuit_open";
      rec.guard.open = true;
      rec.guard.openedAt = Date.now();
      rec.circuitEvents.push({ reason: decision.reason, threshold: decision.threshold, actual: decision.actual, trippedAt: Date.now(), resolution: decision.resolution });
      rec.metrics.circuitTrips += 1;
    }
    return decision;
  }

  private detectReasoningCycle(executionId: string, text: string): GuardDecision {
    if (!text) return { kind: "continue" };
    const sig = reasoningSignature(text);
    const map = this.recentOutputs.get(executionId) ?? new Map<string, number>();
    const count = (map.get(sig) ?? 0) + 1;
    map.set(sig, count);
    this.recentOutputs.set(executionId, map);
    if (count < 3) return { kind: "continue" };
    const rec = this.live(executionId);
    rec.loops.push({ loopKind: "reasoning_cycle", count, signature: sig, detectedAt: Date.now(), action: count >= 5 ? "open" : "warn" });
    rec.metrics.loopsDetected += 1;
    if (count >= 5) return this.guard(executionId).observeReasoningCycle();
    return { kind: "warn", reason: "repetitive_reasoning", count, loopKind: "reasoning_cycle" };
  }

  /** Persist the live record + derive/append spans. Async, never throws. */
  async persist(executionId: string): Promise<void> {
    if (!this.observability.enabled || this.unsampled.has(executionId)) return;
    if (this.observability.sampleRate < 1 && !this.cache.get(executionId)?.tags.includes("sampled")) {
      const rec0 = this.cache.get(executionId);
      if (rec0) {
        if (Math.random() <= this.observability.sampleRate) {
          rec0.tags.push("sampled");
        } else {
          this.unsampled.add(executionId);
          return;
        }
      }
    }
    const rec = this.cache.get(executionId);
    if (!rec) return;
    rec.guard = this.guard(executionId).state;
    try {
      await this.storage.putExecution(rec);
      if (this.observability.captureSpans) {
        const spans = recordToSpans(rec);
        for (const span of spans) {
          await this.storage.appendSpan(span).catch(() => {});
        }
      }
    } catch (error) {
      console.warn("[QORVYNA AgentOps] persist failed", error instanceof Error ? error.message : String(error));
    }
  }

  /** Full event handler: evaluate then persist (fire-and-forget safe). */
  async handle(event: AgentOpsEvent): Promise<GuardDecision> {
    const decision = this.evaluate(event);
    await this.persist(event.executionId);
    return decision;
  }

  async end(executionId: string, outcome: ExecutionOutcome, status?: ExecutionRecord["status"]): Promise<void> {
    const rec = this.live(executionId);
    const endedAt = Date.now();
    await this.handle({
      type: "execution.end",
      executionId,
      status: status ?? (rec.status === "running" ? "completed" : rec.status),
      outcome,
      endedAt,
      totalDurationMs: rec.totalDurationMs ?? endedAt - rec.startedAt,
    });
  }

  getConfig(): CircuitBreakerConfig {
    return { ...this.config };
  }

  updateConfig(partial: Partial<CircuitBreakerConfig>): CircuitBreakerConfig {
    const clampInt = (v: number | undefined, fallback: number, min: number, max: number) =>
      typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.floor(v))) : fallback;
    this.config = {
      maxReasoningCycles: clampInt(partial.maxReasoningCycles, this.config.maxReasoningCycles, 2, 100),
      maxRepeatedToolCalls: clampInt(partial.maxRepeatedToolCalls, this.config.maxRepeatedToolCalls, 2, 50),
      maxRecursionDepth: clampInt(partial.maxRecursionDepth, this.config.maxRecursionDepth, 1, 32),
      maxRetries: clampInt(partial.maxRetries, this.config.maxRetries, 1, 30),
      maxProviderFailures: clampInt(partial.maxProviderFailures, this.config.maxProviderFailures, 1, 50),
      tokenBudget: clampInt(partial.tokenBudget, this.config.tokenBudget, 1000, 5_000_000),
      executionTimeoutMs: clampInt(partial.executionTimeoutMs, this.config.executionTimeoutMs, 5000, 3_600_000),
      cooldownMs: clampInt(partial.cooldownMs, this.config.cooldownMs, 500, 600_000),
      toolSignatureWindow: clampInt(partial.toolSignatureWindow, this.config.toolSignatureWindow, 4, 200),
    };
    return this.getConfig();
  }

  // --- queries (backed by storage; cache is consulted first) ----------------
  async getExecution(executionId: string): Promise<ExecutionRecord | null> {
    return this.cache.get(executionId) ?? (await this.storage.getExecution(executionId));
  }
  async listExecutions(filter?: ExecutionFilter): Promise<ExecutionRecord[]> {
    return this.storage.listExecutions(filter);
  }
  isOpen(executionId: string): boolean {
    return this.guard(executionId).isOpen;
  }
  cooldownRemaining(executionId: string): number {
    return this.guard(executionId).cooldownRemaining();
  }

  /** Replace the live record (used after a governance mutation). */
  setRecord(rec: ExecutionRecord): void {
    this.cache.set(rec.executionId, rec);
    this.guards.set(rec.executionId, new CircuitGuard(rec.guard, this.config));
  }

  /** Persist a specific record (after an external mutation such as governance). */
  async persistRecord(rec: ExecutionRecord): Promise<void> {
    this.cache.set(rec.executionId, rec);
    await this.persist(rec.executionId);
  }

  /** Access the underlying storage (for audit writes, etc.). */
  getStorage(): AgentOpsStorage {
    return this.storage;
  }

  getObservabilityConfig(): ObservabilityConfig {
    return { ...this.observability };
  }

  updateObservabilityConfig(partial: Partial<ObservabilityConfig>): ObservabilityConfig {
    if (typeof partial.enabled === "boolean") this.observability.enabled = partial.enabled;
    if (typeof partial.captureSpans === "boolean") this.observability.captureSpans = partial.captureSpans;
    if (typeof partial.sampleRate === "number" && Number.isFinite(partial.sampleRate)) {
      this.observability.sampleRate = Math.min(1, Math.max(0, partial.sampleRate));
    }
    if (typeof partial.retentionDays === "number" && Number.isFinite(partial.retentionDays)) {
      this.observability.retentionDays = Math.min(365, Math.max(1, Math.floor(partial.retentionDays)));
    }
    return this.getObservabilityConfig();
  }

  async pruneRetention(retentionDays?: number): Promise<number> {
    const days = retentionDays ?? this.observability.retentionDays;
    return this.storage.pruneExpired(days * 24 * 3_600_000);
  }

  // --- translation helpers for the existing orchestrator --------------------
  translateCollaboration(executionId: string, ev: CollaborationEvent): AgentOpsEvent[] {
    const root = this.rootAgentId(executionId);
    if (ev.type === "task_start") {
      const childId = `agent-${executionId}-${ev.task.id}`;
      const depth = (ev.task.dependsOn?.length ?? 0) > 0 ? 2 : 1;
      const role =
        ev.task.role === "coordinator"
          ? "coordinator"
          : ev.task.role === "reviewer"
            ? "reviewer"
            : "specialist";
      const rec = this.live(executionId);
      const events: AgentOpsEvent[] = [];
      if (!rec.agents.some((a) => a.agentId === childId)) {
        events.push({
          type: "agent.spawn",
          executionId,
          agentId: childId,
          parentAgentId: root,
          role,
          label: `${ev.task.role}: ${ev.task.responsibility}`,
          depth,
          startedAt: Date.now(),
        });
      }
      events.push({
        type: "step.start",
        executionId,
        agentId: childId,
        stepId: `step-${ev.task.id}`,
        label: `${ev.task.role}: ${ev.task.responsibility}`,
        model: "unknown",
        provider: "unknown",
        startedAt: Date.now(),
      });
      return events;
    }
    if (ev.type === "task_done") {
      const r = ev.result;
      const childId = `agent-${executionId}-${r.task.id}`;
      const events: AgentOpsEvent[] = [];
      const failedAttempts = r.attempts.filter((a) => a.outcome === "failed");
      for (let i = 0; i < failedAttempts.length; i += 1) {
        events.push({
          type: "retry",
          executionId,
          agentId: childId,
          stepId: `step-${r.task.id}`,
          attempt: i + 1,
          afterMs: 0,
          at: Date.now(),
        });
      }
      if (failedAttempts.length > 0 && r.status === "done") {
        events.push({
          type: "recovery",
          executionId,
          agentId: childId,
          strategy: `fallback_to_${r.model}`,
          at: Date.now(),
        });
      }
      events.push({
        type: "step.done",
        executionId,
        agentId: childId,
        stepId: `step-${r.task.id}`,
        status: r.status === "done" ? "done" : "failed",
        model: r.model,
        attempts: r.attempts,
        durationMs: r.durationMs,
        usage: r.usage,
        detail: r.output.slice(0, 120),
        finishedAt: Date.now(),
      });
      return events;
    }
    return [];
  }

  /** Compose an onEvent for runCollaboration that also feeds AgentOps and can abort. */
  composeOnEvent(
    executionId: string,
    original?: (event: CollaborationEvent) => void,
    signal?: { abort: () => void },
  ): (event: CollaborationEvent) => void {
    return (event: CollaborationEvent) => {
      original?.(event);
      for (const ev of this.translateCollaboration(executionId, event)) {
        const decision = this.evaluate(ev);
        void this.persist(executionId);
        if (decision.kind === "open") signal?.abort();
      }
    };
  }
}

// ---------------------------------------------------------------------------
// Singleton (in-memory by default; swapped for Firestore in server.ts).
// ---------------------------------------------------------------------------
let engineSingleton: AgentOpsEngine | null = null;

export function getEngine(storage?: AgentOpsStorage): AgentOpsEngine {
  if (!engineSingleton) engineSingleton = new AgentOpsEngine(storage);
  return engineSingleton;
}

export function resetEngineForTests(storage?: AgentOpsStorage): AgentOpsEngine {
  engineSingleton = new AgentOpsEngine(storage);
  return engineSingleton;
}

export type { PendingApproval };
