import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { adminConfigured, adminDb } from "@/lib/firebase/admin";
import { getApiSessionUser } from "@/lib/firebase/device-session";
import { mutationCsrfResponse } from "@/lib/server/request-security";
import { RpcError } from "@/lib/server/errors";
import {
  applyProjectFiles,
  deleteProjectFile,
  ensureProject,
  getProject,
  listProjects,
  renameProjectFile,
  upsertProjectFile,
} from "@/lib/server/projects";
import { closeExecutionSession, openExecutionSession } from "@/lib/server/execution-env";
import { formatProjectFilesForContext, parseAgentResponse } from "@/lib/ai/agent";
import { resolvePool } from "@/lib/ai/models/pool";
import { completeWithModel } from "@/lib/ai/executor";
import { QORVYNA_MODEL_ID } from "@/lib/ai/model";
import { withLanguage } from "@/lib/projects/paths";
import {
  computeUnifiedFileDiff,
  executeWorkspaceCommand,
  type TerminalProjectAdapter,
} from "@/lib/terminal/engine";
import { offendingSegmentFromError, projectInitError } from "@/lib/terminal/project-init";
import { getServerAgentOps } from "@/lib/agentops/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await getApiSessionUser(req);
  if (!user) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  if (!adminConfigured()) return NextResponse.json({ error: "DATABASE_NOT_CONFIGURED" }, { status: 503 });

  const db = adminDb();
  const projects = await listProjects(db, user);
  const requestedId = new URL(req.url).searchParams.get("projectId")?.trim();
  const activeId = requestedId || projects[0]?.id || null;

  if (!activeId) {
    return NextResponse.json({ projects, activeProject: null, files: [] });
  }

  try {
    const loaded = await getProject(db, user, activeId);
    return NextResponse.json({
      projects,
      activeProject: loaded.project,
      files: loaded.files,
    });
  } catch (err) {
    const status = err instanceof RpcError ? err.status : 404;
    return NextResponse.json({ error: err instanceof Error ? err.message : "NOT_FOUND" }, { status });
  }
}

const postSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("init_project"),
    title: z.string().min(1).max(80).default("Workspace Project"),
  }),
  z.object({
    action: z.literal("exec"),
    projectId: z.string().min(1).max(120),
    command: z.string().min(1).max(2_000),
    confirmDestructive: z.boolean().optional(),
  }),
  z.object({
    action: z.literal("save_file"),
    projectId: z.string().min(1).max(120),
    path: z.string().min(1).max(180),
    content: z.string().max(500_000),
    expectedRevision: z.number().int().min(0).optional(),
  }),
  z.object({
    action: z.literal("ai_propose"),
    projectId: z.string().min(1).max(120),
    instruction: z.string().min(3).max(8_000),
  }),
  z.object({
    action: z.literal("ai_apply"),
    projectId: z.string().min(1).max(120),
    expectedRevision: z.number().int().min(0),
    files: z
      .array(
        z.object({
          path: z.string().min(1).max(180),
          content: z.string().max(500_000),
        }),
      )
      .min(1)
      .max(30),
  }),
]);

export async function POST(req: NextRequest) {
  const csrf = mutationCsrfResponse(req);
  if (csrf) return csrf;
  const user = await getApiSessionUser(req);
  if (!user) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  if (!adminConfigured()) return NextResponse.json({ error: "DATABASE_NOT_CONFIGURED" }, { status: 503 });

  let body: z.infer<typeof postSchema>;
  try {
    body = postSchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "BAD_REQUEST" }, { status: 400 });
  }

  const db = adminDb();
  const agentops = getServerAgentOps();

  try {
    if (body.action === "init_project") {
      const initStartedAt = Date.now();
      const executionId = await agentops.start({
        userId: user.uid,
        mode: "terminal_init",
        modelPool: [QORVYNA_MODEL_ID],
      });
      const rootAgentId = agentops.rootAgentId(executionId);
      const initArgsHash = crypto
        .createHash("sha256")
        .update(`init:${body.title}`)
        .digest("hex")
        .slice(0, 16);

      try {
        const created = await ensureProject(db, user, { title: body.title, forceNew: true });
        await applyProjectFiles(db, user, {
          project_id: created.id,
          source: "user",
          files: [
            withLanguage({
              path: "index.html",
              content: `<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="utf-8" />\n  <meta name="viewport" content="width=device-width, initial-scale=1" />\n  <title>${body.title}</title>\n  <link rel="stylesheet" href="styles.css" />\n</head>\n<body>\n  <main class="shell">\n    <h1>${body.title}</h1>\n    <p>Managed inside QORVYNA AI Coding Workspace.</p>\n  </main>\n  <script src="app.js"></script>\n</body>\n</html>\n`,
              encoding: "utf8",
            }),
            withLanguage({
              path: "styles.css",
              content: `:root { color-scheme: dark; }\nbody { font-family: system-ui, sans-serif; margin: 0; padding: 2.5rem; background: #0b1020; color: #f1f5f9; }\n.shell { max-width: 44rem; margin: 0 auto; }\n`,
              encoding: "utf8",
            }),
            withLanguage({
              path: "app.js",
              content: `console.log("QORVYNA workspace ready");\n`,
              encoding: "utf8",
            }),
          ],
        });
        const loaded = await getProject(db, user, created.id);
      const initFinishedAt = Date.now();
      const initDurationMs = Math.max(1, initFinishedAt - initStartedAt);
        agentops.evaluate({
          type: "tool.call",
          executionId,
          agentId: rootAgentId,
          toolId: "qsh.init_project",
          argsHash: initArgsHash,
          risk: "write",
          approvalRequired: false,
          startedAt: initStartedAt,
        });
        agentops.evaluate({
          type: "tool.result",
          executionId,
          agentId: rootAgentId,
          toolId: "qsh.init_project",
          ok: true,
          durationMs: initDurationMs,
          finishedAt: initFinishedAt,
        });
        agentops.evaluate({
          type: "execution.end",
          executionId,
          status: "completed",
          outcome: "success",
          totalDurationMs: initDurationMs,
          endedAt: initFinishedAt,
        });
        await agentops.persist(executionId);
        return NextResponse.json({ activeProject: loaded.project, files: loaded.files });
      } catch (err) {
        const initFinishedAt = Date.now();
        const initDurationMs = Math.max(1, initFinishedAt - initStartedAt);
        const message = err instanceof Error ? err.message : "PROJECT_INIT_ERROR";
        agentops.evaluate({
          type: "tool.call",
          executionId,
          agentId: rootAgentId,
          toolId: "qsh.init_project",
          argsHash: initArgsHash,
          risk: "write",
          approvalRequired: false,
          startedAt: initStartedAt,
        });
        agentops.evaluate({
          type: "tool.result",
          executionId,
          agentId: rootAgentId,
          toolId: "qsh.init_project",
          ok: false,
          error: projectInitError(offendingSegmentFromError(message)),
          durationMs: initDurationMs,
          finishedAt: initFinishedAt,
        });
        agentops.evaluate({
          type: "execution.end",
          executionId,
          status: "failed",
          outcome: "tool_failure",
          totalDurationMs: initDurationMs,
          endedAt: initFinishedAt,
        });
        await agentops.persist(executionId);
        throw err;
      }
    }

    if (body.action === "save_file") {
      const saved = await upsertProjectFile(db, user, {
        project_id: body.projectId,
        path: body.path,
        content: body.content,
        source: "user",
        expected_revision: body.expectedRevision,
      });
      return NextResponse.json({ ok: true, ...saved });
    }

    if (body.action === "exec") {
      const loaded = await getProject(db, user, body.projectId);
      const runId = `qsh_${Date.now().toString(36)}`;
      const session = await openExecutionSession(db, {
        runId,
        segment: 0,
        ownerId: user.uid,
        projectId: body.projectId,
        conversationId: loaded.project.conversation_id,
      });

      const startedAt = Date.now();
      const executionId = await agentops.start({
        userId: user.uid,
        conversationId: loaded.project.conversation_id ?? undefined,
        mode: "terminal",
        modelPool: [QORVYNA_MODEL_ID],
      });
      const rootAgentId = agentops.rootAgentId(executionId);

      try {
        const adapter: TerminalProjectAdapter = {
          getState: async () => {
            const current = await getProject(db, user, body.projectId);
            return {
              projectId: body.projectId,
              title: current.project.title,
              revision: current.project.revision,
              uid: user.uid,
              files: current.files,
            };
          },
          upsertFile: async (path, content, expectedRevision) =>
            upsertProjectFile(db, user, {
              project_id: body.projectId,
              path,
              content,
              source: "user",
              expected_revision: expectedRevision,
            }),
          renameFile: async (from, to, expectedRevision) => {
            await renameProjectFile(db, user, {
              project_id: body.projectId,
              from,
              to,
              expected_revision: expectedRevision,
            });
          },
          deleteFile: async (path, expectedRevision) => {
            await deleteProjectFile(db, user, {
              project_id: body.projectId,
              path,
              expected_revision: expectedRevision,
            });
          },
        };

        const argsHash = crypto
          .createHash("sha256")
          .update(`${body.projectId}:${body.command}`)
          .digest("hex")
          .slice(0, 16);

        const result = await executeWorkspaceCommand(body.command, adapter, {
          confirmDestructive: body.confirmDestructive,
        });
        const toolId = `qsh.${result.program || "noop"}`;
        const now = Date.now();

        agentops.evaluate({
          type: "tool.call",
          executionId,
          agentId: rootAgentId,
          toolId,
          argsHash,
          risk: result.program === "rm" ? "dangerous" : result.mutatedProject ? "write" : "safe",
          approvalRequired: result.program === "rm",
          startedAt,
        });
        agentops.evaluate({
          type: "tool.result",
          executionId,
          agentId: rootAgentId,
          toolId,
          ok: result.exitCode === 0,
          durationMs: result.durationMs,
          error: result.exitCode !== 0 ? result.stderr.slice(0, 240) : undefined,
          finishedAt: now,
        });
        agentops.evaluate({
          type: "execution.end",
          executionId,
          status: result.exitCode === 0 ? "completed" : "failed",
          outcome: result.exitCode === 0 ? "success" : "tool_failure",
          totalDurationMs: Math.max(1, now - startedAt),
          endedAt: now,
        });
        await agentops.persist(executionId);

        const refreshed = result.mutatedProject ? await getProject(db, user, body.projectId) : loaded;
        await closeExecutionSession(db, session, {
          working: refreshed.files,
          stored: refreshed.files,
          outcome: result.exitCode === 0 ? "ok" : `exit_${result.exitCode}`,
        });

        return NextResponse.json({
          result,
          executionId,
          activeProject: refreshed.project,
          files: result.mutatedProject ? refreshed.files : undefined,
        });
      } catch (err) {
        await closeExecutionSession(db, session, {
          working: null,
          stored: null,
          outcome: "error",
        }).catch(() => {});
        const now = Date.now();
        agentops.evaluate({
          type: "execution.end",
          executionId,
          status: "failed",
          outcome: "tool_failure",
          totalDurationMs: Math.max(1, now - startedAt),
          endedAt: now,
        });
        await agentops.persist(executionId);
        throw err;
      }
    }

    if (body.action === "ai_propose") {
      const loaded = await getProject(db, user, body.projectId);
      const pool = await resolvePool(db, user.uid, null, { intent: "artifact" });
      if (!pool.targets.length) {
        return NextResponse.json(
          { error: "AI_NOT_CONFIGURED", message: "No configured AI model route is currently available." },
          { status: 503 },
        );
      }

      const startedAt = Date.now();
      const executionId = await agentops.start({
        userId: user.uid,
        conversationId: loaded.project.conversation_id ?? undefined,
        mode: "workspace_patch",
        modelPool: pool.targets.map((t) => t.model),
      });

      try {
        const context = formatProjectFilesForContext(loaded.files, body.instruction);
        const systemPrompt = [
          "You are QORVYNA AI Coding Workspace Assistant (by OKGS).",
          "Modify only the project files required to satisfy the user's instruction.",
          "Return every changed or added file in full using the exact QORVYNA_FILE protocol:",
          '<<<QORVYNA_FILE path="relative/path.ext">>>',
          "...complete file content...",
          "<<<END_QORVYNA_FILE>>>",
          "Include a concise explanation before the file blocks. Never emit placeholders or elided sections.",
        ].join("\n");

        const completed = await completeWithModel([pool.targets[0]], {
          messages: [
            { role: "system", content: systemPrompt },
            ...(context.text ? [{ role: "user" as const, content: context.text }] : []),
            { role: "user", content: body.instruction },
          ],
          temperature: 0.2,
          maxTokens: 6_000,
        });
        const finishedAt = Date.now();
        const latencyMs = Math.max(1, finishedAt - startedAt);

        agentops.evaluate({
          type: "token.usage",
          executionId,
          model: completed.target.model,
          provider: completed.target.provider,
          requestType: "workspace_patch",
          usage: completed.response.usage,
          latencyMs,
          status: "ok",
          at: finishedAt,
        });

        const parsed = parseAgentResponse(completed.response.content ?? "", {
          allowUnlabelledFences: false,
          allowRawHtmlDocument: false,
        });

        const currentByPath = new Map(
          loaded.files.filter((f) => f.encoding !== "base64").map((f) => [f.path, f.content]),
        );
        const diffs = parsed.files.map((f) =>
          computeUnifiedFileDiff(f.path, currentByPath.get(f.path), f.content),
        );

        agentops.evaluate({
          type: "execution.end",
          executionId,
          status: "completed",
          outcome: "success",
          totalDurationMs: latencyMs,
          endedAt: finishedAt,
        });
        await agentops.persist(executionId);

        return NextResponse.json({
          executionId,
          expectedRevision: loaded.project.revision,
          reply: parsed.reply,
          proposedFiles: parsed.files,
          diffs,
          usage: completed.response.usage,
          provider: completed.target.provider,
          model: completed.target.model,
          latencyMs,
        });
      } catch (err) {
        const finishedAt = Date.now();
        agentops.evaluate({
          type: "execution.end",
          executionId,
          status: "failed",
          outcome: "model_failure",
          totalDurationMs: Math.max(1, finishedAt - startedAt),
          endedAt: finishedAt,
        });
        await agentops.persist(executionId);
        throw err;
      }
    }

    // ai_apply
    const applied = await applyProjectFiles(db, user, {
      project_id: body.projectId,
      expected_revision: body.expectedRevision,
      source: "agent",
      files: body.files.map((f) =>
        withLanguage({ path: f.path, content: f.content, encoding: "utf8" }),
      ),
    });
    const refreshed = await getProject(db, user, body.projectId);
    return NextResponse.json({
      ok: true,
      applied,
      activeProject: refreshed.project,
      files: refreshed.files,
    });
  } catch (err) {
    const status = err instanceof RpcError ? err.status : 400;
    const code = err instanceof Error ? err.message.slice(0, 80) : "TERMINAL_API_ERROR";
    return NextResponse.json({ error: code }, { status });
  }
}
