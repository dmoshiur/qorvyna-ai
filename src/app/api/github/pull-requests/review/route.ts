import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { adminConfigured, adminDb, nowTs } from "@/lib/firebase/admin";
import { getSessionUser } from "@/lib/firebase/session";
import { mutationCsrfResponse } from "@/lib/server/request-security";
import {
  listPullRequestReviews,
  submitPullRequestReview,
} from "@/lib/server/github-pr-review";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });

  const url = new URL(req.url);
  const repository = url.searchParams.get("repository")?.trim() ?? "";
  const number = Number(url.searchParams.get("number") ?? "");
  if (!repository || !Number.isSafeInteger(number) || number < 1) {
    return NextResponse.json({ error: "PR_INPUT_INVALID" }, { status: 400 });
  }
  try {
    const reviews = await listPullRequestReviews(user.uid, repository, number);
    return NextResponse.json({ reviews });
  } catch (err) {
    const code = err instanceof Error ? err.message.slice(0, 64) : "GITHUB_REVIEW_READ_FAILED";
    return NextResponse.json({ error: code }, { status: 400 });
  }
}

const submitSchema = z.object({
  repository: z.string().min(3).max(200),
  number: z.number().int().min(1).max(1_000_000_000),
  expectedHeadSha: z.string().regex(/^[a-f0-9]{40}$/i),
  event: z.enum(["COMMENT", "APPROVE", "REQUEST_CHANGES"]),
  body: z.string().max(4000).default(""),
});

export async function POST(req: NextRequest) {
  const csrf = mutationCsrfResponse(req);
  if (csrf) return csrf;
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });

  let body: z.infer<typeof submitSchema>;
  try {
    body = submitSchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "BAD_REQUEST" }, { status: 400 });
  }

  try {
    const review = await submitPullRequestReview(user.uid, body);
    if (adminConfigured()) {
      await adminDb()
        .collection("audit_logs")
        .add({
          actor_id: user.uid,
          action: `github.pr_review.${body.event.toLowerCase()}`,
          target_type: "github_pr",
          target_id: `${body.repository}#${body.number}`,
          reason: `Reviewed commit ${body.expectedHeadSha.slice(0, 12)}`,
          metadata: { review_id: review.id, commit_id: review.commitId },
          created_at: nowTs(),
        })
        .catch(() => {});
    }
    return NextResponse.json({ ok: true, review });
  } catch (err) {
    const code = err instanceof Error ? err.message.slice(0, 64) : "GITHUB_REVIEW_SUBMIT_FAILED";
    const status = code === "GITHUB_HEAD_CHANGED" || code === "PR_NOT_OPEN" ? 409 : 400;
    return NextResponse.json({ error: code }, { status });
  }
}
