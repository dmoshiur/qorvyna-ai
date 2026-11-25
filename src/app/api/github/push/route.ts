import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/firebase/session";
import { pushAgentFiles, validatePushFiles } from "@/lib/server/github";
import { auditGithub, githubErrorResponse, githubRateLimited, githubPushSchema, readGithubJson } from "@/lib/server/github-http";
import { mutationCsrfResponse } from "@/lib/server/request-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const csrf = mutationCsrfResponse(req);
  if (csrf) return csrf;
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  if (githubRateLimited(user.uid, "push")) return NextResponse.json({ error: "GITHUB_RATE_LIMITED" }, { status: 429 });
  let repository = "";
  let branch = "";
  try {
    const parsed = githubPushSchema.safeParse(await readGithubJson(req));
    if (!parsed.success) throw new Error("BODY_INVALID");
    ({ repository, branch } = parsed.data);
    const files = validatePushFiles(parsed.data.files);
    const result = await pushAgentFiles(user.uid, { ...parsed.data, files });
    await auditGithub(user.uid, "push", "ok", repository, branch);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    // A transport failure after sending the mutation is an unknown outcome.
    await auditGithub(user.uid, "push", "not_confirmed", repository, branch);
    return githubErrorResponse(error);
  }
}
