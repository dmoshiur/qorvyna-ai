import "server-only";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { adminDb, nowTs } from "@/lib/firebase/admin";
import { env, isGithubConfigured } from "@/lib/env";
import { branchHead, checkedTarget, githubRequest, writableRepository } from "@/lib/server/github";

export type PrInput = { repository: string; base: string; head: string; title: string; body: string };
type Claims = { id: string; uid: string; digest: string; baseSha: string; headSha: string; expiresAt: number };
type File = { filename: string; status: string; additions: number; deletions: number; patch: string; previousFilename?: string };
const ttl = 10 * 60_000;
const sha = /^[a-f0-9]{40}$/i;
const digest = (input: PrInput) => createHash("sha256").update(JSON.stringify([input.repository, input.base, input.head, input.title, input.body])).digest("hex");
const signature = (payload: string) => createHmac("sha256", env.github.tokenEncryptionKey).update(`github-pr-review-v1:${payload}`).digest("base64url");
function assertInput(input: PrInput) {
  checkedTarget(input.repository, input.base);
  checkedTarget(input.repository, input.head);
  if (input.base === input.head || !input.title.trim() || input.title !== input.title.trim() || input.title.length > 160 || input.body.length > 10_000) throw new Error("PR_INPUT_INVALID");
}
function encode(claims: Claims) {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${payload}.${signature(payload)}`;
}
function decode(token: string, uid: string, input: PrInput): Claims {
  const [payload, signed, extra] = token.split(".");
  if (!isGithubConfigured() || !payload || !signed || extra || token.length > 2048) throw new Error("GITHUB_REVIEW_REQUIRED");
  const expected = Buffer.from(signature(payload)), actual = Buffer.from(signed);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("GITHUB_REVIEW_REQUIRED");
  let claims: Claims;
  try { claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { throw new Error("GITHUB_REVIEW_REQUIRED"); }
  const now = Date.now();
  if (!claims || !/^[A-Za-z0-9_-]{24}$/.test(claims.id ?? "") || claims.uid !== uid || claims.digest !== digest(input) ||
    !sha.test(claims.baseSha ?? "") || !sha.test(claims.headSha ?? "") || typeof claims.expiresAt !== "number" ||
    claims.expiresAt <= now || claims.expiresAt > now + ttl) throw new Error("GITHUB_REVIEW_REQUIRED");
  return claims;
}

export async function previewPullRequest(uid: string, input: PrInput): Promise<{ baseSha: string; headSha: string; totalCommits: number; files: File[]; expiresAt: number; reviewToken: string }> {
  assertInput(input);
  const signal = AbortSignal.timeout(25_000);
  await writableRepository(uid, input.repository, signal);
  const [baseSha, headSha] = await Promise.all([branchHead(uid, input.repository, input.base, signal), branchHead(uid, input.repository, input.head, signal)]);
  const compare = await githubRequest<{ status?: string; total_commits?: number; commits?: unknown[]; files?: Array<{ filename?: string; status?: string; additions?: number; deletions?: number; patch?: string; previous_filename?: string }> }>(uid, `/repos/${input.repository}/compare/${baseSha}...${headSha}?per_page=100`, { signal });
  if (!["ahead", "diverged"].includes(compare.status ?? "") || !Number.isInteger(compare.total_commits) || !compare.total_commits || compare.total_commits > 100 || !Array.isArray(compare.commits) || compare.commits.length !== compare.total_commits || !Array.isArray(compare.files) || !compare.files.length || compare.files.length >= 300) throw new Error("GITHUB_PR_COMPARISON_INCOMPLETE");
  let size = 0;
  const files: File[] = compare.files.map((f) => {
    if (typeof f.filename !== "string" || f.filename.length > 500 || !f.filename || !["added", "removed", "modified", "renamed"].includes(f.status ?? "") || typeof f.patch !== "string" || !Number.isSafeInteger(f.additions) || !Number.isSafeInteger(f.deletions) || f.additions! < 0 || f.deletions! < 0 || (f.previous_filename !== undefined && (typeof f.previous_filename !== "string" || f.previous_filename.length > 500))) throw new Error("GITHUB_PR_COMPARISON_INCOMPLETE");
    size += Buffer.byteLength(f.patch, "utf8");
    if (size > 600_000) throw new Error("GITHUB_PR_COMPARISON_INCOMPLETE");
    return { filename: f.filename, status: f.status!, additions: f.additions!, deletions: f.deletions!, patch: f.patch, ...(f.previous_filename ? { previousFilename: f.previous_filename } : {}) };
  });
  const expiresAt = Date.now() + ttl;
  const claims: Claims = { id: randomBytes(18).toString("base64url"), uid, digest: digest(input), baseSha, headSha, expiresAt };
  await adminDb().collection("github_pr_reviews").doc(claims.id).create({ user_id: uid, digest: claims.digest, base_sha: baseSha, head_sha: headSha, status: "pending", expires_at_ms: expiresAt, expire_at: new Date(expiresAt), created_at: nowTs() });
  return { baseSha, headSha, totalCommits: compare.total_commits, files, expiresAt, reviewToken: encode(claims) };
}

export async function createReviewedPullRequest(uid: string, input: PrInput, token: string): Promise<{ number: number; url: string }> {
  assertInput(input);
  const review = decode(token, uid, input);
  const signal = AbortSignal.timeout(25_000);
  await writableRepository(uid, input.repository, signal);
  const [baseSha, headSha] = await Promise.all([branchHead(uid, input.repository, input.base, signal), branchHead(uid, input.repository, input.head, signal)]);
  if (baseSha !== review.baseSha || headSha !== review.headSha) throw new Error("GITHUB_HEAD_CHANGED");
  const db = adminDb(), ref = db.collection("github_pr_reviews").doc(review.id);
  await db.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref); const data = snapshot.data();
    if (!snapshot.exists || data?.status !== "pending" || data.user_id !== uid || data.digest !== review.digest || data.base_sha !== review.baseSha || data.head_sha !== review.headSha || data.expires_at_ms !== review.expiresAt || review.expiresAt <= Date.now()) throw new Error("GITHUB_REVIEW_REQUIRED");
    tx.update(ref, { status: "used", used_at: nowTs() });
  });
  // GitHub accepts names, not expected OIDs. Branches may move after this
  // preflight; surface this explicitly and never retry uncertain outcomes.
  const result = await githubRequest<{ number?: number; html_url?: string }>(uid, `/repos/${input.repository}/pulls`, { method: "POST", signal, body: JSON.stringify({ title: input.title, body: input.body, base: input.base, head: input.head }) });
  const expectedOrigin = `https://github.com/${input.repository}/pull/`;
  if (!Number.isSafeInteger(result.number) || !result.number || result.number < 1 || result.html_url !== `${expectedOrigin}${result.number}`) throw new Error("GITHUB_PR_UNCONFIRMED");
  return { number: result.number, url: result.html_url };
}
