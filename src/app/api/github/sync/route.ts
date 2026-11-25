import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { adminDb } from "@/lib/firebase/admin";
import { getSessionUser } from "@/lib/firebase/session";
import { mutationCsrfResponse } from "@/lib/server/request-security";
import { loadProjectFiles } from "@/lib/server/projects";
import {
  classifyThreeWaySync,
  listGithubAppInstallations,
  listGithubBranches,
  revokeGithubGrantAndDisconnect,
} from "@/lib/server/github-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });

  const url = new URL(req.url);
  const repository = url.searchParams.get("repository")?.trim();
  if (repository) {
    try {
      const [branches, appInstallations] = await Promise.all([
        listGithubBranches(user.uid, repository),
        listGithubAppInstallations(user.uid),
      ]);
      return NextResponse.json({ repository, branches, appInstallations });
    } catch (err) {
      const code = err instanceof Error ? err.message.slice(0, 64) : "GITHUB_SYNC_ERROR";
      return NextResponse.json({ error: code }, { status: 400 });
    }
  }

  const appInstallations = await listGithubAppInstallations(user.uid);
  return NextResponse.json({ appInstallations });
}

const postSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("preview_three_way"),
    projectId: z.string().min(1).max(120),
    remoteFiles: z
      .array(z.object({ path: z.string().min(1).max(180), content: z.string().max(500_000) }))
      .max(200),
    baseFiles: z
      .array(z.object({ path: z.string().min(1).max(180), content: z.string().max(500_000) }))
      .max(200)
      .optional(),
  }),
  z.object({
    action: z.literal("revoke_and_disconnect"),
  }),
]);

export async function POST(req: NextRequest) {
  const csrf = mutationCsrfResponse(req);
  if (csrf) return csrf;
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });

  let body: z.infer<typeof postSchema>;
  try {
    body = postSchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "BAD_REQUEST" }, { status: 400 });
  }

  if (body.action === "revoke_and_disconnect") {
    const result = await revokeGithubGrantAndDisconnect(user.uid);
    return NextResponse.json(result);
  }

  const db = adminDb();
  const projSnap = await db.collection("projects").doc(body.projectId).get();
  const projOwner = projSnap.data()?.owner_id ?? projSnap.data()?.user_id;
  if (!projSnap.exists || projOwner !== user.uid || projSnap.data()?.archived_at) {
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  }
  const localFiles = await loadProjectFiles(db, body.projectId);
  const textLocal = localFiles
    .filter((f) => f.encoding !== "base64")
    .map((f) => ({ path: f.path, content: f.content ?? "" }));
  const sync = classifyThreeWaySync({
    local: textLocal,
    remote: body.remoteFiles,
    base: body.baseFiles ?? null,
  });
  return NextResponse.json({ projectId: body.projectId, ...sync });
}
