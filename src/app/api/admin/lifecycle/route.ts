import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { adminConfigured, adminDb } from "@/lib/firebase/admin";
import { getSessionUser } from "@/lib/firebase/session";
import { hasPermission } from "@/lib/server/rpc";
import { mutationCsrfResponse } from "@/lib/server/request-security";
import { cleanupExecutionSessions } from "@/lib/server/execution-env";
import {
  inspectFirebaseLifecycle,
  recordVerifiedBackupDrill,
} from "@/lib/server/firebase-lifecycle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  if (!adminConfigured()) return NextResponse.json({ error: "DATABASE_NOT_CONFIGURED" }, { status: 503 });

  const db = adminDb();
  const allowed =
    (await hasPermission(db, user.uid, "system.settings")) ||
    (await hasPermission(db, user.uid, "audit.view"));
  if (!allowed) return NextResponse.json({ error: "PERMISSION_DENIED" }, { status: 403 });

  const lifecycle = await inspectFirebaseLifecycle(db);
  return NextResponse.json({ lifecycle });
}

const postSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("cleanup_ephemeral") }),
  z.object({
    action: z.literal("verify_backup_manifest"),
    manifest: z.unknown(),
  }),
]);

export async function POST(req: NextRequest) {
  const csrf = mutationCsrfResponse(req);
  if (csrf) return csrf;
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  if (!adminConfigured()) return NextResponse.json({ error: "DATABASE_NOT_CONFIGURED" }, { status: 503 });

  const db = adminDb();
  if (!(await hasPermission(db, user.uid, "system.settings"))) {
    return NextResponse.json({ error: "PERMISSION_DENIED" }, { status: 403 });
  }

  let body: z.infer<typeof postSchema>;
  try {
    body = postSchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "BAD_REQUEST" }, { status: 400 });
  }

  if (body.action === "cleanup_ephemeral") {
    const report = await cleanupExecutionSessions(db);
    return NextResponse.json({ ok: true, report });
  }

  const verification = await recordVerifiedBackupDrill(db, user.uid, body.manifest);
  return NextResponse.json(verification, { status: verification.valid ? 200 : 400 });
}
