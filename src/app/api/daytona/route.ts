import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { adminConfigured, adminDb, nowTs } from "@/lib/firebase/admin";
import { getApiSessionUser } from "@/lib/firebase/device-session";
import { mutationCsrfResponse } from "@/lib/server/request-security";
import { hasPermission } from "@/lib/server/rpc";
import { getProject } from "@/lib/server/projects";
import {
  countLegacyDaytonaUserKeys,
  deleteDaytonaSystemConnection,
  getDaytonaStatus,
  migrateLegacyDaytonaUserKey,
  runDaytonaCode,
  runDaytonaCommand,
  saveDaytonaSystemConnection,
} from "@/lib/server/daytona";
import { getServerAgentOps } from "@/lib/agentops/server";
import { QORVYNA_MODEL_ID } from "@/lib/ai/model";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Daytona is a SYSTEM-wide integration: exactly one sandbox configuration,
// managed from the admin panel (Admin → AI configuration → Sandbox). Regular
// users execute code/commands through it but never see or set the key.
const ADMIN_PERMISSION = "system.settings";

const hits = new Map<string, number[]>();
function daytonaRateLimited(uid: string, limit = 12, now = Date.now()): boolean {
  const recent = (hits.get(uid) ?? []).filter((at) => now - at < 60_000);
  if (recent.length >= limit) return true;
  recent.push(now);
  hits.set(uid, recent);
  return false;
}

async function auditDaytona(uid: string, action: string, outcome: string, detail = "") {
  if (!adminConfigured()) return;
  try {
    await adminDb().collection("audit_logs").add({
      actor_id: uid,
      action: `daytona.${action}`,
      target_type: "daytona_sandbox",
      target_id: "@daytona/sdk",
      reason: outcome,
      metadata: { detail: detail.slice(0, 200) },
      created_at: nowTs(),
    });
  } catch {
    // best-effort audit
  }
}

export async function GET(req: NextRequest) {
  const user = await getApiSessionUser(req);
  if (!user) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  const status = await getDaytonaStatus();
  // Admin-only extras: how many legacy per-user keys still exist for migration.
  let admin: { legacyUserKeys: number } | undefined;
  if (adminConfigured()) {
    try {
      if (await hasPermission(adminDb(), user.uid, ADMIN_PERMISSION)) {
        admin = { legacyUserKeys: await countLegacyDaytonaUserKeys() };
      }
    } catch {
      // Permission lookup failure simply omits admin extras.
    }
  }
  return NextResponse.json(
    { ...status, ...(admin ? { admin } : {}) },
    { headers: { "Cache-Control": "no-store" } },
  );
}

const postSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("configure"),
    apiKey: z.string().min(16).max(256),
    target: z.string().max(48).optional(),
  }),
  z.object({
    action: z.literal("disconnect"),
  }),
  z.object({
    action: z.literal("migrate_legacy"),
  }),
  z.object({
    action: z.literal("code_run"),
    code: z.string().min(1).max(100_000),
    language: z.enum(["typescript", "javascript", "python"]).optional(),
    projectId: z.string().min(1).max(120).optional(),
    timeoutSeconds: z.number().int().min(1).max(60).optional(),
  }),
  z.object({
    action: z.literal("exec"),
    command: z.string().min(1).max(4_000),
    cwd: z.string().max(180).optional(),
    projectId: z.string().min(1).max(120).optional(),
    timeoutSeconds: z.number().int().min(1).max(60).optional(),
  }),
]);

async function requireAdmin(uid: string): Promise<boolean> {
  if (!adminConfigured()) return false;
  return hasPermission(adminDb(), uid, ADMIN_PERMISSION);
}

export async function POST(req: NextRequest) {
  const csrf = mutationCsrfResponse(req);
  if (csrf) return csrf;
  const user = await getApiSessionUser(req);
  if (!user) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  if (daytonaRateLimited(user.uid)) {
    return NextResponse.json({ error: "DAYTONA_RATE_LIMITED" }, { status: 429 });
  }

  let body: z.infer<typeof postSchema>;
  try {
    body = postSchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "BAD_REQUEST" }, { status: 400 });
  }

  try {
    // Admin-only lifecycle of the ONE shared Daytona configuration.
    if (body.action === "configure" || body.action === "disconnect" || body.action === "migrate_legacy") {
      if (!adminConfigured()) {
        return NextResponse.json({ error: "DATABASE_NOT_CONFIGURED" }, { status: 503 });
      }
      if (!(await requireAdmin(user.uid))) {
        await auditDaytona(user.uid, body.action, "denied");
        return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
      }

      if (body.action === "configure") {
        const status = await saveDaytonaSystemConnection(user.uid, {
          apiKey: body.apiKey,
          target: body.target,
        });
        await auditDaytona(user.uid, "configure", "ok", "system");
        return NextResponse.json(status, { headers: { "Cache-Control": "no-store" } });
      }

      if (body.action === "disconnect") {
        const status = await deleteDaytonaSystemConnection();
        await auditDaytona(user.uid, "disconnect", "ok", "system");
        return NextResponse.json(status, { headers: { "Cache-Control": "no-store" } });
      }

      const { status, migrated } = await migrateLegacyDaytonaUserKey(user.uid);
      await auditDaytona(user.uid, "migrate_legacy", "ok", migrated ? "promoted_user_key" : "purged_only");
      return NextResponse.json(
        { ...status, migrated },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    // Load optional owned project files so Daytona code/commands can run against workspace files
    let projectFiles: Array<{ path: string; content: string }> | undefined;
    if (body.projectId && adminConfigured()) {
      const loaded = await getProject(adminDb(), user, body.projectId);
      projectFiles = loaded.files
        .filter((f) => f.encoding !== "base64")
        .map((f) => ({ path: f.path, content: f.content }));
    }

    const agentops = getServerAgentOps();
    const startedAt = Date.now();
    const executionId = await agentops.start({
      userId: user.uid,
      mode: "daytona_sandbox",
      modelPool: [QORVYNA_MODEL_ID],
    });
    const rootAgentId = agentops.rootAgentId(executionId);
    const toolId = body.action === "code_run" ? "daytona.code_run" : "daytona.exec";
    const argsHash = crypto
      .createHash("sha256")
      .update(body.action === "code_run" ? `${body.language ?? "typescript"}:${body.code}` : body.command)
      .digest("hex")
      .slice(0, 16);

    agentops.evaluate({
      type: "tool.call",
      executionId,
      agentId: rootAgentId,
      toolId,
      argsHash,
      risk: "write",
      approvalRequired: false,
      startedAt,
    });

    try {
      const result =
        body.action === "code_run"
          ? await runDaytonaCode({
              code: body.code,
              language: body.language,
              projectFiles,
              timeoutSeconds: body.timeoutSeconds,
            })
          : await runDaytonaCommand({
              command: body.command,
              cwd: body.cwd,
              projectFiles,
              timeoutSeconds: body.timeoutSeconds,
            });

      const finishedAt = Date.now();
      agentops.evaluate({
        type: "tool.result",
        executionId,
        agentId: rootAgentId,
        toolId,
        ok: result.exitCode === 0,
        durationMs: result.durationMs,
        error: result.exitCode !== 0 ? result.result.slice(0, 240) : undefined,
        finishedAt,
      });
      agentops.evaluate({
        type: "execution.end",
        executionId,
        status: result.exitCode === 0 ? "completed" : "failed",
        outcome: result.exitCode === 0 ? "success" : "tool_failure",
        totalDurationMs: Math.max(1, finishedAt - startedAt),
        endedAt: finishedAt,
      });
      await agentops.persist(executionId).catch(() => {});
      await auditDaytona(user.uid, body.action, result.exitCode === 0 ? "ok" : `exit_${result.exitCode}`, result.sandboxId);

      return NextResponse.json(
        {
          result,
          executionId,
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    } catch (innerErr) {
      const finishedAt = Date.now();
      agentops.evaluate({
        type: "execution.end",
        executionId,
        status: "failed",
        outcome: "tool_failure",
        totalDurationMs: Math.max(1, finishedAt - startedAt),
        endedAt: finishedAt,
      });
      await agentops.persist(executionId).catch(() => {});
      throw innerErr;
    }
  } catch (error) {
    const code = error instanceof Error ? error.message.split(":")[0] : "DAYTONA_ERROR";
    await auditDaytona(user.uid, body.action, "failed", code);
    const status =
      code === "DAYTONA_NOT_CONFIGURED" || code === "DAYTONA_SECRET_KEY_MISSING"
        ? 503
        : code === "DAYTONA_KEY_INVALID" || code === "DAYTONA_TARGET_INVALID" || code === "DAYTONA_CODE_INVALID" || code === "DAYTONA_COMMAND_INVALID"
          ? 400
          : 502;
    const safe = /^[A-Z0-9_]+$/.test(code) && code.length <= 64 ? code : "DAYTONA_EXECUTION_FAILED";
    return NextResponse.json({ error: safe }, { status });
  }
}
