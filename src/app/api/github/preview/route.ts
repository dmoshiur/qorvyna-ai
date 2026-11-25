import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/firebase/session";
import { previewGithubPush, validatePushFiles } from "@/lib/server/github";
import { auditGithub, githubErrorResponse, githubRateLimited, githubTargetSchema, readGithubJson } from "@/lib/server/github-http";
import { mutationCsrfResponse } from "@/lib/server/request-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const csrf = mutationCsrfResponse(req);
  if (csrf) return csrf;
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  if (githubRateLimited(user.uid, "preview")) return NextResponse.json({ error: "GITHUB_RATE_LIMITED" }, { status: 429 });
  let repository = "";
  let branch = "";
  try {
    const parsed = githubTargetSchema.safeParse(await readGithubJson(req));
    if (!parsed.success) throw new Error("BODY_INVALID");
    ({ repository, branch } = parsed.data);
    const files = validatePushFiles(parsed.data.files);
    const result = await previewGithubPush(user.uid, { repository, branch, files });
    await auditGithub(user.uid, "preview", "ok", repository, branch);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    await auditGithub(user.uid, "preview", "failed", repository, branch);
    return githubErrorResponse(error);
  }
}
