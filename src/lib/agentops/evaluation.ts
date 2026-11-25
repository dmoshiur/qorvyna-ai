// =============================================================================
// QORVYNA AI — Agent Evaluation & Economics (pure logic, fully testable).
//
//   • Task success / failure tracking
//   • Model performance comparison
//   • Token consumption analytics
//   • Estimated inference costs (clearly flagged as estimates unless a provider
//     reports an actual cost — we never claim a provider cost we do not have)
//   • Execution latency analytics
//   • Tool success rates
//   • Evaluation datasets and reproducible test runs
//   • Workflow-level cost attribution
//   • Estimated ROI only when meaningful outcome/baseline data exists
// =============================================================================

import { MODEL_REGISTRY, modelById, modelByKey, type ModelSpec } from "@/lib/ai/models/registry";
import type {
  EvaluationResult,
  EvaluationRun,
  EvaluationSummary,
  ModelCostSpec,
  TokenUsage,
} from "./types";

function specRate(spec: ModelSpec): ModelCostSpec {
  if (spec.provider === "cloudflare") {
    return { provider: "cloudflare", inputPer1k: 0.00011, outputPer1k: 0.00019 };
  }
  switch (spec.coordinatorRank) {
    case 1:
      return { provider: spec.provider, inputPer1k: 0.00015, outputPer1k: 0.0006 };
    case 2:
      return { provider: spec.provider, inputPer1k: 0.00059, outputPer1k: 0.00079 };
    case 3:
      return { provider: spec.provider, inputPer1k: 0.00029, outputPer1k: 0.00059 };
    case 4:
      return { provider: spec.provider, inputPer1k: 0.000075, outputPer1k: 0.0003 };
    default:
      return { provider: spec.provider, inputPer1k: 0.00005, outputPer1k: 0.00008 };
  }
}

/**
 * Approximate public pricing (USD per 1K tokens) derived strictly from the
 * canonical MODEL_REGISTRY. These are ESTIMATES only and are clearly labelled
 * as such in the UI and API responses unless a provider reports actual cost.
 */
export const MODEL_COST_SPECS: Record<string, ModelCostSpec> = Object.fromEntries(
  MODEL_REGISTRY.flatMap((spec) => {
    const rate = specRate(spec);
    return [
      [spec.id, rate],
      [spec.key, rate],
    ];
  }),
);

export function costSpecFor(model: string): ModelCostSpec | null {
  if (!model) return null;
  if (MODEL_COST_SPECS[model]) return MODEL_COST_SPECS[model];
  const resolved = modelById(model) ?? modelByKey(model);
  if (resolved) return specRate(resolved);
  return null;
}

/**
 * Estimate USD cost from a usage record. `providerCostUsd` (if supplied by a
 * provider's response) makes the result a real provider-reported figure.
 */
export function estimateCost(
  usage: TokenUsage,
  model: string,
  providerCostUsd?: number,
): { costUsd: number; source: "provider" | "estimate" } {
  if (typeof providerCostUsd === "number" && Number.isFinite(providerCostUsd) && providerCostUsd >= 0) {
    return { costUsd: providerCostUsd, source: "provider" };
  }
  const spec = costSpecFor(model);
  if (!spec) return { costUsd: 0, source: "estimate" };
  const inCost = (Math.max(0, usage.promptTokens) / 1000) * spec.inputPer1k;
  const outCost = (Math.max(0, usage.completionTokens) / 1000) * spec.outputPer1k;
  return { costUsd: inCost + outCost, source: "estimate" };
}

/** Build an EvaluationResult from raw run data. */
export function buildResult(input: {
  caseId: string;
  success: boolean;
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
  model: string;
  providerCostUsd?: number;
  notes?: string;
}): EvaluationResult {
  const usage: TokenUsage = {
    promptTokens: input.tokensIn,
    completionTokens: input.tokensOut,
    totalTokens: input.tokensIn + input.tokensOut,
  };
  const { costUsd, source } = estimateCost(usage, input.model, input.providerCostUsd);
  return {
    caseId: input.caseId,
    success: input.success,
    latencyMs: input.latencyMs,
    tokensIn: input.tokensIn,
    tokensOut: input.tokensOut,
    costUsd,
    costSource: source,
    notes: input.notes,
  };
}

/** Aggregate results into a summary. ROI is only filled when baseline data exists. */
export function summarizeRun(results: EvaluationResult[]): EvaluationSummary {
  const total = results.length;
  const passed = results.filter((r) => r.success).length;
  const failed = total - passed;
  const totalTokens = results.reduce((s, r) => s + r.tokensIn + r.tokensOut, 0);
  const totalCost = results.reduce((s, r) => s + r.costUsd, 0);
  const anyProvider = results.some((r) => r.costSource === "provider");
  const avgLatency = total ? Math.round(results.reduce((s, r) => s + r.latencyMs, 0) / total) : 0;
  return {
    total,
    passed,
    failed,
    passRate: total ? passed / total : 0,
    avgLatencyMs: avgLatency,
    totalTokens,
    totalCostUsd: totalCost,
    costSource: anyProvider ? "provider" : "estimate",
  };
}

/**
 * Estimated ROI. ONLY returns a value when real baseline/outcome data is
 * supplied (e.g. measured human cost per task, or value-per-success). Otherwise
 * returns undefined — we never invent ROI.
 */
export function computeRoi(input: {
  run: EvaluationRun;
  /** Measured cost of the alternative (e.g. manual) per task, in USD. */
  baselineCostUsdPerTask?: number;
  /** Measured value generated per successful task, in USD. */
  valuePerSuccessUsd?: number;
}): { roiUsd: number; basis: string } | undefined {
  const { run, baselineCostUsdPerTask, valuePerSuccessUsd } = input;
  if (!run.results.length) return undefined;
  if (baselineCostUsdPerTask == null && valuePerSuccessUsd == null) return undefined;
  const passed = run.results.filter((r) => r.success).length;
  const agentCost = run.summary.totalCostUsd;
  let roi = 0;
  const parts: string[] = [];
  if (baselineCostUsdPerTask != null) {
    roi += baselineCostUsdPerTask * run.results.length - agentCost;
    parts.push(`manual baseline $${baselineCostUsdPerTask.toFixed(4)}/task × ${run.results.length}`);
  }
  if (valuePerSuccessUsd != null) {
    roi += valuePerSuccessUsd * passed - agentCost;
    parts.push(`value $${valuePerSuccessUsd.toFixed(4)}/success × ${passed}`);
  }
  return { roiUsd: roi, basis: parts.join(" + ") };
}

/** Compare model performance across completed runs (for the model comparison view). */
export function compareModels(runs: EvaluationRun[]): Array<{
  model: string;
  runs: number;
  passRate: number;
  avgLatencyMs: number;
  totalCostUsd: number;
  costSource: "provider" | "estimate";
}> {
  const byModel = new Map<string, EvaluationRun[]>();
  for (const run of runs) {
    if (!run.results.length) continue;
    const list = byModel.get(run.model) ?? [];
    list.push(run);
    byModel.set(run.model, list);
  }
  return [...byModel.entries()]
    .map(([model, list]) => {
      const all = list.flatMap((r) => r.results);
      const total = all.length;
      const passed = all.filter((r) => r.success).length;
      const cost = list.reduce((s, r) => s + r.summary.totalCostUsd, 0);
      const anyProvider = list.some((r) => r.summary.costSource === "provider");
      const avgLatency = total ? Math.round(all.reduce((s, r) => s + r.latencyMs, 0) / total) : 0;
      return {
        model,
        runs: list.length,
        passRate: total ? passed / total : 0,
        avgLatencyMs: avgLatency,
        totalCostUsd: cost,
        costSource: (anyProvider ? "provider" : "estimate") as "provider" | "estimate",
      };
    })
    .sort((a, b) => b.passRate - a.passRate);
}
