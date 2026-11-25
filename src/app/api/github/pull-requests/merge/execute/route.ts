import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/firebase/session";
import { mergeGithubPullRequest } from "@/lib/server/github-pr-merge";
import { mergeExecuteSchema } from "@/lib/server/github-merge-http";
import { auditGithub, githubErrorResponse, githubRateLimited, readGithubJson } from "@/lib/server/github-http";
import { mutationCsrfResponse } from "@/lib/server/request-security";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(req: NextRequest) {
  const csrf = mutationCsrfResponse(req); if (csrf) return csrf;
  const user = await getSessionUser(req); if (!user) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  if (githubRateLimited(user.uid, "merge_execute")) return NextResponse.json({ error: "GITHUB_RATE_LIMITED" }, { status: 429 });
  let repository = "", number = 0;
  try {
    const parsed = mergeExecuteSchema.safeParse(await readGithubJson(req)); if (!parsed.success) throw new Error("BODY_INVALID");
    const { reviewToken, ...input } = parsed.data; repository = input.repository; number = input.number;
    const result = await mergeGithubPullRequest(user.uid, input, reviewToken);
    await auditGithub(user.uid, "merge", `pr_${number}_ok`, repository);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { await auditGithub(user.uid, "merge", number ? `pr_${number}_not_confirmed` : "not_confirmed", repository); return githubErrorResponse(error); }
}
