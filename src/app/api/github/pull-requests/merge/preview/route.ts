import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/firebase/session";
import { previewGithubMerge } from "@/lib/server/github-pr-merge";
import { mergeInputSchema } from "@/lib/server/github-merge-http";
import { auditGithub, githubErrorResponse, githubRateLimited, readGithubJson } from "@/lib/server/github-http";
import { mutationCsrfResponse } from "@/lib/server/request-security";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(req: NextRequest) {
  const csrf = mutationCsrfResponse(req); if (csrf) return csrf;
  const user = await getSessionUser(req); if (!user) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  if (githubRateLimited(user.uid, "merge_preview")) return NextResponse.json({ error: "GITHUB_RATE_LIMITED" }, { status: 429 });
  let repository = "";
  try {
    const parsed = mergeInputSchema.safeParse(await readGithubJson(req)); if (!parsed.success) throw new Error("BODY_INVALID");
    repository = parsed.data.repository;
    const result = await previewGithubMerge(user.uid, parsed.data);
    await auditGithub(user.uid, "merge_preview", `pr_${parsed.data.number}_ok`, repository);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { await auditGithub(user.uid, "merge_preview", "failed", repository); return githubErrorResponse(error); }
}
