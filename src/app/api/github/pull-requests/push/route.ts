import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/firebase/session";
import { pushAgentFilesViaPullRequest, validatePushFiles } from "@/lib/server/github";
import {
  auditGithub,
  githubErrorResponse,
  githubPushPrSchema,
  githubRateLimited,
  readGithubJson,
} from "@/lib/server/github-http";
import { mutationCsrfResponse } from "@/lib/server/request-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const csrf = mutationCsrfResponse(req);
  if (csrf) return csrf;
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  if (githubRateLimited(user.uid, "push_pr")) {
    return NextResponse.json({ error: "GITHUB_RATE_LIMITED" }, { status: 429 });
  }

  let repository = "";
  let headBranch = "";
  try {
    const parsed = githubPushPrSchema.safeParse(await readGithubJson(req));
    if (!parsed.success) throw new Error("BODY_INVALID");
    ({ repository, headBranch } = parsed.data);
    const files = validatePushFiles(parsed.data.files);
    const result = await pushAgentFilesViaPullRequest(user.uid, {
      repository: parsed.data.repository,
      baseBranch: parsed.data.baseBranch,
      headBranch: parsed.data.headBranch,
      title: parsed.data.title,
      body: parsed.data.body,
      message: parsed.data.message,
      files,
      reviewToken: parsed.data.reviewToken,
    });
    await auditGithub(user.uid, "push_pr", "ok", repository, `${result.baseBranch}<-${result.branch}`);
    return NextResponse.json(result, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    await auditGithub(user.uid, "push_pr", "not_confirmed", repository, headBranch);
    return githubErrorResponse(error);
  }
}
