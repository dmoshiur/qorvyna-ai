import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/firebase/session";
import { inspectGithubPullRequest } from "@/lib/server/github-pr-read";
import { auditGithub, githubErrorResponse, githubRateLimited } from "@/lib/server/github-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req); if (!user) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  if (githubRateLimited(user.uid, "pr_read")) return NextResponse.json({ error: "GITHUB_RATE_LIMITED" }, { status: 429 });
  const repository = req.nextUrl.searchParams.get("repository") ?? "";
  const rawPage = req.nextUrl.searchParams.get("page") ?? "1";
  const rawNumber = req.nextUrl.searchParams.get("number") ?? "";
  try {
    if (!/^[1-9]\d*$/.test(rawPage) || !/^[1-9]\d*$/.test(rawNumber)) throw new Error("PR_INPUT_INVALID");
    const result = await inspectGithubPullRequest(user.uid, repository, Number(rawNumber), Number(rawPage));
    await auditGithub(user.uid, "pr_inspect", "ok", repository);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { await auditGithub(user.uid, "pr_inspect", "failed", repository); return githubErrorResponse(error); }
}
