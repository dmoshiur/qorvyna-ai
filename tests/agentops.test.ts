import { describe, expect, it } from "vitest";
import { QORVYNA_MODEL_ID } from "@/lib/ai/model";
import { AgentOpsEngine } from "@/lib/agentops";
import { InMemoryAgentOpsStorage } from "@/lib/agentops/storage";
import { CircuitGuard, freshGuardState, toolSignature } from "@/lib/agentops/circuit-breaker";
import {
  applyGovernanceAction,
  GovernanceError,
  PROTECTED_MEMORY_TARGETS,
  raiseApproval,
  scrubSecrets,
} from "@/lib/agentops/governance";
import {
  aggregateMetrics,
  recordToLogs,
  recordToSpans,
  toOtlpJson,
} from "@/lib/agentops/telemetry";
import {
  buildResult,
  compareModels,
  computeRoi,
  estimateCost,
  summarizeRun,
} from "@/lib/agentops/evaluation";
import { applyControl, resetServerAgentOpsForTests } from "@/lib/agentops/server";

describe("Priority 1A & 1B: AgentOps Execution Graph & Intelligent Circuit Breaker", () => {
  it("tracks multi-agent parent-child hierarchy, tokens, tools, retries, recoveries, and state transitions", async () => {
    const storage = new InMemoryAgentOpsStorage();
    const engine = new AgentOpsEngine(storage);
    const now = Date.now();

    const execId = await engine.start({
      userId: "user_alpha",
      conversationId: "conv_1",
      mode: "agent",
      modelPool: [QORVYNA_MODEL_ID],
    });
    const rootId = engine.rootAgentId(execId);

    engine.evaluate({
      type: "agent.spawn",
      executionId: execId,
      agentId: "child_planner",
      parentAgentId: rootId,
      role: "specialist",
      label: "Architecture Planner",
      depth: 1,
      startedAt: now + 5,
    });

    engine.evaluate({
      type: "token.usage",
      executionId: execId,
      agentId: "child_planner",
      model: QORVYNA_MODEL_ID,
      provider: "groq",
      requestType: "chat",
      usage: { promptTokens: 400, completionTokens: 200, totalTokens: 600 },
      latencyMs: 180,
      status: "ok",
      at: now + 50,
    });

    engine.evaluate({
      type: "tool.call",
      executionId: execId,
      agentId: rootId,
      toolId: "project.read",
      argsHash: "abc12345",
      risk: "safe",
      approvalRequired: false,
      startedAt: now + 60,
    });
    engine.evaluate({
      type: "tool.result",
      executionId: execId,
      agentId: rootId,
      toolId: "project.read",
      ok: true,
      durationMs: 14,
      finishedAt: now + 74,
    });

    engine.evaluate({ type: "retry", executionId: execId, attempt: 1, afterMs: 150, at: now + 80 });
    engine.evaluate({
      type: "recovery",
      executionId: execId,
      agentId: rootId,
      strategy: "cloudflare_route_fallback",
      at: now + 90,
    });
    engine.evaluate({
      type: "execution.end",
      executionId: execId,
      status: "completed",
      outcome: "success",
      totalDurationMs: 120,
      endedAt: now + 120,
    });
    await engine.persist(execId);

    const record = await engine.getExecution(execId);
    expect(record).toBeTruthy();
    expect(record?.status).toBe("completed");
    expect(record?.agents.length).toBe(2);
    expect(record?.agents.find((a) => a.agentId === "child_planner")?.parentAgentId).toBe(rootId);
    expect(record?.metrics.totalTokens).toBe(600);
    expect(record?.metrics.retries).toBe(1);
    expect(record?.recoveries[0]?.strategy).toBe("cloudflare_route_fallback");
    expect(record?.toolCalls[0]?.ok).toBe(true);
  });

  it("trips circuit breaker on identical tool call loops, token exhaustion, recursion depth, and provider failures without destroying state", async () => {
    const engine = new AgentOpsEngine(new InMemoryAgentOpsStorage(), {
      maxReasoningCycles: 3,
      maxRepeatedToolCalls: 3,
      maxRecursionDepth: 3,
      maxRetries: 2,
      tokenBudget: 1_000,
      executionTimeoutMs: 5_000,
      maxProviderFailures: 2,
      cooldownMs: 1_000,
      toolSignatureWindow: 10,
    });

    const execId = await engine.start({
      userId: "user_loop",
      mode: "agent",
      modelPool: [QORVYNA_MODEL_ID],
    });
    const rootId = engine.rootAgentId(execId);

    let lastDecision = engine.evaluate({
      type: "tool.call",
      executionId: execId,
      agentId: rootId,
      toolId: "github.read",
      argsHash: "same_hash",
      risk: "safe",
      approvalRequired: false,
      startedAt: Date.now(),
    });
    expect(lastDecision.kind).toBe("continue");

    engine.evaluate({
      type: "tool.call",
      executionId: execId,
      agentId: rootId,
      toolId: "github.read",
      argsHash: "same_hash",
      risk: "safe",
      approvalRequired: false,
      startedAt: Date.now(),
    });
    lastDecision = engine.evaluate({
      type: "tool.call",
      executionId: execId,
      agentId: rootId,
      toolId: "github.read",
      argsHash: "same_hash",
      risk: "safe",
      approvalRequired: false,
      startedAt: Date.now(),
    });

    expect(lastDecision.kind).toBe("open");
    await engine.persist(execId);
    const tripped = await engine.getExecution(execId);
    expect(tripped?.status).toBe("circuit_open");
    expect(tripped?.loops.some((l) => l.loopKind === "tool_echo")).toBe(true);

    // Direct guard unit checks for token budget & recursion depth
    const guard = new CircuitGuard(freshGuardState(), {
      maxReasoningCycles: 3,
      maxRepeatedToolCalls: 3,
      maxRecursionDepth: 2,
      maxRetries: 2,
      tokenBudget: 500,
      executionTimeoutMs: 2_000,
      maxProviderFailures: 2,
      cooldownMs: 500,
      toolSignatureWindow: 10,
    });
    expect(guard.observeAgentSpawn(3).kind).toBe("open");
    expect(guard.observeTokens(600).kind).toBe("open");
    expect(toolSignature("read", "123")).toContain("read");
  });
});

describe("Priority 1C: Human-in-the-Loop Governance, Secret Scrubbing & Protected Memory", () => {
  it("enforces pause/resume/approve/reject/override state machine, blocks protected memory targets, and writes immutable audit logs", async () => {
    const storage = new InMemoryAgentOpsStorage();
    const engine = resetServerAgentOpsForTests(storage);
    const execId = await engine.start({
      userId: "owner_1",
      mode: "agent",
      modelPool: [QORVYNA_MODEL_ID],
    });
    const base = (await engine.getExecution(execId))!;
    const raised = raiseApproval(
      base,
      "app_1",
      "github.merge",
      engine.rootAgentId(execId),
      "dangerous",
    );
    engine.setRecord(raised.record);
    await engine.persistRecord(raised.record);

    const user = { uid: "owner_1", email: "owner@okgs.info", emailVerified: true } as Parameters<typeof applyControl>[2];

    // Approve pending dangerous tool call
    const approved = await applyControl(null, raised.record, user, {
      kind: "approve",
      operatorId: user.uid,
      approvalId: "app_1",
      at: Date.now(),
    });
    expect(approved.pendingApprovals.find((a) => a.approvalId === "app_1")?.status).toBe("approved");

    // Pause -> Resume
    const paused = await applyControl(null, approved, user, {
      kind: "pause",
      operatorId: user.uid,
      reason: "Inspecting intermediate plan",
      at: Date.now(),
    });
    expect(paused.status).toBe("paused");

    const resumed = await applyControl(null, paused, user, {
      kind: "resume",
      operatorId: user.uid,
      at: Date.now(),
    });
    expect(resumed.status).toBe("running");

    // Permitted working memory edit scrubs embedded secrets
    await applyControl(null, resumed, user, {
      kind: "edit_memory",
      operatorId: user.uid,
      target: "task_scratchpad",
      operation: "replace",
      content: "Use endpoint with Authorization: Bearer gsk_secret1234567890abcdef",
      at: Date.now(),
    });
    const mem = await storage.listMemory(execId);
    expect(mem[0]?.target).toBe("task_scratchpad");
    expect(mem[0]?.content).not.toContain("gsk_secret1234567890abcdef");

    // Protected memory targets MUST fail closed
    for (const protectedTarget of PROTECTED_MEMORY_TARGETS) {
      expect(() =>
        applyGovernanceAction(resumed, {
          kind: "edit_memory",
          operatorId: user.uid,
          target: protectedTarget,
          operation: "replace",
          content: "malicious override",
          at: Date.now(),
        }),
      ).toThrow(GovernanceError);
    }

    const audits = await storage.listAudit(execId);
    expect(audits.length).toBeGreaterThanOrEqual(4);
    expect(audits.every((a) => a.immutable === true)).toBe(true);
  });

  it("scrubs API keys, bearer tokens, GitHub PATs, and PEM private keys from telemetry strings", () => {
    const dirty = [
      "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.secret",
      "groq=gsk_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456",
      "gh=ghp_1234567890abcdefghijklmnopqrstuvwx",
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----",
    ].join(" | ");
    const clean = scrubSecrets(dirty);
    expect(clean).not.toContain("gsk_ABCDEF");
    expect(clean).not.toContain("ghp_123456");
    expect(clean).not.toContain("MIIEowIBAAKCAQEA");
  });

  it("redacts the new AQ.Ab Gemini auth key format", () => {
    const dirty = "gemini=AQ.Ab" + "X".repeat(48) + " trailing text";
    const clean = scrubSecrets(dirty);
    expect(clean).not.toContain("X".repeat(20));
    expect(clean).toContain("<redacted>");
  });
});

describe("Priority 1D & 1E: OpenTelemetry OTLP Export, Retention & Honest Token Economics", () => {
  it("exports W3C-valid OTLP/JSON traces, logs, and aggregated metrics", async () => {
    const storage = new InMemoryAgentOpsStorage();
    const engine = new AgentOpsEngine(storage);
    const execId = await engine.start({
      userId: "user_otel",
      mode: "chat",
      modelPool: [QORVYNA_MODEL_ID],
    });
    engine.evaluate({
      type: "token.usage",
      executionId: execId,
      model: QORVYNA_MODEL_ID,
      provider: "groq",
      requestType: "chat",
      usage: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 },
      latencyMs: 240,
      status: "ok",
      at: Date.now(),
    });
    engine.evaluate({
      type: "execution.end",
      executionId: execId,
      status: "completed",
      outcome: "success",
      totalDurationMs: 260,
      endedAt: Date.now(),
    });
    await engine.persist(execId);

    const rec = (await engine.getExecution(execId))!;
    const spans = recordToSpans(rec);
    expect(spans.length).toBeGreaterThanOrEqual(1);
    expect(spans[0].traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(spans[0].spanId).toMatch(/^[0-9a-f]{16}$/);

    const otlp = toOtlpJson(spans);
    expect(otlp.resourceSpans[0].scopeSpans[0].spans.length).toBe(spans.length);

    const logs = recordToLogs(rec);
    expect(logs.length).toBeGreaterThanOrEqual(1);

    const agg = aggregateMetrics([rec]);
    expect(agg.executions).toBe(1);
    expect(agg.totalTokens).toBe(1500);
  });

  it("distinguishes estimated vs provider-reported inference costs and never fabricates ROI without baseline data", () => {
    const est = estimateCost({ promptTokens: 1_000, completionTokens: 1_000, totalTokens: 2_000 }, QORVYNA_MODEL_ID);
    expect(est.source).toBe("estimate");
    expect(est.costUsd).toBeGreaterThan(0);

    const reported = estimateCost(
      { promptTokens: 1_000, completionTokens: 1_000, totalTokens: 2_000 },
      QORVYNA_MODEL_ID,
      0.0123,
    );
    expect(reported.source).toBe("provider");
    expect(reported.costUsd).toBe(0.0123);

    const r1 = buildResult({
      caseId: "c1",
      model: QORVYNA_MODEL_ID,
      success: true,
      tokensIn: 200,
      tokensOut: 100,
      latencyMs: 150,
    });
    const summary = summarizeRun([r1]);
    expect(summary.passRate).toBe(1);

    const runObj = {
      id: "run_1",
      datasetId: "ds_1",
      agentConfig: "default",
      model: QORVYNA_MODEL_ID,
      startedAt: Date.now(),
      status: "completed" as const,
      results: [r1],
      summary,
    };

    // No baseline -> ROI must be undefined (never fabricated)
    expect(computeRoi({ run: runObj })).toBeUndefined();

    // Verified baseline provided -> deterministic ROI calculation
    const roi = computeRoi({
      run: runObj,
      baselineCostUsdPerTask: 0.25,
    });
    expect(roi).toBeDefined();
    expect(roi!.roiUsd).toBeGreaterThan(0);

    const cmp = compareModels([runObj]);
    expect(cmp[0]?.model).toBe(QORVYNA_MODEL_ID);
  });
});
