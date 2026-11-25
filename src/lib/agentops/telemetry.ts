// =============================================================================
// QORVYNA AI — OpenTelemetry-compatible observability.
//
// Derives distributed traces (spans) and structured logs from real execution
// records, and exposes an OTLP/JSON-compatible export layer. No data leaves
// the process through this module — callers persist or forward it themselves.
// Secrets, tokens and private user data are never placed in attributes/logs.
// =============================================================================

import crypto from "node:crypto";
import type { ExecutionRecord, Span } from "./types";

/** Stable 32-char hex trace id derived from a string seed. */
function traceId(seed: string): string {
  const h = crypto.createHash("sha256").update(`trace:${seed}`).digest("hex");
  return h.slice(0, 32);
}
/** Stable 16-char hex span id derived from a seed. */
function spanId(seed: string): string {
  return crypto.createHash("sha256").update(`span:${seed}`).digest("hex").slice(0, 16);
}

const KIND_NUM: Record<Span["kind"], number> = {
  internal: 1,
  server: 2,
  client: 3,
  producer: 4,
  consumer: 5,
};

const STATUS_NUM: Record<Span["status"], number> = { ok: 1, error: 2, unset: 0 };

/** Build a full trace for one execution: root → agents → steps → tools. */
export function recordToSpans(record: ExecutionRecord): Span[] {
  const tid = traceId(record.executionId);
  const spans: Span[] = [];

  const rootId = spanId(`exec:${record.executionId}`);
  spans.push({
    traceId: tid,
    spanId: rootId,
    name: `agentops.execution.${record.mode}`,
    kind: "internal",
    startTime: record.startedAt,
    endTime: record.endedAt,
    status: record.status === "failed" || record.status === "circuit_open" ? "error" : record.endedAt ? "ok" : "unset",
    attributes: {
      "agentops.execution.id": record.executionId,
      "agentops.execution.mode": record.mode,
      "agentops.execution.status": record.status,
      "agentops.execution.outcome": record.outcome ?? "unknown",
      "agentops.user.id": record.userId ?? "",
      "agentops.conversation.id": record.conversationId ?? "",
      "agentops.tokens.total": record.metrics.totalTokens,
      "agentops.cost.usd": Math.round(record.metrics.estimatedCostUsd * 1e6),
      "agentops.latency.ms": record.metrics.latencyMs,
    },
  });

  const agentSpan = new Map<string, string>();
  for (const agent of record.agents) {
    const id = spanId(`agent:${agent.agentId}`);
    agentSpan.set(agent.agentId, id);
    spans.push({
      traceId: tid,
      spanId: id,
      parentSpanId: agent.parentAgentId ? agentSpan.get(agent.parentAgentId) ?? rootId : rootId,
      name: `agent.${agent.role}.${agent.label}`,
      kind: "internal",
      startTime: agent.startedAt,
      endTime: agent.endedAt,
      status: agent.endedAt ? "ok" : "unset",
      attributes: {
        "agentops.agent.id": agent.agentId,
        "agentops.agent.role": agent.role,
        "agentops.agent.depth": agent.depth,
        "agentops.agent.parent": agent.parentAgentId ?? "",
      },
    });
  }

  for (const step of record.steps) {
    spans.push({
      traceId: tid,
      spanId: spanId(`step:${step.stepId}`),
      parentSpanId: agentSpan.get(step.agentId) ?? rootId,
      name: `step.${step.label}`,
      kind: "client",
      startTime: step.startedAt,
      endTime: step.finishedAt,
      status: step.status === "failed" ? "error" : step.finishedAt ? "ok" : "unset",
      attributes: {
        "agentops.step.id": step.stepId,
        "agentops.model": step.model,
        "agentops.provider": step.provider,
        "agentops.tokens.total": step.usage.totalTokens,
        "agentops.tokens.in": step.usage.promptTokens,
        "agentops.tokens.out": step.usage.completionTokens,
        "agentops.attempts": step.attempts.length,
      },
    });
  }

  for (const tool of record.toolCalls) {
    spans.push({
      traceId: tid,
      spanId: spanId(`tool:${tool.toolId}:${tool.startedAt}`),
      parentSpanId: agentSpan.get(tool.agentId) ?? rootId,
      name: `tool.${tool.toolId}`,
      kind: "client",
      startTime: tool.startedAt,
      endTime: tool.finishedAt,
      status: tool.ok ? "ok" : "error",
      attributes: {
        "agentops.tool.id": tool.toolId,
        "agentops.tool.risk": tool.risk,
        "agentops.tool.approval_required": tool.approvalRequired,
        "agentops.tool.ok": tool.ok,
      },
    });
  }

  for (const loop of record.loops) {
    spans.push({
      traceId: tid,
      spanId: spanId(`loop:${loop.signature}:${loop.detectedAt}`),
      parentSpanId: rootId,
      name: `loop.${loop.loopKind}`,
      kind: "internal",
      startTime: loop.detectedAt,
      status: loop.action === "open" ? "error" : "ok",
      attributes: { "agentops.loop.kind": loop.loopKind, "agentops.loop.count": loop.count, "agentops.loop.action": loop.action },
    });
  }

  for (const circuit of record.circuitEvents) {
    spans.push({
      traceId: tid,
      spanId: spanId(`circuit:${circuit.trippedAt}`),
      parentSpanId: rootId,
      name: `circuit.${circuit.reason}`,
      kind: "internal",
      startTime: circuit.trippedAt,
      status: "error",
      attributes: {
        "agentops.circuit.reason": circuit.reason,
        "agentops.circuit.threshold": circuit.threshold,
        "agentops.circuit.actual": circuit.actual,
        "agentops.circuit.resolution": circuit.resolution,
      },
    });
  }

  for (const err of record.errors) {
    spans.push({
      traceId: tid,
      spanId: spanId(`err:${err.at}`),
      parentSpanId: (err.agentId && agentSpan.get(err.agentId)) || rootId,
      name: `error.${err.kind}`,
      kind: "internal",
      startTime: err.at,
      status: "error",
      attributes: { "agentops.error.kind": err.kind, "agentops.error.retryable": err.isRetryable, "agentops.error.message": err.message.slice(0, 200) },
    });
  }

  return spans;
}

/** Structured log lines derived from a record (no secrets, no PII payloads). */
export type LogRecord = {
  timestamp: number;
  severity: "INFO" | "WARN" | "ERROR";
  body: string;
  attributes: Record<string, string | number | boolean>;
};

export function recordToLogs(record: ExecutionRecord): LogRecord[] {
  const logs: LogRecord[] = [];
  for (const t of record.transitions) {
    logs.push({
      timestamp: t.at,
      severity: "INFO",
      body: `state ${t.from} -> ${t.to}`,
      attributes: { kind: "transition", executionId: record.executionId, reason: t.reason ?? "", operator: t.operatorId ?? "" },
    });
  }
  for (const err of record.errors) {
    logs.push({
      timestamp: err.at,
      severity: "ERROR",
      body: `[${err.kind}] ${err.message.slice(0, 200)}`,
      attributes: { kind: "error", executionId: record.executionId, retryable: err.isRetryable },
    });
  }
  for (const recovery of record.recoveries) {
    logs.push({
      timestamp: recovery.at,
      severity: "INFO",
      body: `recovery: ${recovery.strategy}`,
      attributes: { kind: "recovery", executionId: record.executionId },
    });
  }
  for (const loop of record.loops) {
    logs.push({
      timestamp: loop.detectedAt,
      severity: loop.action === "open" ? "ERROR" : "WARN",
      body: `loop detected: ${loop.loopKind} (count=${loop.count}, action=${loop.action})`,
      attributes: { kind: "loop", executionId: record.executionId },
    });
  }
  for (const circuit of record.circuitEvents) {
    logs.push({
      timestamp: circuit.trippedAt,
      severity: "ERROR",
      body: `circuit tripped: ${circuit.reason} (threshold=${circuit.threshold}, actual=${circuit.actual}, resolution=${circuit.resolution})`,
      attributes: { kind: "circuit", executionId: record.executionId },
    });
  }
  return logs;
}

/** OTLP/JSON export envelope (resourceSpans scope). */
export type OtlpExport = {
  resourceSpans: Array<{
    resource: { attributes: Array<{ key: string; value: { stringValue?: string; intValue?: number; boolValue?: boolean } }> };
    scopeSpans: Array<{
      scope: { name: string; version: string };
      spans: Array<{
        traceId: string;
        spanId: string;
        parentSpanId?: string;
        name: string;
        kind: number;
        startTimeUnixNano: string;
        endTimeUnixNano: string;
        status: { code: number };
        attributes: Array<{ key: string; value: { stringValue?: string; intValue?: number; boolValue?: boolean } }>;
      }>;
    }>;
  }>;
};

function attr(value: string | number | boolean): { stringValue?: string; intValue?: number; boolValue?: boolean } {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  return { intValue: value };
}

export function toOtlpJson(spans: Span[], serviceName = "qorvyna-agentops"): OtlpExport {
  const attributes = (a: Record<string, string | number | boolean>) =>
    Object.entries(a).map(([key, value]) => ({ key, value: attr(value) }));
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: serviceName } },
            { key: "telemetry.sdk.language", value: { stringValue: "nodejs" } },
            { key: "telemetry.sdk.name", value: { stringValue: "qorvyna-agentops" } },
          ],
        },
        scopeSpans: [
          {
            scope: { name: serviceName, version: "1.2.0" },
            spans: spans.map((s) => ({
              traceId: s.traceId,
              spanId: s.spanId,
              ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
              name: s.name,
              kind: KIND_NUM[s.kind],
              startTimeUnixNano: String(s.startTime * 1_000_000),
              endTimeUnixNano: String((s.endTime ?? s.startTime) * 1_000_000),
              status: { code: STATUS_NUM[s.status] },
              attributes: attributes(s.attributes),
            })),
          },
        ],
      },
    ],
  };
}

/** Aggregate metrics across many executions for dashboards (real data only). */
export function aggregateMetrics(records: ExecutionRecord[]) {
  const acc = {
    executions: records.length,
    running: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    circuitOpen: 0,
    totalTokens: 0,
    totalTokensIn: 0,
    totalTokensOut: 0,
    estimatedCostUsd: 0,
    costSource: "estimate" as "provider" | "estimate",
    avgLatencyMs: 0,
    toolCalls: 0,
    toolFailures: 0,
    retries: 0,
    errors: 0,
    loopsDetected: 0,
    circuitTrips: 0,
    childAgents: 0,
    modelsUsed: new Set<string>(),
    providersUsed: new Set<string>(),
  };
  let latencySum = 0;
  let latencyCount = 0;
  let anyProvider = false;
  for (const r of records) {
    acc.running += r.status === "running" ? 1 : 0;
    acc.completed += r.status === "completed" ? 1 : 0;
    acc.failed += r.status === "failed" || r.status === "circuit_open" ? 1 : 0;
    acc.cancelled += r.status === "cancelled" ? 1 : 0;
    acc.circuitOpen += r.status === "circuit_open" ? 1 : 0;
    acc.totalTokens += r.metrics.totalTokens;
    acc.totalTokensIn += r.metrics.totalTokensIn;
    acc.totalTokensOut += r.metrics.totalTokensOut;
    acc.estimatedCostUsd += r.metrics.estimatedCostUsd;
    if (r.metrics.costSource === "provider") anyProvider = true;
    if (r.metrics.latencyMs > 0) {
      latencySum += r.metrics.latencyMs;
      latencyCount += 1;
    }
    acc.toolCalls += r.metrics.toolCalls;
    acc.toolFailures += r.metrics.toolFailures;
    acc.retries += r.metrics.retries;
    acc.errors += r.metrics.errors;
    acc.loopsDetected += r.metrics.loopsDetected;
    acc.circuitTrips += r.metrics.circuitTrips;
    acc.childAgents += r.metrics.childAgents;
    for (const m of r.metrics.modelsUsed) acc.modelsUsed.add(m);
    for (const p of r.metrics.providersUsed) acc.providersUsed.add(p);
  }
  acc.avgLatencyMs = latencyCount ? Math.round(latencySum / latencyCount) : 0;
  acc.costSource = anyProvider ? "provider" : "estimate";
  return {
    ...acc,
    modelsUsed: [...acc.modelsUsed],
    providersUsed: [...acc.providersUsed],
  };
}
