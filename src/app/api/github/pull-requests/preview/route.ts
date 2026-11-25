import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/firebase/session";
import { previewPullRequest } from "@/lib/server/github-pr";
import { prInputSchema } from "@/lib/server/github-pr-http";
import { auditGithub, githubErrorResponse, githubRateLimited, readGithubJson } from "@/lib/server/github-http";
import { mutationCsrfResponse } from "@/lib/server/request-security";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(req: NextRequest) {
  const csrf = mutationCsrfResponse(req); if (csrf) return csrf;
  const user = await getSessionUser(req); if (!user) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  if (githubRateLimited(user.uid, "pr_preview")) return NextResponse.json({ error: "GITHUB_RATE_LIMITED" }, { status: 429 });
  let repository = "", branch = "";
  try {
    const parsed = prInputSchema.safeParse(await readGithubJson(req)); if (!parsed.success) throw new Error("BODY_INVALID");
    repository = parsed.data.repository; branch = parsed.data.head;
    const result = await previewPullRequest(user.uid, parsed.data);
    await auditGithub(user.uid, "pr_preview", "ok", repository, branch);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { await auditGithub(user.uid, "pr_preview", "failed", repository, branch); return githubErrorResponse(error); }
}
