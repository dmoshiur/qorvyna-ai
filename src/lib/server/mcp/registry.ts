// =============================================================================
// QORVYNA AI — MCP Connector Foundation & Priority Connectors (server-only).
//
// Extends the official-SDK GitHub MCP file reader (src/lib/server/mcp/github.ts)
// into a governed, opt-in MCP connector registry with:
//   • strict fixed HTTPS endpoints (no arbitrary URLs, no SSRF, no redirects)
//   • age + guardian consent enforcement for personal connectors
//   • untrusted external output tagging (never injected as system instructions)
//   • honest runtime status (never fakes "connected" when credentials are absent)
// =============================================================================

import "server-only";
import { z } from "zod";
import type { Db } from "@/lib/firebase/admin";
import type { SessionUser } from "@/lib/firebase/session";
import { getGithubConnection } from "@/lib/server/github";
import { assertGithubMcpConsent, githubMcpFileSchema, readGithubMcpFile } from "@/lib/server/mcp/github";
import { loadProjectFiles } from "@/lib/server/projects";
import { safeAgentPath } from "@/lib/ai/agent";

export type McpConnectorStatus = "ready" | "disabled" | "not_connected" | "not_configured";

export type McpConnectorDescriptor = {
  id: "workspace_projects" | "github_mcp" | "google_drive_mcp" | "gmail_mcp";
  label: string;
  provider: string;
  transport: "local_governed" | "streamable_http" | "https_readonly";
  endpoint: string;
  readOnly: true;
  guardianConsentRequired: boolean;
  approvalRequired: boolean;
  operations: string[];
  status: McpConnectorStatus;
  detail: string;
};

export async function listMcpConnectors(db: Db, user: SessionUser): Promise<McpConnectorDescriptor[]> {
  const ghEnabled = process.env.QORVYNA_GITHUB_MCP_ENABLED === "true";
  const ghConn = await getGithubConnection(user.uid).catch(() => null);

  const driveEnabled = process.env.QORVYNA_DRIVE_MCP_ENABLED === "true";
  const driveConfigured = Boolean(process.env.GOOGLE_DRIVE_CLIENT_ID && process.env.GOOGLE_DRIVE_CLIENT_SECRET);

  const gmailEnabled = process.env.QORVYNA_GMAIL_MCP_ENABLED === "true";
  const gmailConfigured = Boolean(process.env.GOOGLE_GMAIL_CLIENT_ID && process.env.GOOGLE_GMAIL_CLIENT_SECRET);

  return [
    {
      id: "workspace_projects",
      label: "QORVYNA Workspace Projects MCP",
      provider: "QORVYNA",
      transport: "local_governed",
      endpoint: "internal://qorvyna/projects",
      readOnly: true,
      guardianConsentRequired: false,
      approvalRequired: false,
      operations: ["list_project_files", "read_project_file"],
      status: "ready",
      detail: "Owner-scoped read-only inspection of Firestore project files.",
    },
    {
      id: "github_mcp",
      label: "GitHub Official Remote MCP",
      provider: "GitHub",
      transport: "streamable_http",
      endpoint: "https://api.githubcopilot.com/mcp/",
      readOnly: true,
      guardianConsentRequired: true,
      approvalRequired: true,
      operations: ["get_file_contents"],
      status: !ghEnabled ? "disabled" : ghConn ? "ready" : "not_connected",
      detail: !ghEnabled
        ? "Disabled by deployment policy (set QORVYNA_GITHUB_MCP_ENABLED=true to enable)."
        : ghConn
          ? `Connected as @${ghConn.login}; single-use approval & guardian policy enforced.`
          : "Connect your GitHub account in Settings or Project Workspace first.",
    },
    {
      id: "google_drive_mcp",
      label: "Google Drive Read-Only Connector",
      provider: "Google Drive",
      transport: "https_readonly",
      endpoint: "https://www.googleapis.com/drive/v3",
      readOnly: true,
      guardianConsentRequired: true,
      approvalRequired: true,
      operations: ["list_files_metadata"],
      status: !driveConfigured ? "not_configured" : driveEnabled ? "not_connected" : "disabled",
      detail: !driveConfigured
        ? "Not configured on this deployment (requires verified Google OAuth app credentials and consent review)."
        : "Opt-in personal connector; requires explicit user OAuth grant and guardian consent for minors.",
    },
    {
      id: "gmail_mcp",
      label: "Gmail Read-Only Snippet Connector",
      provider: "Google Workspace",
      transport: "https_readonly",
      endpoint: "https://gmail.googleapis.com/gmail/v1",
      readOnly: true,
      guardianConsentRequired: true,
      approvalRequired: true,
      operations: ["list_thread_snippets"],
      status: !gmailConfigured ? "not_configured" : gmailEnabled ? "not_connected" : "disabled",
      detail: !gmailConfigured
        ? "Not configured on this deployment (requires verified Gmail read-only OAuth scope and security review)."
        : "Opt-in personal connector; requires explicit user OAuth grant and guardian consent for minors.",
    },
  ];
}

const workspaceOpSchema = z.discriminatedUnion("operation", [
  z.object({
    connector: z.literal("workspace_projects"),
    operation: z.literal("list_project_files"),
    projectId: z.string().min(1).max(120),
  }),
  z.object({
    connector: z.literal("workspace_projects"),
    operation: z.literal("read_project_file"),
    projectId: z.string().min(1).max(120),
    path: z.string().min(1).max(180).refine((p) => safeAgentPath(p) === p),
  }),
  z.object({
    connector: z.literal("github_mcp"),
    operation: z.literal("get_file_contents"),
    args: githubMcpFileSchema,
  }),
]);

export async function invokeMcpConnector(
  db: Db,
  user: SessionUser,
  raw: unknown,
): Promise<{
  ok: boolean;
  connector: string;
  operation: string;
  trust: "owner_workspace" | "untrusted_external_content";
  data?: unknown;
  error?: string;
}> {
  const parsed = workspaceOpSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      connector: "unknown",
      operation: "unknown",
      trust: "untrusted_external_content",
      error: "MCP_INVALID_REQUEST",
    };
  }
  const req = parsed.data;

  if (req.connector === "workspace_projects") {
    const projSnap = await db.collection("projects").doc(req.projectId).get();
    const projOwner = projSnap.data()?.owner_id ?? projSnap.data()?.user_id;
    if (!projSnap.exists || projOwner !== user.uid || projSnap.data()?.archived_at) {
      return {
        ok: false,
        connector: req.connector,
        operation: req.operation,
        trust: "owner_workspace",
        error: "PROJECT_NOT_FOUND",
      };
    }
    const files = await loadProjectFiles(db, req.projectId);
    if (req.operation === "list_project_files") {
      return {
        ok: true,
        connector: req.connector,
        operation: req.operation,
        trust: "owner_workspace",
        data: {
          projectId: req.projectId,
          files: files.map((f) => ({ path: f.path, bytes: Buffer.byteLength(f.content ?? "", "utf8") })),
        },
      };
    }
    const target = files.find((f) => f.path === req.path);
    if (!target) {
      return {
        ok: false,
        connector: req.connector,
        operation: req.operation,
        trust: "owner_workspace",
        error: "FILE_NOT_FOUND",
      };
    }
    const content = (target.content ?? "").slice(0, 16_000);
    return {
      ok: true,
      connector: req.connector,
      operation: req.operation,
      trust: "owner_workspace",
      data: {
        path: target.path,
        text: content,
        truncated: (target.content ?? "").length > 16_000,
      },
    };
  }

  // github_mcp
  try {
    await assertGithubMcpConsent(db, user.uid);
    const res = await readGithubMcpFile(db, user.uid, req.args);
    return {
      ok: true,
      connector: req.connector,
      operation: req.operation,
      trust: res.trust,
      data: { text: res.text, truncated: res.truncated },
    };
  } catch (err) {
    return {
      ok: false,
      connector: req.connector,
      operation: req.operation,
      trust: "untrusted_external_content",
      error: err instanceof Error ? err.message.slice(0, 80) : "MCP_EXECUTION_FAILED",
    };
  }
}
