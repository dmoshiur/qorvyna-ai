// =============================================================================
// QORVYNA AI — Commit-bound GitHub Pull Request review listing & submission.
//
// Reviews are bound to the exact `headSha` inspected by the user so an unseen
// concurrent push cannot be silently approved.
// =============================================================================

import "server-only";
import { checkedTarget, githubRequest } from "@/lib/server/github";

const SHA = /^[a-f0-9]{40}$/i;

export type GithubPrReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

type RawReview = {
  id?: number;
  user?: { login?: string };
  state?: string;
  body?: string | null;
  commit_id?: string;
  submitted_at?: string;
  html_url?: string;
};

export async function listPullRequestReviews(uid: string, repository: string, number: number) {
  checkedTarget(repository, "main");
  if (!Number.isSafeInteger(number) || number < 1 || number > 1_000_000_000) {
    throw new Error("PR_INPUT_INVALID");
  }
  const rows = await githubRequest<RawReview[]>(
    uid,
    `/repos/${repository}/pulls/${number}/reviews?per_page=30`,
  );
  if (!Array.isArray(rows)) throw new Error("GITHUB_RESPONSE_INVALID");
  return rows
    .filter((r) => typeof r.id === "number")
    .map((r) => ({
      id: r.id!,
      author: String(r.user?.login ?? "").slice(0, 100),
      state: String(r.state ?? "").slice(0, 40),
      body: String(r.body ?? "").slice(0, 4000),
      commitId: String(r.commit_id ?? "").slice(0, 40),
      submittedAt: String(r.submitted_at ?? "").slice(0, 50),
      url: String(r.html_url ?? "").slice(0, 300),
    }));
}

export async function submitPullRequestReview(
  uid: string,
  input: {
    repository: string;
    number: number;
    expectedHeadSha: string;
    event: GithubPrReviewEvent;
    body: string;
  },
) {
  checkedTarget(input.repository, "main");
  if (!Number.isSafeInteger(input.number) || input.number < 1 || input.number > 1_000_000_000) {
    throw new Error("PR_INPUT_INVALID");
  }
  if (!SHA.test(input.expectedHeadSha)) {
    throw new Error("PR_SHA_INVALID");
  }
  if ((input.event === "COMMENT" || input.event === "REQUEST_CHANGES") && !input.body.trim()) {
    throw new Error("PR_REVIEW_BODY_REQUIRED");
  }

  // Re-verify the PR head SHA immediately before submitting the review.
  const pr = await githubRequest<{ state?: string; head?: { sha?: string } }>(
    uid,
    `/repos/${input.repository}/pulls/${input.number}`,
  );
  if (pr.state !== "open") throw new Error("PR_NOT_OPEN");
  if ((pr.head?.sha ?? "").toLowerCase() !== input.expectedHeadSha.toLowerCase()) {
    throw new Error("GITHUB_HEAD_CHANGED");
  }

  const created = await githubRequest<RawReview>(
    uid,
    `/repos/${input.repository}/pulls/${input.number}/reviews`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        commit_id: input.expectedHeadSha,
        event: input.event,
        body: input.body.trim().slice(0, 4000),
      }),
    },
  );

  if (typeof created?.id !== "number") throw new Error("GITHUB_RESPONSE_INVALID");
  return {
    id: created.id,
    state: String(created.state ?? input.event),
    commitId: String(created.commit_id ?? input.expectedHeadSha),
    submittedAt: String(created.submitted_at ?? new Date().toISOString()),
    url: String(created.html_url ?? `https://github.com/${input.repository}/pull/${input.number}`),
  };
}
