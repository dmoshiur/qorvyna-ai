"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Cpu,
  Download,
  Eye,
  GitBranch,
  Layers,
  Lock,
  Pause,
  Play,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Sliders,
  Sparkles,
  Square,
  Trash2,
  Wrench,
} from "lucide-react";
import { Alert, Button, Card, Input, Spinner } from "@/components/ui";
import { cn } from "@/lib/utils";
import type {
  AuditEntry,
  CircuitBreakerConfig,
  ControlledMemoryEntry,
  EvaluationDataset,
  EvaluationRun,
  ExecutionRecord,
  ObservabilityConfig,
  Span,
} from "@/lib/agentops/types";

type AggregatedMetrics = {
  executions: number;
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
  circuitOpen: number;
  totalTokens: number;
  totalTokensIn: number;
  totalTokensOut: number;
  estimatedCostUsd: number;
  costSource: "provider" | "estimate";
  avgLatencyMs: number;
  toolCalls: number;
  toolFailures: number;
  retries: number;
  errors: number;
  loopsDetected: number;
  circuitTrips: number;
  childAgents: number;
  modelsUsed: string[];
  providersUsed: string[];
};

type LogItem = {
  timestamp: number;
  severity: "INFO" | "WARN" | "ERROR";
  body: string;
  attributes: Record<string, string | number | boolean>;
};

type WorkflowEconomics = {
  reliability: {
    totalExecutions: number;
    terminalExecutions: number;
    succeededExecutions: number;
    reliabilityRate: number | null;
  };
  workflows: Array<{
    mode: string;
    executions: number;
    succeeded: number;
    failed: number;
    successRate: number;
    tokensIn: number;
    tokensOut: number;
    totalTokens: number;
    costUsd: number;
    costSource: "provider" | "estimate";
    avgLatencyMs: number;
  }>;
  modelUsage: Array<{
    model: string;
    tokensIn: number;
    tokensOut: number;
    totalTokens: number;
    costUsd: number;
    costSource: "provider" | "estimate";
    steps: number;
    failures: number;
  }>;
  toolStats: Array<{
    toolId: string;
    calls: number;
    successes: number;
    failures: number;
    avgDurationMs: number;
    successRate: number;
  }>;
};

type ModelComparisonRow = {
  model: string;
  runs: number;
  passRate: number;
  avgLatencyMs: number;
  totalCostUsd: number;
  costSource: "provider" | "estimate";
};

type TabId = "monitor" | "circuit" | "governance" | "telemetry" | "evaluation";

function statusTone(status: string): string {
  switch (status) {
    case "completed":
      return "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30";
    case "running":
    case "recovered":
      return "bg-sky-500/15 text-sky-600 dark:text-sky-400 border-sky-500/30";
    case "paused":
    case "awaiting_approval":
      return "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30";
    case "failed":
    case "circuit_open":
      return "bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30";
    default:
      return "bg-surface-2 text-ink-2 border-border";
  }
}

function fmtUsd(value: number): string {
  if (!Number.isFinite(value) || value === 0) return "$0.000000";
  if (value < 0.01) return `$${value.toFixed(6)}`;
  return `$${value.toFixed(4)}`;
}

function fmtTs(ms?: number): string {
  if (!ms) return "—";
  try {
    return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return String(ms);
  }
}

export function AgentOpsControlCenter() {
  const [tab, setTab] = useState<TabId>("monitor");
  const [livePoll, setLivePoll] = useState(true);
  const [scope, setScope] = useState<"mine" | "all">("mine");
  const [statusFilter, setStatusFilter] = useState("");
  const [modeFilter, setModeFilter] = useState("");

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<{ tone: "info" | "danger" | "success"; text: string } | null>(null);

  const [isAdmin, setIsAdmin] = useState(false);
  const [executions, setExecutions] = useState<ExecutionRecord[]>([]);
  const [metrics, setMetrics] = useState<AggregatedMetrics | null>(null);
  const [circuitConfig, setCircuitConfig] = useState<CircuitBreakerConfig | null>(null);
  const [obsConfig, setObsConfig] = useState<ObservabilityConfig | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{
    execution: ExecutionRecord;
    spans: Span[];
    logs: LogItem[];
    otlp: unknown;
    audit: AuditEntry[];
    memory: ControlledMemoryEntry[];
  } | null>(null);

  // Governance form state
  const [controlReason, setControlReason] = useState("");
  const [overrideDecision, setOverrideDecision] = useState("resume_with_operator_supervision");
  const [memTarget, setMemTarget] = useState("working_notes");
  const [memOp, setMemOp] = useState<"append" | "replace" | "delete">("append");
  const [memContent, setMemContent] = useState("");

  // Telemetry state
  const [logSeverity, setLogSeverity] = useState<"ALL" | "INFO" | "WARN" | "ERROR">("ALL");

  // Evaluation & Economics state
  const [datasets, setDatasets] = useState<EvaluationDataset[]>([]);
  const [runs, setRuns] = useState<EvaluationRun[]>([]);
  const [modelComparison, setModelComparison] = useState<ModelComparisonRow[]>([]);
  const [economics, setEconomics] = useState<WorkflowEconomics | null>(null);
  const [dsName, setDsName] = useState("");
  const [dsDesc, setDsDesc] = useState("");
  const [dsCasesText, setDsCasesText] = useState("");
  const [selectedDatasetId, setSelectedDatasetId] = useState("");
  const [baselineCost, setBaselineCost] = useState("");
  const [valuePerSuccess, setValuePerSuccess] = useState("");
  const [computedRoi, setComputedRoi] = useState<{ roiUsd: number; basis: string } | null>(null);
  const [selectedRunForRoi, setSelectedRunForRoi] = useState("");

  const loadList = useCallback(async () => {
    const params = new URLSearchParams();
    if (scope === "all") params.set("scope", "all");
    if (statusFilter) params.set("status", statusFilter);
    if (modeFilter) params.set("mode", modeFilter);
    params.set("limit", "60");
    const res = await fetch(`/api/agentops/executions?${params.toString()}`, { cache: "no-store" });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || err.error || "Failed to load AgentOps executions");
    }
    const data = await res.json();
    setExecutions(data.executions ?? []);
    setMetrics(data.metrics ?? null);
    setCircuitConfig((prev) => prev ?? data.circuitConfig ?? null);
    setObsConfig((prev) => prev ?? data.observabilityConfig ?? null);
    setIsAdmin(Boolean(data.isAdmin));
    setSelectedId((cur) => {
      if (cur && (data.executions ?? []).some((e: ExecutionRecord) => e.executionId === cur)) return cur;
      return data.executions?.[0]?.executionId ?? null;
    });
  }, [scope, statusFilter, modeFilter]);

  const loadDetail = useCallback(async (id: string) => {
    const res = await fetch(`/api/agentops/executions/${encodeURIComponent(id)}`, { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    setDetail(data);
  }, []);

  const loadEvaluations = useCallback(async () => {
    const params = new URLSearchParams();
    if (scope === "all") params.set("scope", "all");
    const res = await fetch(`/api/agentops/evaluations?${params.toString()}`, { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    setDatasets(data.datasets ?? []);
    setRuns(data.runs ?? []);
    setModelComparison(data.modelComparison ?? []);
    setEconomics(data.economics ?? null);
    if (!selectedDatasetId && data.datasets?.[0]?.id) {
      setSelectedDatasetId(data.datasets[0].id);
    }
    if (!selectedRunForRoi && data.runs?.[0]?.id) {
      setSelectedRunForRoi(data.runs[0].id);
    }
  }, [scope, selectedDatasetId, selectedRunForRoi]);

  const refreshAll = useCallback(async () => {
    try {
      await loadList();
      if (tab === "evaluation") await loadEvaluations();
    } catch (err) {
      setBanner({ tone: "danger", text: err instanceof Error ? err.message : "Failed to refresh AgentOps data" });
    } finally {
      setLoading(false);
    }
  }, [loadList, loadEvaluations, tab]);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  useEffect(() => {
    if (selectedId) void loadDetail(selectedId);
    else setDetail(null);
  }, [selectedId, loadDetail]);

  useEffect(() => {
    if (!livePoll) return;
    const timer = setInterval(() => {
      void loadList().catch(() => {});
      if (selectedId) void loadDetail(selectedId).catch(() => {});
    }, 4000);
    return () => clearInterval(timer);
  }, [livePoll, loadList, loadDetail, selectedId]);

  const activeExec = detail?.execution ?? executions.find((e) => e.executionId === selectedId) ?? null;

  const allPendingApprovals = useMemo(() => {
    return executions.flatMap((exec) =>
      exec.pendingApprovals
        .filter((p) => p.status === "pending")
        .map((p) => ({ ...p, executionId: exec.executionId, mode: exec.mode })),
    );
  }, [executions]);

  async function sendControl(executionId: string, payload: Record<string, unknown>) {
    setBusy(true);
    setBanner(null);
    try {
      const res = await fetch(`/api/agentops/executions/${encodeURIComponent(executionId)}/control`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.message || data.error || "Control operation rejected");
      }
      setBanner({ tone: "success", text: `Governance action "${String(payload.kind)}" recorded to immutable audit log.` });
      await loadList();
      await loadDetail(executionId);
    } catch (err) {
      setBanner({ tone: "danger", text: err instanceof Error ? err.message : "Governance action failed" });
    } finally {
      setBusy(false);
    }
  }

  async function saveGlobalConfig() {
    if (!circuitConfig || !obsConfig) return;
    setBusy(true);
    setBanner(null);
    try {
      const res = await fetch("/api/agentops/executions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update_config",
          circuit: circuitConfig,
          observability: obsConfig,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || data.error || "Could not update configuration");
      setCircuitConfig(data.circuitConfig);
      setObsConfig(data.observabilityConfig);
      setBanner({ tone: "success", text: "AgentOps circuit breaker and observability settings updated." });
    } catch (err) {
      setBanner({ tone: "danger", text: err instanceof Error ? err.message : "Failed to save settings" });
    } finally {
      setBusy(false);
    }
  }

  async function pruneExpiredRecords() {
    setBusy(true);
    setBanner(null);
    try {
      const res = await fetch("/api/agentops/executions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "prune_retention",
          retentionDays: obsConfig?.retentionDays,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || data.error || "Prune failed");
      setBanner({ tone: "info", text: `Retention check complete: ${data.pruned ?? 0} expired terminal execution(s) pruned.` });
      await loadList();
    } catch (err) {
      setBanner({ tone: "danger", text: err instanceof Error ? err.message : "Retention prune failed" });
    } finally {
      setBusy(false);
    }
  }

  function downloadOtlpJson() {
    if (!detail?.otlp) return;
    const blob = new Blob([JSON.stringify(detail.otlp, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `qorvyna-otlp-${detail.execution.executionId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function createDataset() {
    const lines = dsCasesText
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (!dsName.trim() || lines.length === 0) {
      setBanner({ tone: "danger", text: "Provide a dataset name and at least one prompt line." });
      return;
    }
    const cases = lines.map((line, i) => {
      const [promptPart, expectedPart] = line.split("=>").map((s) => s.trim());
      return {
        id: `case_${i + 1}`,
        prompt: promptPart,
        ...(expectedPart ? { expectedOutcome: expectedPart } : {}),
        tags: [],
      };
    });
    setBusy(true);
    setBanner(null);
    try {
      const res = await fetch("/api/agentops/evaluations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create_dataset",
          name: dsName.trim(),
          description: dsDesc.trim(),
          cases,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || data.error || "Could not create dataset");
      setDsName("");
      setDsDesc("");
      setDsCasesText("");
      setSelectedDatasetId(data.dataset.id);
      setBanner({ tone: "success", text: `Created evaluation dataset "${data.dataset.name}" (${cases.length} cases).` });
      await loadEvaluations();
    } catch (err) {
      setBanner({ tone: "danger", text: err instanceof Error ? err.message : "Dataset creation failed" });
    } finally {
      setBusy(false);
    }
  }

  async function runLiveEvaluation() {
    if (!selectedDatasetId) return;
    setBusy(true);
    setBanner(null);
    try {
      const bCost = baselineCost.trim() !== "" ? Number(baselineCost) : undefined;
      const vSuccess = valuePerSuccess.trim() !== "" ? Number(valuePerSuccess) : undefined;
      const res = await fetch("/api/agentops/evaluations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "run_live",
          datasetId: selectedDatasetId,
          agentConfig: "live_gateway",
          ...(Number.isFinite(bCost) ? { baselineCostUsdPerTask: bCost } : {}),
          ...(Number.isFinite(vSuccess) ? { valuePerSuccessUsd: vSuccess } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || data.error || "Live evaluation failed");
      setBanner({
        tone: "success",
        text: `Evaluation run ${data.run.id} finished: ${data.run.summary.passed}/${data.run.summary.total} passed.`,
      });
      await Promise.all([loadEvaluations(), loadList()]);
    } catch (err) {
      setBanner({ tone: "danger", text: err instanceof Error ? err.message : "Live evaluation failed" });
    } finally {
      setBusy(false);
    }
  }

  async function calculateRunRoi() {
    if (!selectedRunForRoi) return;
    const params = new URLSearchParams({ roiRunId: selectedRunForRoi });
    if (baselineCost.trim() !== "") params.set("baselineCostUsdPerTask", baselineCost.trim());
    if (valuePerSuccess.trim() !== "") params.set("valuePerSuccessUsd", valuePerSuccess.trim());
    const res = await fetch(`/api/agentops/evaluations?${params.toString()}`, { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    setComputedRoi(data.roi ?? null);
  }

  const filteredLogs = useMemo(() => {
    const list = detail?.logs ?? [];
    if (logSeverity === "ALL") return list;
    return list.filter((l) => l.severity === logSeverity);
  }, [detail?.logs, logSeverity]);

  const spanBounds = useMemo(() => {
    const spans = detail?.spans ?? [];
    if (!spans.length) return { min: 0, span: 1 };
    const min = Math.min(...spans.map((s) => s.startTime));
    const max = Math.max(...spans.map((s) => s.endTime ?? s.startTime + 1));
    return { min, span: Math.max(1, max - min) };
  }, [detail?.spans]);

  return (
    <div className="mx-auto max-w-7xl space-y-6 py-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="eyebrow">QORVYNA AI · CloudCampBD AgentOps</p>
          <h1 className="mt-1 text-2xl font-semibold text-ink">AgentOps Control Center</h1>
          <p className="mt-1 text-sm text-ink-2">
            Real-time runtime monitoring, intelligent circuit breaking, human-in-the-loop governance, OpenTelemetry traces, and evaluation economics. Every metric below comes strictly from actual runtime events.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {isAdmin ? (
            <select
              aria-label="Execution visibility scope"
              value={scope}
              onChange={(e) => setScope(e.target.value as "mine" | "all")}
              className="input-base !w-auto !py-2 text-xs"
            >
              <option value="mine">My executions</option>
              <option value="all">Platform-wide (Admin)</option>
            </select>
          ) : null}
          <button
            type="button"
            onClick={() => setLivePoll((v) => !v)}
            className={cn(
              "inline-flex min-h-9 items-center gap-1.5 rounded-lg border px-3 text-xs font-medium transition-colors",
              livePoll ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "border-border bg-surface text-ink-2",
            )}
          >
            <Activity size={14} />
            {livePoll ? "Live polling (4s)" : "Polling paused"}
          </button>
          <Button variant="secondary" onClick={() => void refreshAll()} disabled={busy}>
            <RefreshCw size={14} className={cn("mr-1.5", busy && "animate-spin")} />
            Refresh
          </Button>
        </div>
      </div>

      {banner ? (
        <Alert tone={banner.tone}>
          {banner.text}
        </Alert>
      ) : null}

      {/* Real-time KPI summary strip */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Card className="!p-4">
          <p className="text-xs font-medium text-ink-3">Observed Executions</p>
          <p className="mt-1 text-2xl font-semibold text-ink">{metrics?.executions ?? 0}</p>
          <p className="mt-1 text-xs text-ink-2">
            {metrics?.running ?? 0} running · {metrics?.completed ?? 0} ok · {metrics?.failed ?? 0} failed
          </p>
        </Card>
        <Card className="!p-4">
          <p className="text-xs font-medium text-ink-3">Tokens (In / Out)</p>
          <p className="mt-1 text-2xl font-semibold text-ink">{(metrics?.totalTokens ?? 0).toLocaleString()}</p>
          <p className="mt-1 text-xs text-ink-2">
            In {(metrics?.totalTokensIn ?? 0).toLocaleString()} · Out {(metrics?.totalTokensOut ?? 0).toLocaleString()}
          </p>
        </Card>
        <Card className="!p-4">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-ink-3">Inference Cost</p>
            <span className="rounded border border-border bg-surface-2 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-ink-2">
              {metrics?.costSource ?? "estimate"}
            </span>
          </div>
          <p className="mt-1 text-2xl font-semibold text-ink">{fmtUsd(metrics?.estimatedCostUsd ?? 0)}</p>
          <p className="mt-1 text-xs text-ink-2">
            {metrics?.costSource === "provider" ? "Includes provider-reported cost" : "Estimated from registry rates"}
          </p>
        </Card>
        <Card className="!p-4">
          <p className="text-xs font-medium text-ink-3">Avg Latency & Tools</p>
          <p className="mt-1 text-2xl font-semibold text-ink">{metrics?.avgLatencyMs ?? 0} ms</p>
          <p className="mt-1 text-xs text-ink-2">
            {metrics?.toolCalls ?? 0} tool calls ({metrics?.toolFailures ?? 0} failed)
          </p>
        </Card>
        <Card className="!p-4">
          <p className="text-xs font-medium text-ink-3">Safety & Circuit Guard</p>
          <p className="mt-1 text-2xl font-semibold text-ink">{metrics?.circuitTrips ?? 0} trips</p>
          <p className="mt-1 text-xs text-ink-2">
            {metrics?.loopsDetected ?? 0} loops · {metrics?.retries ?? 0} retries · {allPendingApprovals.length} pending approvals
          </p>
        </Card>
      </div>

      {/* Section tabs */}
      <div className="flex flex-wrap gap-1.5 border-b border-border pb-2" role="tablist" aria-label="AgentOps sections">
        {(
          [
            { id: "monitor", label: "Live Monitor & Lifecycle", icon: Eye },
            { id: "circuit", label: "Circuit Breaker", icon: ShieldAlert },
            { id: "governance", label: `HITL Governance${allPendingApprovals.length ? ` (${allPendingApprovals.length})` : ""}`, icon: ShieldCheck },
            { id: "telemetry", label: "OpenTelemetry Traces", icon: Layers },
            { id: "evaluation", label: "Evaluation & Economics", icon: Sparkles },
          ] as const
        ).map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={cn(
              "inline-flex min-h-10 items-center gap-2 rounded-lg px-3.5 text-xs font-semibold transition-colors",
              tab === id ? "bg-accent-solid text-accent-ink" : "text-ink-2 hover:bg-surface-2 hover:text-ink",
            )}
          >
            <Icon size={15} />
            {label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Spinner />
        </div>
      ) : null}

      {/* TAB 1: LIVE MONITOR & LIFECYCLE */}
      {!loading && tab === "monitor" ? (
        <div className="grid gap-6 lg:grid-cols-12">
          <div className="space-y-3 lg:col-span-5">
            <Card className="space-y-3 !p-4">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-ink">Execution History</h2>
                <span className="text-xs text-ink-3">{executions.length} loaded</span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <select
                  aria-label="Filter by status"
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                  className="input-base !py-1.5 text-xs"
                >
                  <option value="">All statuses</option>
                  <option value="running">running</option>
                  <option value="paused">paused</option>
                  <option value="awaiting_approval">awaiting_approval</option>
                  <option value="completed">completed</option>
                  <option value="failed">failed</option>
                  <option value="cancelled">cancelled</option>
                  <option value="circuit_open">circuit_open</option>
                </select>
                <Input
                  placeholder="Filter mode (e.g. agent)"
                  value={modeFilter}
                  onChange={(e) => setModeFilter(e.target.value)}
                  className="!py-1.5 text-xs"
                />
              </div>

              {executions.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border p-6 text-center text-xs text-ink-3">
                  No runtime executions recorded yet for this filter. Send a chat message, run Agent mode, or execute an Agent Studio tool to stream live events here.
                </div>
              ) : (
                <ul className="max-h-[540px] space-y-1.5 overflow-y-auto pr-1">
                  {executions.map((exec) => (
                    <li key={exec.executionId}>
                      <button
                        type="button"
                        onClick={() => setSelectedId(exec.executionId)}
                        className={cn(
                          "w-full rounded-xl border p-3 text-left transition-colors",
                          selectedId === exec.executionId
                            ? "border-accent bg-accent-soft/40"
                            : "border-border bg-surface hover:bg-surface-2",
                        )}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate font-mono text-xs font-semibold text-ink">{exec.executionId}</span>
                          <span className={cn("rounded-full border px-2 py-0.5 text-[10px] font-semibold", statusTone(exec.status))}>
                            {exec.status}
                          </span>
                        </div>
                        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-2">
                          <span>mode: <strong>{exec.mode}</strong></span>
                          <span>tokens: {exec.metrics.totalTokens.toLocaleString()}</span>
                          <span>steps: {exec.steps.length}</span>
                          <span>tools: {exec.toolCalls.length}</span>
                          <span>{fmtTs(exec.startedAt)}</span>
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          <div className="space-y-4 lg:col-span-7">
            {!activeExec ? (
              <Card className="p-8 text-center text-sm text-ink-3">
                Select an execution on the left to inspect its lifecycle, parent-child agent hierarchy, recursive loops, tool timeline, and model metrics.
              </Card>
            ) : (
              <>
                <Card className="space-y-3 !p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="font-mono text-xs text-ink-3">{activeExec.executionId}</p>
                      <h3 className="text-base font-semibold text-ink">
                        Mode: {activeExec.mode} {activeExec.outcome ? `· Outcome: ${activeExec.outcome}` : ""}
                      </h3>
                    </div>
                    <span className={cn("rounded-full border px-2.5 py-1 text-xs font-semibold", statusTone(activeExec.status))}>
                      {activeExec.status}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                    <div className="rounded-lg bg-surface-2 p-2.5">
                      <span className="block text-ink-3">Duration</span>
                      <strong className="text-ink">{activeExec.totalDurationMs ?? Math.max(0, Date.now() - activeExec.startedAt)} ms</strong>
                    </div>
                    <div className="rounded-lg bg-surface-2 p-2.5">
                      <span className="block text-ink-3">Tokens In / Out</span>
                      <strong className="text-ink">{activeExec.metrics.totalTokensIn} / {activeExec.metrics.totalTokensOut}</strong>
                    </div>
                    <div className="rounded-lg bg-surface-2 p-2.5">
                      <span className="block text-ink-3">Cost ({activeExec.metrics.costSource})</span>
                      <strong className="text-ink">{fmtUsd(activeExec.metrics.estimatedCostUsd)}</strong>
                    </div>
                    <div className="rounded-lg bg-surface-2 p-2.5">
                      <span className="block text-ink-3">Models</span>
                      <strong className="truncate block text-ink">{activeExec.metrics.modelsUsed.join(", ") || "—"}</strong>
                    </div>
                  </div>
                </Card>

                {/* Parent-Child & Recursive Agent Graph */}
                <Card className="space-y-3 !p-4">
                  <div className="flex items-center justify-between">
                    <h4 className="flex items-center gap-1.5 text-sm font-semibold text-ink">
                      <GitBranch size={15} /> Parent-Child & Recursive Agent Graph
                    </h4>
                    <span className="text-xs text-ink-3">
                      {activeExec.agents.length} agent node(s) · max depth {activeExec.guard.recursionDepth}
                    </span>
                  </div>
                  {activeExec.agents.length === 0 ? (
                    <p className="text-xs text-ink-3">No agent nodes recorded.</p>
                  ) : (
                    <ul className="space-y-1.5">
                      {activeExec.agents.map((node) => (
                        <li
                          key={node.agentId}
                          style={{ marginLeft: `${Math.min(node.depth, 6) * 18}px` }}
                          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-surface-2/60 px-3 py-2 text-xs"
                        >
                          <div className="flex items-center gap-2">
                            <Cpu size={13} className="text-accent" />
                            <span className="font-semibold text-ink">{node.label}</span>
                            <span className="rounded bg-surface px-1.5 py-0.5 text-[10px] uppercase text-ink-3">{node.role}</span>
                            <span className="text-[11px] text-ink-3">depth {node.depth}</span>
                          </div>
                          <span className="font-mono text-[11px] text-ink-3">
                            {node.parentAgentId ? `parent: ${node.parentAgentId.slice(-10)}` : "root"}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {activeExec.loops.length > 0 ? (
                    <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs text-amber-700 dark:text-amber-300">
                      <strong>Recursive / Loop Signals ({activeExec.loops.length}):</strong>{" "}
                      {activeExec.loops.map((l, idx) => `${l.loopKind} (×${l.count}, ${l.action})`).join(" · ")}
                    </div>
                  ) : null}
                </Card>

                {/* Step & Model Timeline */}
                <Card className="space-y-3 !p-4">
                  <h4 className="flex items-center gap-1.5 text-sm font-semibold text-ink">
                    <Clock size={15} /> Model & Step Timeline ({activeExec.steps.length})
                  </h4>
                  {activeExec.steps.length === 0 ? (
                    <p className="text-xs text-ink-3">No model steps recorded on this execution yet.</p>
                  ) : (
                    <ul className="space-y-2">
                      {activeExec.steps.map((s) => (
                        <li key={s.stepId} className="rounded-lg border border-border p-2.5 text-xs">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-semibold text-ink">{s.label}</span>
                            <span className={cn("rounded border px-1.5 py-0.5 text-[10px] font-semibold", statusTone(s.status === "done" ? "completed" : s.status))}>
                              {s.status}
                            </span>
                          </div>
                          <div className="mt-1 flex flex-wrap gap-3 text-[11px] text-ink-2">
                            <span>model: {s.model}</span>
                            <span>tokens: {s.usage.promptTokens} in / {s.usage.completionTokens} out</span>
                            {s.durationMs != null ? <span>{s.durationMs} ms</span> : null}
                            {s.attempts.length > 1 ? <span>attempts: {s.attempts.length}</span> : null}
                          </div>
                          {s.detail ? <p className="mt-1 truncate text-[11px] text-ink-3">{s.detail}</p> : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>

                {/* Tool-Call Timeline */}
                <Card className="space-y-3 !p-4">
                  <h4 className="flex items-center gap-1.5 text-sm font-semibold text-ink">
                    <Wrench size={15} /> Tool-Call Timeline ({activeExec.toolCalls.length})
                  </h4>
                  {activeExec.toolCalls.length === 0 ? (
                    <p className="text-xs text-ink-3">No tool invocations recorded for this execution.</p>
                  ) : (
                    <ul className="space-y-1.5">
                      {activeExec.toolCalls.map((tc, idx) => (
                        <li key={`${tc.toolId}-${idx}`} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-2.5 text-xs">
                          <div>
                            <span className="font-mono font-semibold text-ink">{tc.toolId}</span>
                            <span className="ml-2 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-ink-2">risk: {tc.risk}</span>
                            {tc.approvalRequired ? (
                              <span className="ml-1.5 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-600 dark:text-amber-400">approval-gated</span>
                            ) : null}
                            <span className="ml-2 font-mono text-[10px] text-ink-3">hash:{tc.argsHash.slice(0, 10)}</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-[11px] text-ink-3">{tc.durationMs} ms</span>
                            <span className={cn("rounded border px-1.5 py-0.5 text-[10px] font-semibold", tc.ok ? statusTone("completed") : statusTone("failed"))}>
                              {tc.ok ? "ok" : tc.error || "failed"}
                            </span>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>

                {/* State transitions + Errors/Recoveries */}
                <div className="grid gap-4 sm:grid-cols-2">
                  <Card className="space-y-2 !p-4">
                    <h4 className="text-sm font-semibold text-ink">State Transitions ({activeExec.transitions.length})</h4>
                    {activeExec.transitions.length === 0 ? (
                      <p className="text-xs text-ink-3">None</p>
                    ) : (
                      <ul className="space-y-1 text-xs">
                        {activeExec.transitions.map((t, idx) => (
                          <li key={idx} className="flex items-center justify-between gap-2 text-ink-2">
                            <span>
                              {t.from} → <strong className="text-ink">{t.to}</strong>
                              {t.reason ? ` (${t.reason})` : ""}
                            </span>
                            <span className="text-[10px] text-ink-3">{fmtTs(t.at)}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </Card>
                  <Card className="space-y-2 !p-4">
                    <h4 className="text-sm font-semibold text-ink">
                      Errors ({activeExec.errors.length}) & Recoveries ({activeExec.recoveries.length})
                    </h4>
                    {activeExec.errors.length === 0 && activeExec.recoveries.length === 0 ? (
                      <p className="text-xs text-ink-3">Zero errors or fallback recoveries on this execution.</p>
                    ) : (
                      <ul className="space-y-1 text-xs">
                        {activeExec.errors.map((e, i) => (
                          <li key={`e-${i}`} className="text-rose-600 dark:text-rose-400">
                            [{e.kind}] {e.message}
                          </li>
                        ))}
                        {activeExec.recoveries.map((r, i) => (
                          <li key={`r-${i}`} className="text-emerald-600 dark:text-emerald-400">
                            Recovered via {r.strategy}
                          </li>
                        ))}
                      </ul>
                    )}
                  </Card>
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}

      {/* TAB 2: INTELLIGENT CIRCUIT BREAKER */}
      {!loading && tab === "circuit" ? (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card className="space-y-4 !p-5">
            <div className="flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-base font-semibold text-ink">
                <ShieldAlert size={17} /> Active Execution Guard State
              </h2>
              {activeExec ? (
                <span className={cn("rounded-full border px-2.5 py-0.5 text-xs font-semibold", activeExec.guard.open ? statusTone("circuit_open") : statusTone("completed"))}>
                  {activeExec.guard.open ? "CIRCUIT OPEN" : "HEALTHY / CLOSED"}
                </span>
              ) : null}
            </div>
            {!activeExec ? (
              <p className="text-xs text-ink-3">Select an execution in the Live Monitor tab to inspect its circuit guard counters.</p>
            ) : (
              <div className="space-y-3 text-xs">
                <p className="font-mono text-ink-3">Execution: {activeExec.executionId}</p>
                <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                  <div className="rounded-lg bg-surface-2 p-3">
                    <span className="text-ink-3">Reasoning Cycles</span>
                    <p className="mt-1 text-base font-semibold text-ink">
                      {activeExec.guard.reasoningCycles} / {circuitConfig?.maxReasoningCycles ?? "—"}
                    </p>
                  </div>
                  <div className="rounded-lg bg-surface-2 p-3">
                    <span className="text-ink-3">Recursion Depth</span>
                    <p className="mt-1 text-base font-semibold text-ink">
                      {activeExec.guard.recursionDepth} / {circuitConfig?.maxRecursionDepth ?? "—"}
                    </p>
                  </div>
                  <div className="rounded-lg bg-surface-2 p-3">
                    <span className="text-ink-3">Retries</span>
                    <p className="mt-1 text-base font-semibold text-ink">
                      {activeExec.guard.retries} / {circuitConfig?.maxRetries ?? "—"}
                    </p>
                  </div>
                  <div className="rounded-lg bg-surface-2 p-3">
                    <span className="text-ink-3">Consecutive Provider Fails</span>
                    <p className="mt-1 text-base font-semibold text-ink">
                      {activeExec.guard.consecutiveProviderFailures} / {circuitConfig?.maxProviderFailures ?? "—"}
                    </p>
                  </div>
                  <div className="rounded-lg bg-surface-2 p-3">
                    <span className="text-ink-3">Token Budget Used</span>
                    <p className="mt-1 text-base font-semibold text-ink">
                      {activeExec.guard.tokensConsumed.toLocaleString()} / {(circuitConfig?.tokenBudget ?? 0).toLocaleString()}
                    </p>
                  </div>
                  <div className="rounded-lg bg-surface-2 p-3">
                    <span className="text-ink-3">Tracked Tool Signatures</span>
                    <p className="mt-1 text-base font-semibold text-ink">
                      {Object.keys(activeExec.guard.repeatedToolSignatures).length}
                    </p>
                  </div>
                </div>
                {activeExec.circuitEvents.length > 0 ? (
                  <div className="space-y-1 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-rose-700 dark:text-rose-300">
                    <strong>Recorded Circuit Trips:</strong>
                    {activeExec.circuitEvents.map((ce, i) => (
                      <div key={i}>
                        • {ce.reason} (actual {ce.actual} vs limit {ce.threshold}) → resolution: <strong>{ce.resolution}</strong> at {fmtTs(ce.trippedAt)}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-ink-3">No circuit trips recorded for this execution. User data and agent availability remain intact.</p>
                )}
              </div>
            )}
          </Card>

          <Card className="space-y-4 !p-5">
            <div className="flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-base font-semibold text-ink">
                <Sliders size={17} /> Configurable Protection Thresholds
              </h2>
              {!isAdmin ? (
                <span className="inline-flex items-center gap-1 text-xs text-ink-3">
                  <Lock size={12} /> Admin editable
                </span>
              ) : null}
            </div>
            {circuitConfig ? (
              <div className="grid gap-3 sm:grid-cols-2 text-xs">
                {(
                  [
                    ["maxReasoningCycles", "Max Reasoning Cycles"],
                    ["maxRepeatedToolCalls", "Max Identical Tool Calls"],
                    ["maxRecursionDepth", "Max Recursive Agent Depth"],
                    ["maxRetries", "Max Retries"],
                    ["maxProviderFailures", "Max Consecutive Provider Failures"],
                    ["tokenBudget", "Token Budget per Execution"],
                    ["executionTimeoutMs", "Execution Timeout (ms)"],
                    ["cooldownMs", "Circuit Cooldown (ms)"],
                  ] as const
                ).map(([key, label]) => (
                  <label key={key} className="block space-y-1">
                    <span className="font-medium text-ink-2">{label}</span>
                    <Input
                      type="number"
                      disabled={!isAdmin || busy}
                      value={circuitConfig[key]}
                      onChange={(e) =>
                        setCircuitConfig((prev) =>
                          prev ? { ...prev, [key]: Number(e.target.value) } : prev,
                        )
                      }
                    />
                  </label>
                ))}
              </div>
            ) : null}
            {isAdmin ? (
              <div className="flex justify-end">
                <Button onClick={() => void saveGlobalConfig()} disabled={busy}>
                  Save Thresholds
                </Button>
              </div>
            ) : (
              <p className="text-xs text-ink-3">
                Thresholds protect executions at runtime without deleting user data or permanently disabling agents. Sign in with a platform admin role to adjust global limits.
              </p>
            )}
          </Card>
        </div>
      ) : null}

      {/* TAB 3: HUMAN-IN-THE-LOOP GOVERNANCE */}
      {!loading && tab === "governance" ? (
        <div className="grid gap-6 lg:grid-cols-12">
          <div className="space-y-4 lg:col-span-6">
            <Card className="space-y-4 !p-5">
              <h2 className="flex items-center gap-2 text-base font-semibold text-ink">
                <ShieldCheck size={17} /> Execution Lifecycle Controls
              </h2>
              {!activeExec ? (
                <p className="text-xs text-ink-3">Select an execution to pause, resume, cancel, or override circuit decisions.</p>
              ) : (
                <div className="space-y-3">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-mono text-ink-2">{activeExec.executionId}</span>
                    <span className={cn("rounded-full border px-2 py-0.5 font-semibold", statusTone(activeExec.status))}>
                      {activeExec.status}
                    </span>
                  </div>
                  <Input
                    placeholder="Operator reason (recorded in immutable audit log)"
                    value={controlReason}
                    onChange={(e) => setControlReason(e.target.value)}
                  />
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="secondary"
                      disabled={busy || !["running", "awaiting_approval", "recovered"].includes(activeExec.status)}
                      onClick={() => void sendControl(activeExec.executionId, { kind: "pause", reason: controlReason || undefined })}
                    >
                      <Pause size={14} className="mr-1.5" /> Pause
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={busy || activeExec.status !== "paused"}
                      onClick={() => void sendControl(activeExec.executionId, { kind: "resume", reason: controlReason || undefined })}
                    >
                      <Play size={14} className="mr-1.5" /> Resume
                    </Button>
                    <Button
                      variant="danger"
                      disabled={busy || ["completed", "failed", "cancelled", "circuit_open"].includes(activeExec.status)}
                      onClick={() => void sendControl(activeExec.executionId, { kind: "cancel", reason: controlReason || undefined })}
                    >
                      <Square size={14} className="mr-1.5" /> Cancel
                    </Button>
                  </div>
                  <div className="border-t border-border pt-3 space-y-2">
                    <p className="text-xs font-semibold text-ink">Override Eligible Circuit / Guard Decision</p>
                    <div className="flex gap-2">
                      <Input
                        value={overrideDecision}
                        onChange={(e) => setOverrideDecision(e.target.value)}
                        placeholder="Override decision code"
                      />
                      <Button
                        variant="secondary"
                        disabled={busy || !overrideDecision.trim()}
                        onClick={() =>
                          void sendControl(activeExec.executionId, {
                            kind: "override",
                            decision: overrideDecision.trim(),
                            reason: controlReason || undefined,
                          })
                        }
                      >
                        Override
                      </Button>
                    </div>
                  </div>
                </div>
              )}
            </Card>

            {/* Pending Tool Approvals Queue */}
            <Card className="space-y-3 !p-5">
              <h2 className="flex items-center gap-2 text-base font-semibold text-ink">
                <AlertTriangle size={17} /> Pending Tool Approvals ({allPendingApprovals.length})
              </h2>
              {allPendingApprovals.length === 0 ? (
                <p className="text-xs text-ink-3">No pending high-risk tool calls awaiting human sign-off.</p>
              ) : (
                <ul className="space-y-2">
                  {allPendingApprovals.map((item) => (
                    <li key={`${item.executionId}-${item.approvalId}`} className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-xs space-y-2">
                      <div className="flex items-center justify-between">
                        <strong className="font-mono text-ink">{item.toolId}</strong>
                        <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-700 dark:text-amber-300">
                          risk: {item.risk}
                        </span>
                      </div>
                      <p className="text-[11px] text-ink-2">
                        Execution: <span className="font-mono">{item.executionId}</span> · Approval ID: <span className="font-mono">{item.approvalId}</span>
                      </p>
                      <div className="flex gap-2">
                        <Button
                          disabled={busy}
                          onClick={() => void sendControl(item.executionId, { kind: "approve", approvalId: item.approvalId })}
                        >
                          <CheckCircle2 size={14} className="mr-1" /> Approve
                        </Button>
                        <Button
                          variant="danger"
                          disabled={busy}
                          onClick={() =>
                            void sendControl(item.executionId, {
                              kind: "reject",
                              approvalId: item.approvalId,
                              reason: controlReason || "Rejected by operator",
                            })
                          }
                        >
                          Reject
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          <div className="space-y-4 lg:col-span-6">
            {/* Controlled Agent Memory Editor */}
            <Card className="space-y-3 !p-5">
              <h2 className="text-base font-semibold text-ink">Controlled Agent Working Memory</h2>
              <p className="text-xs text-ink-2">
                Permitted working-memory targets (e.g. <code className="rounded bg-surface-2 px-1">working_notes</code>, <code className="rounded bg-surface-2 px-1">task_constraints</code>) can be edited with full auditability. System instructions, prompts, API keys and credentials are strictly protected and rejected server-side.
              </p>
              {activeExec ? (
                <div className="space-y-2.5 text-xs">
                  <div className="grid grid-cols-3 gap-2">
                    <div className="col-span-2">
                      <Input
                        value={memTarget}
                        onChange={(e) => setMemTarget(e.target.value)}
                        placeholder="Memory target (e.g. working_notes)"
                      />
                    </div>
                    <select
                      aria-label="Memory operation"
                      value={memOp}
                      onChange={(e) => setMemOp(e.target.value as "append" | "replace" | "delete")}
                      className="input-base text-xs"
                    >
                      <option value="append">append</option>
                      <option value="replace">replace</option>
                      <option value="delete">delete</option>
                    </select>
                  </div>
                  {memOp !== "delete" ? (
                    <textarea
                      rows={3}
                      value={memContent}
                      onChange={(e) => setMemContent(e.target.value)}
                      placeholder="Permitted working memory content (secrets are automatically scrubbed or rejected)"
                      className="input-base w-full text-xs"
                    />
                  ) : null}
                  <div className="flex justify-end">
                    <Button
                      variant="secondary"
                      disabled={busy || !memTarget.trim()}
                      onClick={() =>
                        void sendControl(activeExec.executionId, {
                          kind: "edit_memory",
                          target: memTarget.trim(),
                          operation: memOp,
                          content: memOp === "delete" ? undefined : memContent,
                          reason: controlReason || undefined,
                        })
                      }
                    >
                      Apply Memory Operation
                    </Button>
                  </div>
                  {(detail?.memory ?? []).length > 0 ? (
                    <div className="mt-2 space-y-1.5 border-t border-border pt-2">
                      <p className="font-semibold text-ink">Current Controlled Memory Entries:</p>
                      {(detail?.memory ?? []).map((m) => (
                        <div key={m.target} className="rounded bg-surface-2 p-2">
                          <div className="flex justify-between text-[11px] text-ink-3">
                            <strong className="font-mono text-ink">{m.target}</strong>
                            <span>by {m.updatedBy.slice(0, 10)} · {fmtTs(m.updatedAt)}</span>
                          </div>
                          <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px] text-ink-2">{m.content}</pre>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : (
                <p className="text-xs text-ink-3">Select an execution first.</p>
              )}
            </Card>

            {/* Immutable Audit Log */}
            <Card className="space-y-3 !p-5">
              <h2 className="text-base font-semibold text-ink">
                Immutable Governance Audit Trail ({detail?.audit?.length ?? 0})
              </h2>
              {!detail?.audit?.length ? (
                <p className="text-xs text-ink-3">No governance audit entries recorded for this execution yet.</p>
              ) : (
                <ul className="max-h-72 space-y-2 overflow-y-auto text-xs">
                  {detail.audit.map((a) => (
                    <li key={a.entryId} className="rounded-lg border border-border p-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono font-semibold text-ink">{a.action}</span>
                        <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-mono text-emerald-600 dark:text-emerald-400">
                          immutable
                        </span>
                      </div>
                      <p className="mt-1 text-ink-2">{a.detail}</p>
                      <p className="mt-1 font-mono text-[10px] text-ink-3">
                        {a.entryId} · actor {a.actorId.slice(0, 12)} · {fmtTs(a.at)}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </div>
      ) : null}

      {/* TAB 4: OPENTELEMETRY OBSERVABILITY */}
      {!loading && tab === "telemetry" ? (
        <div className="space-y-6">
          <Card className="space-y-4 !p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-base font-semibold text-ink">Distributed Trace Spans (OpenTelemetry-Compatible)</h2>
                <p className="text-xs text-ink-3">
                  {detail ? `Trace for ${detail.execution.executionId} (${detail.spans.length} spans)` : "Select an execution to inspect its trace waterfall."}
                </p>
              </div>
              <Button variant="secondary" disabled={!detail?.otlp} onClick={downloadOtlpJson}>
                <Download size={14} className="mr-1.5" /> Export OTLP/JSON
              </Button>
            </div>

            {!detail?.spans?.length ? (
              <p className="text-xs text-ink-3">No spans captured yet.</p>
            ) : (
              <div className="space-y-1.5">
                {detail.spans.map((s) => {
                  const leftPct = Math.min(95, Math.max(0, ((s.startTime - spanBounds.min) / spanBounds.span) * 100));
                  const dur = Math.max(1, (s.endTime ?? s.startTime + 1) - s.startTime);
                  const widthPct = Math.max(2, Math.min(100 - leftPct, (dur / spanBounds.span) * 100));
                  return (
                    <div key={s.spanId} className="rounded-lg border border-border p-2 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono font-medium text-ink">
                          {s.name} <span className="text-[10px] text-ink-3">[{s.kind}]</span>
                        </span>
                        <span className="font-mono text-[11px] text-ink-2">
                          {dur} ms · {s.status}
                        </span>
                      </div>
                      <div className="mt-1.5 h-2 w-full overflow-hidden rounded bg-surface-2">
                        <div
                          style={{ marginLeft: `${leftPct}%`, width: `${widthPct}%` }}
                          className={cn("h-full rounded", s.status === "error" ? "bg-rose-500" : "bg-accent-solid")}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card className="space-y-3 !p-5">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-ink">Structured Telemetry Logs ({filteredLogs.length})</h3>
                <select
                  aria-label="Filter log severity"
                  value={logSeverity}
                  onChange={(e) => setLogSeverity(e.target.value as "ALL" | "INFO" | "WARN" | "ERROR")}
                  className="input-base !w-auto !py-1 text-xs"
                >
                  <option value="ALL">All severities</option>
                  <option value="INFO">INFO</option>
                  <option value="WARN">WARN</option>
                  <option value="ERROR">ERROR</option>
                </select>
              </div>
              {filteredLogs.length === 0 ? (
                <p className="text-xs text-ink-3">No structured logs matching filter.</p>
              ) : (
                <ul className="max-h-72 space-y-1.5 overflow-y-auto font-mono text-[11px]">
                  {filteredLogs.map((l, idx) => (
                    <li key={idx} className="rounded bg-surface-2 p-2">
                      <span
                        className={cn(
                          "mr-2 font-bold",
                          l.severity === "ERROR" ? "text-rose-500" : l.severity === "WARN" ? "text-amber-500" : "text-sky-500",
                        )}
                      >
                        [{l.severity}]
                      </span>
                      <span className="text-ink">{l.body}</span>
                      <span className="ml-2 text-ink-3">{fmtTs(l.timestamp)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card className="space-y-3 !p-5">
              <h3 className="text-sm font-semibold text-ink">Observability Overhead & Privacy Retention</h3>
              <p className="text-xs text-ink-2">
                Secrets, bearer tokens, API keys and credentials are automatically redacted before persistence. Configure sampling overhead and retention window below.
              </p>
              {obsConfig ? (
                <div className="space-y-3 text-xs">
                  <label className="flex items-center justify-between">
                    <span className="text-ink">Telemetry collection enabled</span>
                    <input
                      type="checkbox"
                      disabled={!isAdmin || busy}
                      checked={obsConfig.enabled}
                      onChange={(e) => setObsConfig((p) => (p ? { ...p, enabled: e.target.checked } : p))}
                    />
                  </label>
                  <label className="flex items-center justify-between">
                    <span className="text-ink">Capture OTel spans per step</span>
                    <input
                      type="checkbox"
                      disabled={!isAdmin || busy}
                      checked={obsConfig.captureSpans}
                      onChange={(e) => setObsConfig((p) => (p ? { ...p, captureSpans: e.target.checked } : p))}
                    />
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="space-y-1">
                      <span className="text-ink-2">Sample Rate (0.0–1.0)</span>
                      <Input
                        type="number"
                        step="0.05"
                        min="0"
                        max="1"
                        disabled={!isAdmin || busy}
                        value={obsConfig.sampleRate}
                        onChange={(e) => setObsConfig((p) => (p ? { ...p, sampleRate: Number(e.target.value) } : p))}
                      />
                    </label>
                    <label className="space-y-1">
                      <span className="text-ink-2">Retention Window (days)</span>
                      <Input
                        type="number"
                        min="1"
                        max="365"
                        disabled={!isAdmin || busy}
                        value={obsConfig.retentionDays}
                        onChange={(e) => setObsConfig((p) => (p ? { ...p, retentionDays: Number(e.target.value) } : p))}
                      />
                    </label>
                  </div>
                  {isAdmin ? (
                    <div className="flex flex-wrap justify-end gap-2 pt-1">
                      <Button variant="secondary" disabled={busy} onClick={() => void pruneExpiredRecords()}>
                        <Trash2 size={14} className="mr-1.5" /> Prune Expired Telemetry
                      </Button>
                      <Button disabled={busy} onClick={() => void saveGlobalConfig()}>
                        Save Observability Config
                      </Button>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </Card>
          </div>
        </div>
      ) : null}

      {/* TAB 5: EVALUATION & ECONOMICS */}
      {!loading && tab === "evaluation" ? (
        <div className="space-y-6">
          {/* Workflow-level Cost Attribution & Reliability */}
          <Card className="space-y-3 !p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-base font-semibold text-ink">Workflow-Level Cost Attribution & Task Reliability</h2>
                <p className="text-xs text-ink-3">
                  Aggregated strictly from observed runtime executions. Costs derived from public token rates are explicitly marked <strong>ESTIMATE</strong> unless reported directly by a provider.
                </p>
              </div>
              <span className="text-xs font-medium text-ink-2">
                Overall Reliability:{" "}
                <strong>
                  {economics?.reliability.reliabilityRate != null
                    ? `${(economics.reliability.reliabilityRate * 100).toFixed(1)}% (${economics.reliability.succeededExecutions}/${economics.reliability.terminalExecutions})`
                    : "No terminal tasks yet"}
                </strong>
              </span>
            </div>

            {!economics?.workflows.length ? (
              <p className="text-xs text-ink-3">No workflow executions recorded yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-border text-ink-3">
                    <tr>
                      <th className="py-2 pr-3">Workflow / Mode</th>
                      <th className="py-2 pr-3">Runs</th>
                      <th className="py-2 pr-3">Success Rate</th>
                      <th className="py-2 pr-3">Tokens (In / Out)</th>
                      <th className="py-2 pr-3">Avg Latency</th>
                      <th className="py-2 pr-3">Cost</th>
                      <th className="py-2">Cost Basis</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {economics.workflows.map((w) => (
                      <tr key={w.mode}>
                        <td className="py-2 pr-3 font-semibold text-ink">{w.mode}</td>
                        <td className="py-2 pr-3">{w.executions}</td>
                        <td className="py-2 pr-3">{(w.successRate * 100).toFixed(1)}%</td>
                        <td className="py-2 pr-3">{w.tokensIn.toLocaleString()} / {w.tokensOut.toLocaleString()}</td>
                        <td className="py-2 pr-3">{w.avgLatencyMs} ms</td>
                        <td className="py-2 pr-3 font-mono">{fmtUsd(w.costUsd)}</td>
                        <td className="py-2">
                          <span className="rounded border border-border bg-surface-2 px-1.5 py-0.5 text-[10px] uppercase">
                            {w.costSource}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {/* Tool Success Rates & Model Performance Comparison */}
          <div className="grid gap-6 lg:grid-cols-2">
            <Card className="space-y-3 !p-5">
              <h3 className="text-sm font-semibold text-ink">Tool Execution Reliability</h3>
              {!economics?.toolStats.length ? (
                <p className="text-xs text-ink-3">No tool executions recorded yet.</p>
              ) : (
                <ul className="space-y-1.5 text-xs">
                  {economics.toolStats.map((t) => (
                    <li key={t.toolId} className="flex items-center justify-between rounded bg-surface-2 p-2">
                      <span className="font-mono font-semibold text-ink">{t.toolId}</span>
                      <span className="text-ink-2">
                        {t.successes}/{t.calls} ok ({(t.successRate * 100).toFixed(0)}%) · avg {t.avgDurationMs} ms
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card className="space-y-3 !p-5">
              <h3 className="text-sm font-semibold text-ink">Evaluation Model Comparison</h3>
              {modelComparison.length === 0 ? (
                <p className="text-xs text-ink-3">Run an evaluation dataset below to compare model pass rates, latency, and cost.</p>
              ) : (
                <ul className="space-y-1.5 text-xs">
                  {modelComparison.map((m) => (
                    <li key={m.model} className="flex items-center justify-between rounded bg-surface-2 p-2">
                      <span className="font-mono font-semibold text-ink">{m.model}</span>
                      <span className="text-ink-2">
                        {m.runs} run(s) · pass {(m.passRate * 100).toFixed(1)}% · {m.avgLatencyMs} ms · {fmtUsd(m.totalCostUsd)} ({m.costSource})
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          {/* Reproducible Evaluation Datasets, Test Runner & Honest ROI */}
          <div className="grid gap-6 lg:grid-cols-2">
            <Card className="space-y-3 !p-5">
              <h3 className="text-sm font-semibold text-ink">Create Reproducible Evaluation Dataset</h3>
              <Input
                placeholder="Dataset name (e.g. Security & Coding Regression Suite)"
                value={dsName}
                onChange={(e) => setDsName(e.target.value)}
              />
              <Input
                placeholder="Short description"
                value={dsDesc}
                onChange={(e) => setDsDesc(e.target.value)}
              />
              <textarea
                rows={4}
                value={dsCasesText}
                onChange={(e) => setDsCasesText(e.target.value)}
                placeholder={"One test case per line: Prompt => optional expected substring\nExample: Return the sum of 14 and 28 => 42"}
                className="input-base w-full font-mono text-xs"
              />
              <div className="flex justify-end">
                <Button onClick={() => void createDataset()} disabled={busy}>
                  Save Dataset
                </Button>
              </div>
            </Card>

            <Card className="space-y-3 !p-5">
              <h3 className="text-sm font-semibold text-ink">Run Evaluation & Outcome-Based ROI</h3>
              <p className="text-xs text-ink-2">
                ROI is computed <strong>only</strong> when you provide real measured baseline cost per task or outcome value per successful task. QORVYNA never invents ROI figures.
              </p>
              <div className="space-y-2 text-xs">
                <label className="block space-y-1">
                  <span className="text-ink-2">Dataset ({datasets.length} available)</span>
                  <select
                    aria-label="Select evaluation dataset"
                    value={selectedDatasetId}
                    onChange={(e) => setSelectedDatasetId(e.target.value)}
                    className="input-base text-xs"
                  >
                    <option value="">Select dataset…</option>
                    {datasets.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name} ({d.cases.length} cases)
                      </option>
                    ))}
                  </select>
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder="Manual baseline USD/task (optional)"
                    value={baselineCost}
                    onChange={(e) => setBaselineCost(e.target.value)}
                  />
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder="Value USD/success (optional)"
                    value={valuePerSuccess}
                    onChange={(e) => setValuePerSuccess(e.target.value)}
                  />
                </div>
                <div className="flex flex-wrap gap-2 pt-1">
                  <Button disabled={busy || !selectedDatasetId} onClick={() => void runLiveEvaluation()}>
                    <Play size={14} className="mr-1.5" /> Run Live Evaluation
                  </Button>
                  {runs.length > 0 ? (
                    <>
                      <select
                        aria-label="Select completed run for ROI"
                        value={selectedRunForRoi}
                        onChange={(e) => setSelectedRunForRoi(e.target.value)}
                        className="input-base !w-auto text-xs"
                      >
                        {runs.map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.id} ({r.summary.passed}/{r.summary.total} passed)
                          </option>
                        ))}
                      </select>
                      <Button variant="secondary" disabled={busy || !selectedRunForRoi} onClick={() => void calculateRunRoi()}>
                        Compute ROI
                      </Button>
                    </>
                  ) : null}
                </div>

                {computedRoi ? (
                  <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-2.5 text-emerald-700 dark:text-emerald-300">
                    <strong>Estimated Net ROI: {fmtUsd(computedRoi.roiUsd)}</strong>
                    <span className="block text-[11px]">Basis: {computedRoi.basis} (inference cost basis: estimate/provider)</span>
                  </div>
                ) : (
                  <p className="text-[11px] text-ink-3">
                    No ROI asserted — enter a measured baseline cost or outcome value above to compute ROI on a completed run.
                  </p>
                )}
              </div>

              {runs.length > 0 ? (
                <div className="border-t border-border pt-2 space-y-1.5">
                  <p className="text-xs font-semibold text-ink">Completed Evaluation Runs ({runs.length})</p>
                  <ul className="max-h-40 space-y-1 overflow-y-auto text-xs">
                    {runs.map((r) => (
                      <li key={r.id} className="flex items-center justify-between rounded bg-surface-2 px-2.5 py-1.5">
                        <span className="font-mono text-ink">{r.id}</span>
                        <span className="text-ink-2">
                          {r.summary.passed}/{r.summary.total} passed ({(r.summary.passRate * 100).toFixed(0)}%) · {r.summary.avgLatencyMs} ms · {fmtUsd(r.summary.totalCostUsd)} ({r.summary.costSource})
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </Card>
          </div>
        </div>
      ) : null}
    </div>
  );
}
