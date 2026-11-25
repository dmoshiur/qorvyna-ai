import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { adminDb, nowTs } from "@/lib/firebase/admin";
import { env, isGithubConfigured } from "@/lib/env";
import { checkedTarget, githubRequest, writableRepository } from "@/lib/server/github";

type Input = { repository: string; number: number };
type Pr = { number?: number; title?: string; state?: string; draft?: boolean; merged?: boolean; mergeable?: boolean | null; changed_files?: number; updated_at?: string; base?: { ref?: string; sha?: string; repo?: { full_name?: string } }; head?: { sha?: string; repo?: { full_name?: string } } };
type RemoteFile = { filename?: string; previous_filename?: string; status?: string; additions?: number; deletions?: number; patch?: string };
type Claims = { id: string; uid: string; repository: string; number: number; base: string; baseSha: string; headSha: string; expiresAt: number };
const SHA = /^[a-f0-9]{40}$/i;
const TTL = 10 * 60_000;
function assertInput(input: Input) {
  checkedTarget(input.repository, "main");
  if (input.repository.length > 200 || !Number.isSafeInteger(input.number) || input.number < 1 || input.number > 1_000_000_000) throw new Error("PR_INPUT_INVALID");
}
function checkPr(pr: Pr, input: Input) {
  if (pr.number !== input.number || pr.state !== "open" || pr.draft !== false || pr.merged === true || pr.mergeable !== true ||
      typeof pr.base?.ref !== "string" || !SHA.test(pr.base.sha ?? "") || !SHA.test(pr.head?.sha ?? "") ||
      pr.base.repo?.full_name?.toLowerCase() !== input.repository.toLowerCase() || pr.head?.repo?.full_name?.toLowerCase() !== input.repository.toLowerCase() ||
      typeof pr.updated_at !== "string" || !pr.updated_at || !Number.isSafeInteger(pr.changed_files) || pr.changed_files! < 1 || pr.changed_files! > 100) {
    throw new Error("GITHUB_PR_MERGE_UNAVAILABLE");
  }
  checkedTarget(input.repository, pr.base.ref);
  return { base: pr.base.ref, baseSha: pr.base.sha!, headSha: pr.head!.sha!, updatedAt: pr.updated_at, changedFiles: pr.changed_files!, title: typeof pr.title === "string" ? pr.title.slice(0, 300) : "" };
}
const sign = (payload: string) => createHmac("sha256", env.github.tokenEncryptionKey).update(`github-pr-merge-v1:${payload}`).digest("base64url");
function encode(claims: Claims) { const payload = Buffer.from(JSON.stringify(claims)).toString("base64url"); return `${payload}.${sign(payload)}`; }
function decode(token: string, uid: string, input: Input): Claims {
  const [payload, signature, extra] = token.split(".");
  if (!isGithubConfigured() || !payload || !signature || extra || token.length > 2048) throw new Error("GITHUB_REVIEW_REQUIRED");
  const expected = Buffer.from(sign(payload)), actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error("GITHUB_REVIEW_REQUIRED");
  let c: Claims;
  try { c = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { throw new Error("GITHUB_REVIEW_REQUIRED"); }
  const now = Date.now();
  if (!c || !/^[A-Za-z0-9_-]{24}$/.test(c.id ?? "") || c.uid !== uid || c.repository !== input.repository || c.number !== input.number ||
    typeof c.base !== "string" || !SHA.test(c.baseSha ?? "") || !SHA.test(c.headSha ?? "") || typeof c.expiresAt !== "number" || c.expiresAt <= now || c.expiresAt > now + TTL) throw new Error("GITHUB_REVIEW_REQUIRED");
  return c;
}
export async function previewGithubMerge(uid: string, input: Input) {
  assertInput(input);
  const signal = AbortSignal.timeout(25_000);
  await writableRepository(uid, input.repository, signal);
  const path = `/repos/${input.repository}/pulls/${input.number}`;
  const before = checkPr(await githubRequest<Pr>(uid, path, { signal }), input);
  const remote = await githubRequest<RemoteFile[]>(uid, `${path}/files?per_page=100&page=1`, { signal });
  if (!Array.isArray(remote) || remote.length !== before.changedFiles) throw new Error("GITHUB_PR_COMPARISON_INCOMPLETE");
  let total = 0;
  const files = remote.map((f) => {
    if (typeof f.filename !== "string" || !f.filename || f.filename.length > 500 || !["added", "removed", "modified", "renamed"].includes(f.status ?? "") || typeof f.patch !== "string" || !Number.isSafeInteger(f.additions) || !Number.isSafeInteger(f.deletions) || f.additions! < 0 || f.deletions! < 0 || (f.previous_filename !== undefined && (typeof f.previous_filename !== "string" || f.previous_filename.length > 500))) throw new Error("GITHUB_PR_COMPARISON_INCOMPLETE");
    total += Buffer.byteLength(f.patch, "utf8");
    if (total > 600_000) throw new Error("GITHUB_PR_COMPARISON_INCOMPLETE");
    return { filename: f.filename, previousFilename: f.previous_filename ?? "", status: f.status!, additions: f.additions!, deletions: f.deletions!, patch: f.patch };
  });
  const after = checkPr(await githubRequest<Pr>(uid, path, { signal }), input);
  if (before.base !== after.base || before.baseSha !== after.baseSha || before.headSha !== after.headSha || before.updatedAt !== after.updatedAt || before.changedFiles !== after.changedFiles) throw new Error("GITHUB_HEAD_CHANGED");
  const expiresAt = Date.now() + TTL;
  const claims: Claims = { id: randomBytes(18).toString("base64url"), uid, repository: input.repository, number: input.number, base: before.base, baseSha: before.baseSha, headSha: before.headSha, expiresAt };
  await adminDb().collection("github_merge_reviews").doc(claims.id).create({ user_id: uid, repository: claims.repository, number: claims.number, base: claims.base, base_sha: claims.baseSha, head_sha: claims.headSha, status: "pending", expires_at_ms: expiresAt, expire_at: new Date(expiresAt), created_at: nowTs() });
  return { title: before.title, base: before.base, baseSha: before.baseSha, headSha: before.headSha, files, expiresAt, reviewToken: encode(claims) };
}
export async function mergeGithubPullRequest(uid: string, input: Input, token: string) {
  assertInput(input);
  const review = decode(token, uid, input);
  const signal = AbortSignal.timeout(25_000);
  await writableRepository(uid, input.repository, signal);
  const path = `/repos/${input.repository}/pulls/${input.number}`;
  const now = checkPr(await githubRequest<Pr>(uid, path, { signal }), input);
  if (now.base !== review.base || now.baseSha !== review.baseSha || now.headSha !== review.headSha) throw new Error("GITHUB_HEAD_CHANGED");
  const db = adminDb(), ref = db.collection("github_merge_reviews").doc(review.id);
  await db.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref), data = snapshot.data();
    if (!snapshot.exists || data?.status !== "pending" || data.user_id !== uid || data.repository !== review.repository || data.number !== review.number || data.base !== review.base || data.base_sha !== review.baseSha || data.head_sha !== review.headSha || data.expires_at_ms !== review.expiresAt || review.expiresAt <= Date.now()) throw new Error("GITHUB_REVIEW_REQUIRED");
    tx.update(ref, { status: "used", used_at: nowTs() });
  });
  // The GitHub merge API guards head SHA, not base SHA. Base can move after
  // preflight; the UI must explain this. Never retry uncertain writes.
  const result = await githubRequest<{ merged?: boolean; sha?: string }>(uid, `${path}/merge`, { method: "PUT", signal, body: JSON.stringify({ sha: review.headSha, merge_method: "merge" }) });
  if (result.merged !== true || !SHA.test(result.sha ?? "")) throw new Error("GITHUB_MERGE_UNCONFIRMED");
  return { merged: true as const, sha: result.sha! };
}
