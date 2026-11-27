// =============================================================================
// QORVYNA AI — AgentOps core types.
//
// These types describe real runtime telemetry produced by the existing agent
// orchestration (src/lib/ai/orchestrator), tool gateway and provider calls.
// Nothing here fabricates sample values — every field is filled from an actual
// event emitted during an execution.
// =============================================================================

/** Lifecycle states an agent execution can be in. */
export type ExecutionStatus =
  | "queued"
  | "running"
  | "paused"
  | "awaiting_approval"
  | "recovered"
  | "completed"
  | "failed"
  | "cancelled"
  | "circuit_open";

/** Why an execution ended the way it did. */
export type ExecutionOutcome =
  | "success"
  | "model_failure"
  | "provider_failure"
  | "tool_failure"
  | "circuit_tripped"
  | "cancelled"
  | "timeout"
  | "token_budget"
  | "user_abort"
  | "unknown";

export type AgentRole =
  | "coordinator"
  | "specialist"
  | "reviewer"
  | "researcher"
  | "coder"
  | "tool"
  | "child"
  | "root";

/** A single runtime event — the atomic unit of AgentOps telemetry. */
export type AgentOpsEvent =
  | {
      type: "execution.start";
      executionId: string;
      requestId?: string;
      userId?: string;
      conversationId?: string;
      rootAgentId?: string;
      mode: string;
      modelPool: string[];
      startedAt: number;
      metadata?: Record<string, unknown>;
    }
  | {
      type: "agent.spawn";
      executionId: string;
      agentId: string;
      parentAgentId?: string;
      role: AgentRole;
      label: string;
      depth: number;
      startedAt: number;
    }
  | {
      type: "step.start";
      executionId: string;
      agentId: string;
      stepId: string;
      label: string;
      model: string;
      provider: string;
      startedAt: number;
    }
  | {
      type: "step.done";
      executionId: string;
      agentId: string;
      stepId: string;
      status: "done" | "failed";
      model: string;
      attempts: ModelAttempt[];
      durationMs: number;
      usage: TokenUsage;
      detail?: string;
      finishedAt: number;
    }
  | {
      type: "step.attempt";
      executionId: string;
      agentId: string;
      stepId: string;
      stage: string;
      attempt: number;
      model: string;
      label: string;
      provider: string;
      outcome: "ok" | "skipped" | "failed";
      error: string;
      at: number;
    }
  | {
      type: "tool.call";
      executionId: string;
      agentId: string;
      toolId: string;
      argsHash: string;
      risk: string;
      approvalRequired: boolean;
      startedAt: number;
      requestId?: string;
    }
  | {
      type: "tool.result";
      executionId: string;
      agentId: string;
      toolId: string;
      ok: boolean;
      error?: string;
      durationMs: number;
      finishedAt: number;
    }
  | {
      type: "tool.approval_required";
      executionId: string;
      agentId: string;
      toolId: string;
      approvalId: string;
      risk: string;
      raisedAt: number;
    }
  | {
      type: "loop.detected";
      executionId: string;
      agentId: string;
      loopKind: LoopKind;
      count: number;
      signature: string;
      detectedAt: number;
      action: "cooldown" | "open" | "warn";
    }
  | {
      type: "circuit.tripped";
      executionId: string;
      agentId?: string;
      reason: CircuitReason;
      threshold: number;
      actual: number;
      trippedAt: number;
      resolution: "auto_cancel" | "cooldown" | "degrade" | "recover";
    }
  | {
      type: "state.transition";
      executionId: string;
      from: ExecutionStatus;
      to: ExecutionStatus;
      reason?: string;
      at: number;
      operatorId?: string;
    }
  | {
      type: "error";
      executionId: string;
      agentId?: string;
      stepId?: string;
      kind: string;
      message: string;
      isRetryable: boolean;
      at: number;
    }
  | {
      type: "retry";
      executionId: string;
      agentId?: string;
      stepId?: string;
      attempt: number;
      afterMs: number;
      at: number;
    }
  | {
      type: "recovery";
      executionId: string;
      agentId?: string;
      strategy: string;
      at: number;
    }
  | {
      type: "token.usage";
      executionId: string;
      agentId?: string;
      model: string;
      provider?: string;
      requestType: string;
      usage: TokenUsage;
      latencyMs: number;
      status: string;
      requestId?: string;
      at: number;
    }
  | {
      type: "execution.end";
      executionId: string;
      status: ExecutionStatus;
      outcome: ExecutionOutcome;
      endedAt: number;
      totalDurationMs: number;
    };

export type LoopKind =
  | "reasoning_cycle"
  | "tool_echo"
  | "recursive_agent"
  | "retry_storm"
  | "provider_failure";

export type CircuitReason =
  | "repetitive_reasoning"
  | "repeated_tool_call"
  | "excessive_recursion"
  | "unbounded_retries"
  | "token_budget"
  | "execution_timeout"
  | "provider_failure_rate";

export type ModelAttempt = {
  model: string;
  label: string;
  outcome: "ok" | "skipped" | "failed";
  detail: string;
};

export type TokenUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

/** A tool invocation captured by the gateway, with approval metadata. */
export type ToolCallRecord = {
  toolId: string;
  agentId: string;
  argsHash: string;
  risk: string;
  approvalRequired: boolean;
  approvalId?: string;
  ok: boolean;
  error?: string;
  durationMs: number;
  startedAt: number;
  finishedAt: number;
};

/** A model step within an agent. */
export type StepRecord = {
  stepId: string;
  agentId: string;
  label: string;
  model: string;
  provider: string;
  status: "running" | "done" | "failed";
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  attempts: ModelAttempt[];
  usage: TokenUsage;
  detail?: string;
};

/** One attempt at a model step, including why a model did not take the stage. */
export type StepAttemptRecord = {
  stepId: string;
  stage: string;
  attempt: number;
  model: string;
  label: string;
  provider: string;
  outcome: "ok" | "skipped" | "failed";
  error: string;
  at: number;
};

/** A child agent spawned by a parent (recursive loop visualization). */
export type AgentNode = {
  agentId: string;
  parentAgentId?: string;
  role: AgentRole;
  label: string;
  depth: number;
  startedAt: number;
  endedAt?: number;
};

/** OpenTelemetry-compatible span derived from execution events. */
export type Span = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: "internal" | "server" | "client" | "producer" | "consumer";
  startTime: number;
  endTime?: number;
  status: "ok" | "error" | "unset";
  attributes: Record<string, string | number | boolean>;
};

/** Aggregated metrics computed from real events (never fabricated). */
export type ExecutionMetrics = {
  totalTokensIn: number;
  totalTokensOut: number;
  totalTokens: number;
  estimatedCostUsd: number;
  costSource: "provider" | "estimate";
  latencyMs: number;
  toolCalls: number;
  toolFailures: number;
  retries: number;
  errors: number;
  loopsDetected: number;
  circuitTrips: number;
  stepsCompleted: number;
  stepsFailed: number;
  childAgents: number;
  modelsUsed: string[];
  providersUsed: string[];
};

/** The full execution record persisted to storage and served to the UI. */
export type ExecutionRecord = {
  executionId: string;
  requestId?: string;
  userId?: string;
  conversationId?: string;
  rootAgentId?: string;
  mode: string;
  modelPool: string[];
  status: ExecutionStatus;
  outcome?: ExecutionOutcome;
  startedAt: number;
  endedAt?: number;
  totalDurationMs?: number;
  agents: AgentNode[];
  steps: StepRecord[];
  stepAttempts: StepAttemptRecord[];
  toolCalls: ToolCallRecord[];
  pendingApprovals: PendingApproval[];
  loops: LoopEvent[];
  circuitEvents: CircuitEvent[];
  transitions: TransitionEvent[];
  errors: ErrorEvent[];
  recoveries: RecoveryEvent[];
  retries: number;
  usageByModel: Record<string, TokenUsage>;
  metrics: ExecutionMetrics;
  // Governance / circuit-guard live state (serialized for persistence).
  guard: CircuitGuardState;
  tags: string[];
};

export type PendingApproval = {
  approvalId: string;
  toolId: string;
  agentId: string;
  risk: string;
  raisedAt: number;
  status: "pending" | "approved" | "rejected";
  decidedAt?: number;
  decidedBy?: string;
};

export type LoopEvent = {
  loopKind: LoopKind;
  count: number;
  signature: string;
  detectedAt: number;
  action: "cooldown" | "open" | "warn";
};

export type CircuitEvent = {
  reason: CircuitReason;
  threshold: number;
  actual: number;
  trippedAt: number;
  resolution: "auto_cancel" | "cooldown" | "degrade" | "recover";
};

export type TransitionEvent = {
  from: ExecutionStatus;
  to: ExecutionStatus;
  reason?: string;
  at: number;
  operatorId?: string;
};

export type ErrorEvent = {
  agentId?: string;
  stepId?: string;
  kind: string;
  message: string;
  isRetryable: boolean;
  at: number;
};

export type RecoveryEvent = {
  agentId?: string;
  strategy: string;
  at: number;
};

/** Serializable live state of the circuit breaker for an execution. */
export type CircuitGuardState = {
  // counts toward thresholds
  reasoningCycles: number;
  repeatedToolSignatures: Record<string, number>;
  recursionDepth: number;
  retries: number;
  providerFailures: number;
  consecutiveProviderFailures: number;
  tokensConsumed: number;
  // status
  open: boolean;
  openedAt?: number;
  cooldownUntil?: number;
  triggered: CircuitReason[];
  // user-supplied overrides are respected; do not silently disable.
  operatorOverride?: { by: string; at: number; note?: string };
};

/** Configurable limits for the intelligent circuit breaker. */
export type CircuitBreakerConfig = {
  maxReasoningCycles: number;
  maxRepeatedToolCalls: number;
  maxRecursionDepth: number;
  maxRetries: number;
  maxProviderFailures: number;
  tokenBudget: number;
  executionTimeoutMs: number;
  cooldownMs: number;
  // signature window for detecting near-identical tool calls
  toolSignatureWindow: number;
};

export const DEFAULT_CIRCUIT_CONFIG: CircuitBreakerConfig = {
  maxReasoningCycles: 8,
  maxRepeatedToolCalls: 4,
  maxRecursionDepth: 6,
  maxRetries: 5,
  maxProviderFailures: 6,
  tokenBudget: 200_000,
  executionTimeoutMs: 120_000,
  cooldownMs: 5_000,
  toolSignatureWindow: 20,
};

/** Governance control action requested by an operator. */
export type GovernanceAction =
  | { kind: "pause"; operatorId: string; at: number; reason?: string }
  | { kind: "resume"; operatorId: string; at: number; reason?: string }
  | { kind: "cancel"; operatorId: string; at: number; reason?: string }
  | { kind: "approve"; operatorId: string; approvalId: string; at: number }
  | { kind: "reject"; operatorId: string; approvalId: string; at: number; reason?: string }
  | {
      kind: "edit_memory";
      operatorId: string;
      at: number;
      target: string;
      operation: "append" | "replace" | "delete";
      // Content is scrubbed of credentials before storage.
      content?: string;
      reason?: string;
    }
  | { kind: "override"; operatorId: string; at: number; decision: string; reason?: string };

/** A single audit-log entry — immutable once written. */
export type AuditEntry = {
  entryId: string;
  executionId: string;
  actorId: string;
  action: string;
  detail: string;
  at: number;
  // immutable: never mutated after creation
  immutable: true;
};

/** Evaluation dataset / test run structures (Section E). */
export type EvaluationDataset = {
  id: string;
  name: string;
  description: string;
  createdBy: string;
  createdAt: number;
  cases: EvaluationCase[];
};

export type EvaluationCase = {
  id: string;
  prompt: string;
  expectedOutcome?: string;
  tags: string[];
};

export type EvaluationRun = {
  id: string;
  datasetId: string;
  agentConfig: string;
  model: string;
  startedAt: number;
  endedAt?: number;
  status: "running" | "completed" | "cancelled";
  results: EvaluationResult[];
  summary: EvaluationSummary;
};

export type EvaluationResult = {
  caseId: string;
  success: boolean;
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  costSource: "provider" | "estimate";
  notes?: string;
};

export type EvaluationSummary = {
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  avgLatencyMs: number;
  totalTokens: number;
  totalCostUsd: number;
  costSource: "provider" | "estimate";
  // ROI is only reported when real outcome/baseline data exists.
  roiUsd?: number;
  roiBasis?: string;
};

/** Cost model used to estimate inference cost from provider-reported tokens. */
export type ModelCostSpec = {
  // USD per 1K tokens
  inputPer1k: number;
  outputPer1k: number;
  provider: string;
};

/** Configurable observability overhead & retention controls. */
export type ObservabilityConfig = {
  enabled: boolean;
  /** 0.0 to 1.0 fraction of executions traced. */
  sampleRate: number;
  captureSpans: boolean;
  /** Days to retain finished execution telemetry before eligible for pruning. */
  retentionDays: number;
};

export const DEFAULT_OBSERVABILITY_CONFIG: ObservabilityConfig = {
  enabled: process.env.QORVYNA_AGENTOPS_ENABLED !== "false",
  sampleRate: Math.min(1, Math.max(0, Number(process.env.QORVYNA_AGENTOPS_SAMPLE_RATE ?? 1) || 1)),
  captureSpans: process.env.QORVYNA_AGENTOPS_CAPTURE_SPANS !== "false",
  retentionDays: Math.max(1, Math.min(365, Math.floor(Number(process.env.QORVYNA_AGENTOPS_RETENTION_DAYS ?? 30) || 30))),
};

/** Permitted working-memory note governed by HITL (never credentials/system instructions). */
export type ControlledMemoryEntry = {
  executionId: string;
  target: string;
  content: string;
  updatedBy: string;
  updatedAt: number;
};

