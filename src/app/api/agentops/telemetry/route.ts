import { NextRequest, NextResponse } from "next/server";
import {
  getServerAgentOps,
  HttpError,
  isPlatformAdmin,
  requireOperatorForExecution,
  requireUser,
  safeAdminDb,
} from "@/lib/agentops/server";
import {
  aggregateMetrics,
  recordToLogs,
  recordToSpans,
  toOtlpJson,
} from "@/lib/agentops/telemetry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const executionId = url.searchParams.get("executionId")?.trim();
    if (executionId) {
      const { record } = await requireOperatorForExecution(req, executionId);
      const spans = recordToSpans(record);
      const logs = recordToLogs(record);
      return NextResponse.json({
        otlp: toOtlpJson(spans),
        spans,
        logs,
        metrics: aggregateMetrics([record]),
      });
    }

    const user = await requireUser(req);
    const db = safeAdminDb();
    const admin = await isPlatformAdmin(db, user.uid);
    const scopeAll = admin && url.searchParams.get("scope") === "all";
    const limitRaw = Number(url.searchParams.get("limit") ?? "25");
    const limit = Number.isFinite(limitRaw) ? Math.min(100, Math.max(1, Math.floor(limitRaw))) : 25;

    const engine = getServerAgentOps();
    const records = await engine.listExecutions({
      ...(scopeAll ? {} : { userId: user.uid }),
      limit,
    });
    const spans = records.flatMap((r) => recordToSpans(r));
    const logs = records.flatMap((r) => recordToLogs(r)).sort((a, b) => b.timestamp - a.timestamp).slice(0, 300);

    return NextResponse.json({
      otlp: toOtlpJson(spans),
      spans,
      logs,
      metrics: aggregateMetrics(records),
      observabilityConfig: engine.getObservabilityConfig(),
    });
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
