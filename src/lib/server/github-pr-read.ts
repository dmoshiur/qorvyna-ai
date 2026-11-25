import "server-only";
import { checkedTarget, githubRequest } from "@/lib/server/github";

const pageSize = 20;
type GithubPr = {
  number?: number; title?: string; body?: string | null; state?: string; draft?: boolean; merged_at?: string | null;
  html_url?: string; updated_at?: string; user?: { login?: string }; base?: { ref?: string; sha?: string };
  head?: { ref?: string; sha?: string; repo?: { full_name?: string } | null }; changed_files?: number;
};
type GithubFile = { filename?: string; previous_filename?: string; status?: string; additions?: number; deletions?: number; patch?: string };
const short = (value: unknown, max: number) => typeof value === "string" ? value.slice(0, max) : "";
const SHA = /^[a-f0-9]{40}$/i;
function target(repository: string, page: number): void {
  checkedTarget(repository, "main");
  if (repository.length > 200 || !Number.isSafeInteger(page) || page < 1 || page > 10) throw new Error("PR_INPUT_INVALID");
}
function parsePr(item: GithubPr, repository: string) {
  if (!Number.isSafeInteger(item.number) || !item.number || item.number < 1 || item.number > 1_000_000_000 || !["open", "closed"].includes(item.state ?? "") ||
      item.html_url !== `https://github.com/${repository}/pull/${item.number}` || !SHA.test(item.head?.sha ?? "") || !SHA.test(item.base?.sha ?? "")) throw new Error("GITHUB_RESPONSE_INVALID");
  return { number: item.number, title: short(item.title, 300), state: item.state!, draft: item.draft === true, merged: Boolean(item.merged_at), url: item.html_url,
    updatedAt: short(item.updated_at, 50), author: short(item.user?.login, 100),
    base: short(item.base?.ref, 180), baseSha: item.base!.sha!, head: short(item.head?.ref, 180), headSha: item.head!.sha!,
    headRepository: short(item.head?.repo?.full_name, 200) };
}
export async function listGithubPullRequests(uid: string, repository: string, page: number) {
  target(repository, page);
  const rows = await githubRequest<GithubPr[]>(uid, `/repos/${repository}/pulls?state=all&sort=updated&direction=desc&per_page=${pageSize}&page=${page}`);
  if (!Array.isArray(rows) || rows.length > pageSize) throw new Error("GITHUB_RESPONSE_INVALID");
  return { pullRequests: rows.map((row) => parsePr(row, repository)), page, hasMore: rows.length === pageSize && page < 10 };
}
export async function inspectGithubPullRequest(uid: string, repository: string, number: number, page: number) {
  target(repository, page);
  if (!Number.isSafeInteger(number) || number < 1 || number > 1_000_000_000) throw new Error("PR_INPUT_INVALID");
  const signal = AbortSignal.timeout(25_000);
  const path = `/repos/${repository}/pulls/${number}`;
  const before = await githubRequest<GithubPr>(uid, path, { signal });
  const summary = parsePr(before, repository);
  if (summary.number !== number) throw new Error("GITHUB_RESPONSE_INVALID");
  const files = await githubRequest<GithubFile[]>(uid, `${path}/files?per_page=${pageSize}&page=${page}`, { signal });
  if (!Array.isArray(files) || files.length > pageSize) throw new Error("GITHUB_RESPONSE_INVALID");
  // Do not mix a file page with an updated PR after a concurrent push. This is
  // still not a frozen snapshot; another update can happen after the check.
  const after = parsePr(await githubRequest<GithubPr>(uid, path, { signal }), repository);
  if (after.number !== number || summary.headSha !== after.headSha || summary.baseSha !== after.baseSha || summary.state !== after.state || summary.updatedAt !== after.updatedAt) throw new Error("GITHUB_HEAD_CHANGED");
  let truncated = false;
  const safeFiles = files.map((file) => {
    if (typeof file.filename !== "string" || !file.filename || file.filename.length > 500 || !Number.isSafeInteger(file.additions) || !Number.isSafeInteger(file.deletions)) throw new Error("GITHUB_RESPONSE_INVALID");
    const missing = typeof file.patch !== "string";
    const patch = missing ? null : file.patch!.slice(0, 20_000);
    const patchTruncated = !missing && file.patch!.length > 20_000;
    if (missing || patchTruncated) truncated = true;
    return { filename: file.filename, previousFilename: short(file.previous_filename, 500), status: short(file.status, 32), additions: file.additions!, deletions: file.deletions!, patch, patchTruncated };
  });
  return { pullRequest: { ...summary, body: short(before.body, 5000), bodyTruncated: typeof before.body === "string" && before.body.length > 5000,
    changedFiles: Number.isSafeInteger(before.changed_files) && before.changed_files! >= 0 ? before.changed_files : null },
    files: safeFiles, page, hasMore: files.length === pageSize && page < 10, patchesIncomplete: truncated };
}
