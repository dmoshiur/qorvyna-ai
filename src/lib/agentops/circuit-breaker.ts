// =============================================================================
// QORVYNA AI — Intelligent Circuit Breaker (pure logic, fully testable).
//
// Runtime protection against runaway agent behavior:
//   • repetitive reasoning cycles
//   • identical / near-identical tool calls
//   • excessive recursive agent loops
//   • unbounded retries
//   • token budget exhaustion
//   • execution timeouts
//   • repeated provider failures
//
// The guard NEVER deletes user data or permanently disables an agent. When a
// threshold trips it either cools down, auto-cancels the current execution, or
// degrades gracefully — and an operator override always wins.
// =============================================================================

import type {
  CircuitBreakerConfig,
  CircuitEvent,
  CircuitGuardState,
  CircuitReason,
  LoopKind,
} from "./types";
import { DEFAULT_CIRCUIT_CONFIG } from "./types";

export type GuardDecision =
  | { kind: "continue" }
  | { kind: "warn"; reason: CircuitReason; count: number; loopKind: LoopKind }
  | { kind: "cooldown"; reason: CircuitReason; until: number; count: number }
  | {
      kind: "open";
      reason: CircuitReason;
      threshold: number;
      actual: number;
      resolution: CircuitEvent["resolution"];
    };

export function freshGuardState(): CircuitGuardState {
  return {
    reasoningCycles: 0,
    repeatedToolSignatures: {},
    recursionDepth: 0,
    retries: 0,
    providerFailures: 0,
    consecutiveProviderFailures: 0,
    tokensConsumed: 0,
    open: false,
    triggered: [],
  };
}

export class CircuitGuard {
  readonly state: CircuitGuardState;
  private config: CircuitBreakerConfig;
  private window: string[] = [];

  constructor(state: CircuitGuardState = freshGuardState(), config: CircuitBreakerConfig = DEFAULT_CIRCUIT_CONFIG) {
    this.state = state;
    this.config = config;
  }

  get isOpen(): boolean {
    return this.state.open;
  }

  /** Milliseconds until the cooldown lifts (0 if not cooling down). */
  cooldownRemaining(now = Date.now()): number {
    if (!this.state.cooldownUntil) return 0;
    return Math.max(0, this.state.cooldownUntil - now);
  }

  /** Operator override — always respected, never silently ignored. */
  applyOverride(by: string, at = Date.now(), note?: string): void {
    this.state.operatorOverride = { by, at, note };
    this.state.open = false;
    this.state.cooldownUntil = undefined;
  }

  /**
   * Observe a reasoning cycle. Repeated cycles trigger a warning, then open the
   * circuit (auto-cancel) once the limit is exceeded.
   */
  observeReasoningCycle(): GuardDecision {
    this.state.reasoningCycles += 1;
    const count = this.state.reasoningCycles;
    if (count < this.config.maxReasoningCycles) {
      if (count >= Math.floor(this.config.maxReasoningCycles * 0.75)) {
        return { kind: "warn", reason: "repetitive_reasoning", count, loopKind: "reasoning_cycle" };
      }
      return { kind: "continue" };
    }
    return this.trip("repetitive_reasoning", this.config.maxReasoningCycles, count, "auto_cancel");
  }

  /**
   * Observe a tool call by its signature (toolId + args hash). Near-identical
   * calls within the sliding window increment the same counter.
   */
  observeToolCall(signature: string): GuardDecision {
    const bucket = this.windowed(signature);
    const count = (this.state.repeatedToolSignatures[bucket] ?? 0) + 1;
    this.state.repeatedToolSignatures[bucket] = count;
    if (count < this.config.maxRepeatedToolCalls) {
      if (count >= Math.floor(this.config.maxRepeatedToolCalls * 0.75)) {
        return { kind: "warn", reason: "repeated_tool_call", count, loopKind: "tool_echo" };
      }
      return { kind: "continue" };
    }
    return this.trip("repeated_tool_call", this.config.maxRepeatedToolCalls, count, "auto_cancel");
  }

  /** Observe a child agent spawn; excessive depth trips the circuit. */
  observeAgentSpawn(depth: number): GuardDecision {
    this.state.recursionDepth = Math.max(this.state.recursionDepth, depth);
    if (depth < this.config.maxRecursionDepth) return { kind: "continue" };
    return this.trip("excessive_recursion", this.config.maxRecursionDepth, depth, "auto_cancel");
  }

  /** Observe a retry; unbounded retries trip the circuit. */
  observeRetry(): GuardDecision {
    this.state.retries += 1;
    this.state.consecutiveProviderFailures = 0;
    const count = this.state.retries;
    if (count < this.config.maxRetries) return { kind: "continue" };
    return this.trip("unbounded_retries", this.config.maxRetries, count, "degrade");
  }

  /** Observe a provider/model failure (rate-limit, 5xx, auth error). */
  observeProviderFailure(): GuardDecision {
    this.state.providerFailures += 1;
    this.state.consecutiveProviderFailures += 1;
    const count = this.state.consecutiveProviderFailures;
    if (count < this.config.maxProviderFailures) return { kind: "continue" };
    return this.trip("provider_failure_rate", this.config.maxProviderFailures, count, "degrade");
  }

  /** Reset the consecutive provider-failure streak (a success happened). */
  observeProviderSuccess(): void {
    this.state.consecutiveProviderFailures = 0;
  }

  /** Observe token consumption; token-budget exhaustion trips the circuit. */
  observeTokens(totalTokens: number): GuardDecision {
    this.state.tokensConsumed += Math.max(0, totalTokens);
    if (this.state.tokensConsumed < this.config.tokenBudget) return { kind: "continue" };
    return this.trip("token_budget", this.config.tokenBudget, this.state.tokensConsumed, "degrade");
  }

  /** Observe a hard execution timeout. */
  observeTimeout(now = Date.now()): GuardDecision {
    return this.trip("execution_timeout", this.config.executionTimeoutMs, now, "auto_cancel");
  }

  /** Elapsed-time check against the configured execution timeout. */
  checkTimeout(startedAt: number, now = Date.now()): GuardDecision {
    if (now - startedAt < this.config.executionTimeoutMs) return { kind: "continue" };
    return this.trip("execution_timeout", this.config.executionTimeoutMs, now - startedAt, "auto_cancel");
  }

  private trip(
    reason: CircuitReason,
    threshold: number,
    actual: number,
    resolution: CircuitEvent["resolution"],
  ): GuardDecision {
    if (!this.state.triggered.includes(reason)) this.state.triggered.push(reason);
    this.state.open = true;
    this.state.openedAt = Date.now();
    this.state.cooldownUntil = Date.now() + this.config.cooldownMs;
    return { kind: "open", reason, threshold, actual, resolution };
  }

  private windowed(signature: string): string {
    this.window.push(signature);
    if (this.window.length > this.config.toolSignatureWindow) this.window.shift();
    // Decrement counters for signatures that have aged out of the window so a
    // legitimate repeated tool (e.g. pagination) does not accumulate forever.
    const seen = new Set(this.window);
    for (const key of Object.keys(this.state.repeatedToolSignatures)) {
      if (!seen.has(key)) delete this.state.repeatedToolSignatures[key];
    }
    return signature;
  }
}

/** Build a canonical signature for a tool call (tool + normalized args hash). */
export function toolSignature(toolId: string, argsHash: string): string {
  return `${toolId}#${argsHash}`;
}

/** Build a signature for a reasoning step (model output fingerprint). */
export function reasoningSignature(text: string): string {
  const norm = text.toLowerCase().replace(/\s+/g, " ").trim();
  const head = norm.slice(0, 64);
  const tail = norm.slice(-64);
  return `${head}|${tail}`;
}
