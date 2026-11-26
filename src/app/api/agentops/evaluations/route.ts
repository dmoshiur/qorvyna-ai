import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { mutationCsrfResponse } from "@/lib/server/request-security";
import { createAIRoutesFromDb } from "@/lib/ai/config";
import { completeWithModel } from "@/lib/ai/executor";
import { defaultModel } from "@/lib/ai/models/registry";
import {
  agentOpsHandle,
  agentOpsStart,
  getServerAgentOps,
  HttpError,
  isPlatformAdmin,
  requireUser,
  safeAdminDb,
} from "@/lib/agentops/server";
import {
  buildResult,
  compareModels,
  computeRoi,
  estimateCost,
  summarizeRun,
} from "@/lib/agentops/evaluation";
import type {
  EvaluationDataset,
  EvaluationRun,
  ExecutionRecord,
} from "@/lib/agentops/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Built-in starter evaluation datasets (review P1-5). Each is small, deterministic
 * and maps to a headline capability so the Economics tab is usable on first open
 * without manual data entry. Ids are stable so re-seeding is idempotent. */
const STARTER_DATASETS: Array<{ id: string; name: string; description: string; cases: Array<{ prompt: string; expectedOutcome?: string; tags: string[] }> }> = [
  {
    id: "starter_arithmetic",
    name: "Arithmetic & reasoning",
    description: "Basic arithmetic and multi-step reasoning — a deterministic baseline for correctness.",
    cases: [
      { prompt: "Return the sum of 14 and 28. Reply with the number only.", expectedOutcome: "42", tags: ["arithmetic", "basic"] },
      { prompt: "What is 17 times 6? Reply with the number only.", expectedOutcome: "102", tags: ["arithmetic", "basic"] },
      { prompt: "A bag holds 3 apples. If you add 4 more, then eat 2, how many remain? Reply with the number only.", expectedOutcome: "5", tags: ["arithmetic", "reasoning"] },
      { prompt: "Return 100 divided by 8 as a decimal. Reply with the number only.", expectedOutcome: "12.5", tags: ["arithmetic", "decimal"] },
      { prompt: "If a train travels 60 km in 1.5 hours, its average speed in km/h is what? Reply with the number only.", expectedOutcome: "40", tags: ["arithmetic", "rate"] },
    ],
  },
  {
    id: "starter_json_extraction",
    name: "JSON extraction",
    description: "Extract structured fields from plain text into valid JSON — tests structured output reliability.",
    cases: [
      { prompt: 'From this sentence return JSON {"city": "...", "country": "..."}: "The capital of Bangladesh is Dhaka."', expectedOutcome: '{"city":"Dhaka","country":"Bangladesh"}', tags: ["json", "extraction"] },
      { prompt: 'From this sentence return JSON {"name": "...", "age": <number>}: "Alice is 28 years old."', expectedOutcome: '{"name":"Alice","age":28}', tags: ["json", "extraction"] },
      { prompt: 'From this sentence return JSON {"product": "...", "price": <number>}: "The laptop costs 1200 dollars."', expectedOutcome: '{"product":"laptop","price":1200}', tags: ["json", "extraction"] },
    ],
  },
  {
    id: "starter_codegen",
    name: "Short code generation",
    description: "Write a small, correct function — tests code correctness and safety on a minimal surface.",
    cases: [
      { prompt: "Write a Python function `add(a, b)` that returns the sum. Reply with only the code.", expectedOutcome: "def add(a, b):", tags: ["code", "python"] },
      { prompt: "Write a JavaScript function that returns the length of a given array. Reply with only the code.", expectedOutcome: "function", tags: ["code", "javascript"] },
      { prompt: "Write a Python one-liner using a list comprehension that squares every element of a list `x`. Reply with only the code.", expectedOutcome: "[i * i", tags: ["code", "python", "comprehension"] },
    ],
  },
];

function computeWorkflowEconomics(records: ExecutionRecord[]) {
  const byWorkflow = new Map<
    string,
    {
      mode: string;
      executions: number;
      succeeded: number;
      failed: number;
      tokensIn: number;
      tokensOut: number;
      totalTokens: number;
      costUsd: number;
      costSource: "provider" | "estimate";
      latencySum: number;
      latencyCount: number;
    }
  >();

  const byModel = new Map<
    string,
    {
      model: string;
      tokensIn: number;
      tokensOut: number;
      totalTokens: number;
      costUsd: number;
      costSource: "provider" | "estimate";
      steps: number;
      failures: number;
    }
  >();

  const toolMap = new Map<string, { toolId: string; calls: number; successes: number; failures: number; avgDurationMs: number; durSum: number }>();

  for (const r of records) {
    const wf = byWorkflow.get(r.mode) ?? {
      mode: r.mode,
      executions: 0,
      succeeded: 0,
      failed: 0,
      tokensIn: 0,
      tokensOut: 0,
      totalTokens: 0,
      costUsd: 0,
      costSource: "estimate" as const,
      latencySum: 0,
      latencyCount: 0,
    };
    wf.executions += 1;
    if (r.status === "completed") wf.succeeded += 1;
    if (r.status === "failed" || r.status === "circuit_open") wf.failed += 1;
    wf.tokensIn += r.metrics.totalTokensIn;
    wf.tokensOut += r.metrics.totalTokensOut;
    wf.totalTokens += r.metrics.totalTokens;
    wf.costUsd += r.metrics.estimatedCostUsd;
    if (r.metrics.costSource === "provider") wf.costSource = "provider";
    if (r.metrics.latencyMs > 0) {
      wf.latencySum += r.metrics.latencyMs;
      wf.latencyCount += 1;
    }
    byWorkflow.set(r.mode, wf);

    for (const [model, usage] of Object.entries(r.usageByModel)) {
      const m = byModel.get(model) ?? {
        model,
        tokensIn: 0,
        tokensOut: 0,
        totalTokens: 0,
        costUsd: 0,
        costSource: "estimate" as const,
        steps: 0,
        failures: 0,
      };
      m.tokensIn += usage.promptTokens;
      m.tokensOut += usage.completionTokens;
      m.totalTokens += usage.totalTokens;
      const { costUsd, source } = estimateCost(usage, model);
      m.costUsd += costUsd;
      if (source === "provider") m.costSource = "provider";
      byModel.set(model, m);
    }

    for (const s of r.steps) {
      const m = byModel.get(s.model);
      if (m) {
        m.steps += 1;
        if (s.status === "failed") m.failures += 1;
      }
    }

    for (const tc of r.toolCalls) {
      const t = toolMap.get(tc.toolId) ?? {
        toolId: tc.toolId,
        calls: 0,
        successes: 0,
        failures: 0,
        avgDurationMs: 0,
        durSum: 0,
      };
      t.calls += 1;
      if (tc.ok) t.successes += 1;
      else t.failures += 1;
      t.durSum += tc.durationMs;
      t.avgDurationMs = Math.round(t.durSum / t.calls);
      toolMap.set(tc.toolId, t);
    }
  }

  const totalTerminal = records.filter((r) => ["completed", "failed", "cancelled", "circuit_open"].includes(r.status)).length;
  const totalSucceeded = records.filter((r) => r.status === "completed").length;

  return {
    reliability: {
      totalExecutions: records.length,
      terminalExecutions: totalTerminal,
      succeededExecutions: totalSucceeded,
      reliabilityRate: totalTerminal > 0 ? totalSucceeded / totalTerminal : null,
    },
    workflows: [...byWorkflow.values()].map((w) => ({
      mode: w.mode,
      executions: w.executions,
      succeeded: w.succeeded,
      failed: w.failed,
      successRate: w.executions > 0 ? w.succeeded / w.executions : 0,
      tokensIn: w.tokensIn,
      tokensOut: w.tokensOut,
      totalTokens: w.totalTokens,
      costUsd: w.costUsd,
      costSource: w.costSource,
      avgLatencyMs: w.latencyCount > 0 ? Math.round(w.latencySum / w.latencyCount) : 0,
    })),
    modelUsage: [...byModel.values()],
    toolStats: [...toolMap.values()].map(({ durSum: _d, ...rest }) => ({
      ...rest,
      successRate: rest.calls > 0 ? rest.successes / rest.calls : 0,
    })),
  };
}

export async function GET(req: NextRequest) {
  try {
    const user = await requireUser(req);
    const db = safeAdminDb();
    const admin = await isPlatformAdmin(db, user.uid);
    const url = new URL(req.url);
    const scopeAll = admin && url.searchParams.get("scope") === "all";
    const datasetId = url.searchParams.get("datasetId")?.trim() || undefined;
    const roiRunId = url.searchParams.get("roiRunId")?.trim() || undefined;
    const baselineRaw = url.searchParams.get("baselineCostUsdPerTask");
    const valueRaw = url.searchParams.get("valuePerSuccessUsd");

    const engine = getServerAgentOps();
    const storage = engine.getStorage();
    const [allDatasets, allRuns, records] = await Promise.all([
      storage.listDatasets(),
      storage.listRuns(datasetId),
      engine.listExecutions({ ...(scopeAll ? {} : { userId: user.uid }), limit: 200 }),
    ]);

    const datasets = scopeAll ? allDatasets : allDatasets.filter((d) => d.createdBy === user.uid);
    const visibleDatasetIds = new Set(datasets.map((d) => d.id));
    const runs = scopeAll ? allRuns : allRuns.filter((r) => visibleDatasetIds.has(r.datasetId));

    let roi: { roiUsd: number; basis: string } | null = null;
    if (roiRunId) {
      const targetRun = runs.find((r) => r.id === roiRunId);
      if (targetRun) {
        const baselineCostUsdPerTask = baselineRaw != null && baselineRaw !== "" ? Number(baselineRaw) : undefined;
        const valuePerSuccessUsd = valueRaw != null && valueRaw !== "" ? Number(valueRaw) : undefined;
        roi =
          computeRoi({
            run: targetRun,
            baselineCostUsdPerTask: Number.isFinite(baselineCostUsdPerTask) ? baselineCostUsdPerTask : undefined,
            valuePerSuccessUsd: Number.isFinite(valuePerSuccessUsd) ? valuePerSuccessUsd : undefined,
          }) ?? null;
      }
    }

    return NextResponse.json({
      datasets,
      runs,
      modelComparison: compareModels(runs),
      economics: computeWorkflowEconomics(records),
      roi,
    });
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}

const caseSchema = z.object({
  id: z.string().min(1).max(80).optional(),
  prompt: z.string().min(1).max(4000),
  expectedOutcome: z.string().max(1000).optional(),
  tags: z.array(z.string().max(40)).max(10).default([]),
});

const postSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create_dataset"),
    name: z.string().min(1).max(120),
    description: z.string().max(600).default(""),
    cases: z.array(caseSchema).min(1).max(50),
  }),
  z.object({
    action: z.literal("seed_starter_datasets"),
  }),
  z.object({
    action: z.literal("run_live"),
    datasetId: z.string().min(1).max(120),
    agentConfig: z.string().max(120).default("default"),
    baselineCostUsdPerTask: z.number().min(0).max(10_000).optional(),
    valuePerSuccessUsd: z.number().min(0).max(10_000).optional(),
  }),
  z.object({
    action: z.literal("record_run"),
    datasetId: z.string().min(1).max(120),
    agentConfig: z.string().max(120).default("recorded"),
    model: z.string().min(1).max(120).optional(),
    results: z
      .array(
        z.object({
          caseId: z.string().min(1).max(80),
          success: z.boolean(),
          latencyMs: z.number().min(0).max(3_600_000),
          tokensIn: z.number().int().min(0).max(2_000_000),
          tokensOut: z.number().int().min(0).max(2_000_000),
          providerCostUsd: z.number().min(0).optional(),
          notes: z.string().max(400).optional(),
        }),
      )
      .min(1)
      .max(100),
    baselineCostUsdPerTask: z.number().min(0).max(10_000).optional(),
    valuePerSuccessUsd: z.number().min(0).max(10_000).optional(),
  }),
]);

export async function POST(req: NextRequest) {
  const csrf = mutationCsrfResponse(req);
  if (csrf) return csrf;
  try {
    const user = await requireUser(req);
    const db = safeAdminDb();
    const admin = await isPlatformAdmin(db, user.uid);
    let body: z.infer<typeof postSchema>;
    try {
      body = postSchema.parse(await req.json());
    } catch {
      return NextResponse.json({ error: "BAD_REQUEST" }, { status: 400 });
    }

    const engine = getServerAgentOps();
    const storage = engine.getStorage();

    if (body.action === "create_dataset") {
      const dataset: EvaluationDataset = {
        id: `ds_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`,
        name: body.name.trim(),
        description: body.description.trim(),
        createdBy: user.uid,
        createdAt: Date.now(),
        cases: body.cases.map((c, idx) => ({
          id: c.id?.trim() || `case_${idx + 1}`,
          prompt: c.prompt.trim(),
          expectedOutcome: c.expectedOutcome?.trim() || undefined,
          tags: c.tags,
        })),
      };
      await storage.putDataset(dataset);
      return NextResponse.json({ ok: true, dataset });
    }

    if (body.action === "seed_starter_datasets") {
      // Idempotent: only create a starter set that this user has not already
      // created, so the Economics tab is usable on first open (review P1-5).
      const existing = new Set((await storage.listDatasets()).map((d) => d.id));
      const created: EvaluationDataset[] = [];
      for (const starter of STARTER_DATASETS) {
        if (existing.has(starter.id)) continue;
        const dataset: EvaluationDataset = {
          id: starter.id,
          name: starter.name,
          description: starter.description,
          createdBy: user.uid,
          createdAt: Date.now(),
          cases: starter.cases.map((c, idx) => ({
            id: `case_${idx + 1}`,
            prompt: c.prompt,
            expectedOutcome: c.expectedOutcome,
            tags: c.tags,
          })),
        };
        await storage.putDataset(dataset);
        created.push(dataset);
      }
      return NextResponse.json({ ok: true, created, datasets: await storage.listDatasets() });
    }

    const dataset = await storage.getDataset(body.datasetId);
    if (!dataset || (dataset.createdBy !== user.uid && !admin)) {
      return NextResponse.json({ error: "NOT_FOUND", message: "Dataset not found." }, { status: 404 });
    }

    if (body.action === "record_run") {
      const modelId = body.model ?? defaultModel().id;
      const results = body.results.map((r) =>
        buildResult({
          caseId: r.caseId,
          success: r.success,
          latencyMs: r.latencyMs,
          tokensIn: r.tokensIn,
          tokensOut: r.tokensOut,
          model: modelId,
          providerCostUsd: r.providerCostUsd,
          notes: r.notes,
        }),
      );
      const summary = summarizeRun(results);
      const run: EvaluationRun = {
        id: `eval_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`,
        datasetId: dataset.id,
        agentConfig: body.agentConfig,
        model: modelId,
        startedAt: Date.now(),
        endedAt: Date.now(),
        status: "completed",
        results,
        summary,
      };
      const roi = computeRoi({
        run,
        baselineCostUsdPerTask: body.baselineCostUsdPerTask,
        valuePerSuccessUsd: body.valuePerSuccessUsd,
      });
      if (roi) {
        run.summary.roiUsd = roi.roiUsd;
        run.summary.roiBasis = roi.basis;
      }
      await storage.putRun(run);
      return NextResponse.json({ ok: true, run });
    }

    // action === "run_live": execute against the real configured AI route.
    const routes = await createAIRoutesFromDb(db);
    if (!routes.length) {
      return NextResponse.json(
        {
          error: "AI_NOT_CONFIGURED",
          message: "No live AI provider credential is configured on this server to execute live evaluation prompts.",
        },
        { status: 503 },
      );
    }

    const runId = `eval_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
    const execId = `exec_${runId}`;
    const startedAt = Date.now();
    await agentOpsStart({
      executionId: execId,
      userId: user.uid,
      mode: "evaluation",
      modelPool: routes.map((r) => r.model),
    });

    const results = [];
    let usedModel = routes[0].model;
    for (const c of dataset.cases.slice(0, 20)) {
      const caseStart = Date.now();
      try {
        const res = await completeWithModel(routes, {
          messages: [{ role: "user", content: c.prompt }],
          temperature: 0,
          maxTokens: 1024,
          requestId: `${runId}_${c.id}`,
        });
        usedModel = res.target.model;
        const latencyMs = Math.max(1, Date.now() - caseStart);
        const content = (res.response.content ?? "").trim();
        const expected = c.expectedOutcome?.trim().toLowerCase();
        const success = expected ? content.toLowerCase().includes(expected) : content.length > 0;
        await agentOpsHandle({
          type: "step.done",
          executionId: execId,
          agentId: engine.rootAgentId(execId),
          stepId: `eval-${c.id}`,
          status: success ? "done" : "failed",
          model: res.target.model,
          attempts: [{ model: res.target.model, label: res.target.provider, outcome: "ok", detail: "live_eval" }],
          durationMs: latencyMs,
          usage: res.response.usage,
          detail: content.slice(0, 120),
          finishedAt: Date.now(),
        });
        results.push(
          buildResult({
            caseId: c.id,
            success,
            latencyMs,
            tokensIn: res.response.usage.promptTokens,
            tokensOut: res.response.usage.completionTokens,
            model: res.target.model,
            notes: expected ? (success ? "Matched expected outcome" : "Did not match expected substring") : "Non-empty response",
          }),
        );
      } catch (err) {
        const latencyMs = Math.max(1, Date.now() - caseStart);
        const msg = err instanceof Error ? err.message.slice(0, 160) : "provider_error";
        await agentOpsHandle({
          type: "error",
          executionId: execId,
          agentId: engine.rootAgentId(execId),
          stepId: `eval-${c.id}`,
          kind: "EVAL_CASE_ERROR",
          message: msg,
          isRetryable: false,
          at: Date.now(),
        });
        results.push(
          buildResult({
            caseId: c.id,
            success: false,
            latencyMs,
            tokensIn: 0,
            tokensOut: 0,
            model: usedModel,
            notes: msg,
          }),
        );
      }
    }

    const endedAt = Date.now();
    await agentOpsHandle({
      type: "execution.end",
      executionId: execId,
      status: "completed",
      outcome: results.every((r) => r.success) ? "success" : "model_failure",
      endedAt,
      totalDurationMs: Math.max(1, endedAt - startedAt),
    });

    const summary = summarizeRun(results);
    const run: EvaluationRun = {
      id: runId,
      datasetId: dataset.id,
      agentConfig: body.agentConfig,
      model: usedModel,
      startedAt,
      endedAt,
      status: "completed",
      results,
      summary,
    };
    const roi = computeRoi({
      run,
      baselineCostUsdPerTask: body.baselineCostUsdPerTask,
      valuePerSuccessUsd: body.valuePerSuccessUsd,
    });
    if (roi) {
      run.summary.roiUsd = roi.roiUsd;
      run.summary.roiBasis = roi.basis;
    }
    await storage.putRun(run);
    return NextResponse.json({ ok: true, run, executionId: execId });
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
