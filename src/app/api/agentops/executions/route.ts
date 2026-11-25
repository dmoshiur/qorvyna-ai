import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { mutationCsrfResponse } from "@/lib/server/request-security";
import {
  getServerAgentOps,
  HttpError,
  isPlatformAdmin,
  requireUser,
  safeAdminDb,
} from "@/lib/agentops/server";
import { aggregateMetrics } from "@/lib/agentops/telemetry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(err: unknown) {
  if (err instanceof HttpError) {
    return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
  }
  return NextResponse.json({ error: "INTERNAL_ERROR" }, { status: 500 });
}

export async function GET(req: NextRequest) {
  try {
    const user = await requireUser(req);
    const db = safeAdminDb();
    const admin = await isPlatformAdmin(db, user.uid);
    const url = new URL(req.url);
    const scopeAll = admin && url.searchParams.get("scope") === "all";
    const status = url.searchParams.get("status")?.trim() || undefined;
    const mode = url.searchParams.get("mode")?.trim() || undefined;
    const conversationId = url.searchParams.get("conversationId")?.trim() || undefined;
    const sinceRaw = Number(url.searchParams.get("since") ?? "");
    const untilRaw = Number(url.searchParams.get("until") ?? "");
    const limitRaw = Number(url.searchParams.get("limit") ?? "50");
    const limit = Number.isFinite(limitRaw) ? Math.min(200, Math.max(1, Math.floor(limitRaw))) : 50;

    const engine = getServerAgentOps();
    const executions = await engine.listExecutions({
      ...(scopeAll ? {} : { userId: user.uid }),
      ...(status ? { status } : {}),
      ...(mode ? { mode } : {}),
      ...(conversationId ? { conversationId } : {}),
      ...(Number.isFinite(sinceRaw) && sinceRaw > 0 ? { since: sinceRaw } : {}),
      ...(Number.isFinite(untilRaw) && untilRaw > 0 ? { until: untilRaw } : {}),
      limit,
    });

    return NextResponse.json({
      executions,
      metrics: aggregateMetrics(executions),
      circuitConfig: engine.getConfig(),
      observabilityConfig: engine.getObservabilityConfig(),
      isAdmin: admin,
      scope: scopeAll ? "all" : "mine",
    });
  } catch (err) {
    return errorResponse(err);
  }
}

const postSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("update_config"),
    circuit: z
      .object({
        maxReasoningCycles: z.number().optional(),
        maxRepeatedToolCalls: z.number().optional(),
        maxRecursionDepth: z.number().optional(),
        maxRetries: z.number().optional(),
        maxProviderFailures: z.number().optional(),
        tokenBudget: z.number().optional(),
        executionTimeoutMs: z.number().optional(),
        cooldownMs: z.number().optional(),
        toolSignatureWindow: z.number().optional(),
      })
      .optional(),
    observability: z
      .object({
        enabled: z.boolean().optional(),
        sampleRate: z.number().optional(),
        captureSpans: z.boolean().optional(),
        retentionDays: z.number().optional(),
      })
      .optional(),
  }),
  z.object({
    action: z.literal("prune_retention"),
    retentionDays: z.number().int().min(1).max(365).optional(),
  }),
]);

export async function POST(req: NextRequest) {
  const csrf = mutationCsrfResponse(req);
  if (csrf) return csrf;
  try {
    const user = await requireUser(req);
    const db = safeAdminDb();
    const admin = await isPlatformAdmin(db, user.uid);
    if (!admin) {
      return NextResponse.json(
        { error: "FORBIDDEN", message: "Platform admin access is required to modify global AgentOps configuration." },
        { status: 403 },
      );
    }
    let body: z.infer<typeof postSchema>;
    try {
      body = postSchema.parse(await req.json());
    } catch {
      return NextResponse.json({ error: "BAD_REQUEST" }, { status: 400 });
    }
    const engine = getServerAgentOps();
    if (body.action === "update_config") {
      const circuitConfig = body.circuit ? engine.updateConfig(body.circuit) : engine.getConfig();
      const observabilityConfig = body.observability
        ? engine.updateObservabilityConfig(body.observability)
        : engine.getObservabilityConfig();
      if (db) {
        await db
          .collection("audit_logs")
          .add({
            actor_id: user.uid,
            action: "agentops.config_updated",
            target_type: "agentops_config",
            target_id: "global",
            reason: "Operator updated circuit breaker / observability configuration",
            metadata: { circuitConfig, observabilityConfig },
            created_at: new Date(),
          })
          .catch(() => {});
      }
      return NextResponse.json({ ok: true, circuitConfig, observabilityConfig });
    }
    const pruned = await engine.pruneRetention(body.retentionDays);
    if (db) {
      await db
        .collection("audit_logs")
        .add({
          actor_id: user.uid,
          action: "agentops.retention_pruned",
          target_type: "agentops_executions",
          target_id: "expired",
          reason: `Pruned ${pruned} expired terminal execution records`,
          metadata: { pruned, retentionDays: body.retentionDays ?? engine.getObservabilityConfig().retentionDays },
          created_at: new Date(),
        })
        .catch(() => {});
    }
    return NextResponse.json({ ok: true, pruned });
  } catch (err) {
    return errorResponse(err);
  }
}
