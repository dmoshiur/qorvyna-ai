import "server-only";
import { z } from "zod";
import { adminDb, nowTs } from "@/lib/firebase/admin";

const MAX_BODY_BYTES = 1_200_000;
export const githubTargetSchema = z.object({
  repository: z.string().min(1).max(200),
  branch: z.string().min(1).max(180),
  files: z.unknown(),
});
export const githubPushSchema = githubTargetSchema.extend({
  source: z.literal("agent"),
  message: z.string().min(1).max(160),
  reviewToken: z.string().min(1).max(2048),
});
export const githubPushPrSchema = z.object({
  source: z.literal("agent"),
  repository: z.string().min(1).max(200),
  baseBranch: z.string().min(1).max(180),
  headBranch: z.string().min(1).max(180),
  title: z.string().min(1).max(160),
  body: z.string().max(10_000).optional(),
  message: z.string().min(1).max(160),
  files: z.unknown(),
  reviewToken: z.string().min(1).max(2048),
});
export const githubCreateRepoSchema = z.object({
  action: z.literal("create").optional(),
  name: z.string().min(1).max(100),
  description: z.string().max(350).optional(),
  private: z.boolean().optional(),
  autoInit: z.boolean().optional(),
  projectId: z.string().min(1).max(128).optional(),
});
export const githubSaveBindingSchema = z.object({
  action: z.literal("save_binding"),
  projectId: z.string().min(1).max(128),
  repository: z.string().min(1).max(200),
  branch: z.string().min(1).max(180),
});
export const githubSaveTokenSchema = z.object({
  token: z.string().min(20).max(256),
});

/** Bound bytes while reading, including when a client omits Content-Length. */
export async function readGithubJson(request: Request): Promise<unknown> {
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) throw new Error("BODY_TOO_LARGE");
  if (!request.body) throw new Error("BODY_INVALID");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) { await reader.cancel().catch(() => {}); throw new Error("BODY_TOO_LARGE"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8")); }
  catch { throw new Error("BODY_INVALID"); }
}

export function githubErrorResponse(error: unknown): Response {
  const code = error instanceof Error ? error.message.split(":")[0] : "GITHUB_ERROR";
  const status = code === "BODY_TOO_LARGE" ? 413 :
    code === "GITHUB_NOT_CONNECTED" || code === "GITHUB_HEAD_CHANGED" || code === "GITHUB_REVIEW_REQUIRED" || code === "GITHUB_409" || code === "GITHUB_422" || code === "GITHUB_PR_MERGE_UNAVAILABLE" || code === "GITHUB_BRANCH_EXISTS" ? 409 :
    code === "GITHUB_TOKEN_UNAUTHORIZED" || code === "GITHUB_401" ? 401 :
    code === "GITHUB_PUSH_FORBIDDEN" ? 403 :
    code === "PROJECT_NOT_FOUND" ? 404 :
    code === "GITHUB_NOT_CONFIGURED" ? 503 :
    ["BODY_INVALID", "FILES_INVALID", "FILES_TOO_LARGE", "FILES_SENSITIVE", "FILES_BINARY_UNSUPPORTED", "GITHUB_REMOTE_FILE_UNSUPPORTED", "GITHUB_REMOTE_FILES_TOO_LARGE", "TARGET_INVALID", "COMMIT_MESSAGE_REQUIRED", "PR_INPUT_INVALID", "PR_SAME_BRANCH", "PR_TITLE_REQUIRED", "REPO_NAME_INVALID", "GITHUB_TOKEN_INVALID", "GITHUB_PR_COMPARISON_INCOMPLETE"].includes(code) ? 400 : 502;
  // Do not return GitHub response bodies, credentials or file contents.
  const safe = /^[A-Z0-9_]+$/.test(code) && code.length <= 64 ? code : "GITHUB_ERROR";
  return Response.json({ error: safe }, { status });
}

// Per-process guard, not a substitute for a shared fleet-wide rate limiter.
const hits = new Map<string, number[]>();
export function githubRateLimited(
  uid: string,
  action: "preview" | "push" | "push_pr" | "repo_create" | "token_save" | "pr_preview" | "pr_create" | "pr_read" | "merge_preview" | "merge_execute",
  now = Date.now(),
): boolean {
  const key = `${action}:${uid}`;
  const recent = (hits.get(key) ?? []).filter((at) => now - at < 60_000);
  if (recent.length >= (action === "pr_read" ? 30 : action === "preview" || action === "pr_preview" || action === "merge_preview" ? 10 : 5)) return true;
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 5000) {
    for (const [entry, times] of hits) if (times.every((at) => now - at >= 60_000)) hits.delete(entry);
  }
  return false;
}

/** Best-effort audit: only metadata, never file contents or credentials. */
export async function auditGithub(uid: string, action: string, outcome: string, repository = "", branch = ""): Promise<void> {
  try {
    await adminDb().collection("audit_logs").add({ actor_id: uid, action: `github.${action}`, target_type: "github_repository", target_id: repository.slice(0, 200), reason: outcome, metadata: { branch: branch.slice(0, 180) }, created_at: nowTs() });
  } catch { console.warn("[QORVYNA] GitHub audit write failed."); }
}
