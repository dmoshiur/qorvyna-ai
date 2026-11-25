"use client";
import { useState } from "react";
import { GithubMergeReview } from "@/components/github-merge-review";
import { Button } from "@/components/ui";

type Pr = { number: number; title: string; state: string; draft: boolean; merged: boolean; url: string; author: string; base: string; baseSha: string; head: string; headSha: string; headRepository: string };
type File = { filename: string; previousFilename: string; status: string; additions: number; deletions: number; patch: string | null; patchTruncated: boolean };
type List = { pullRequests: Pr[]; page: number; hasMore: boolean };
type Inspection = { pullRequest: Pr & { body: string; bodyTruncated: boolean; changedFiles: number | null }; files: File[]; page: number; hasMore: boolean; patchesIncomplete: boolean };

/** Browsing is read-only; merge has a separate explicit review and confirmation. */
export function GithubPullRequestBrowser({ repository }: { repository: string }) {
  const [list, setList] = useState<List | null>(null);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  async function loadList(page: number) {
    setBusy(true); setNotice(""); setInspection(null);
    try {
      const query = new URLSearchParams({ repository, page: String(page) });
      const response = await fetch(`/api/github/pull-requests?${query}`, { cache: "no-store" });
      if (!response.ok) throw new Error("LIST_FAILED");
      setList(await response.json() as List);
    } catch { setNotice("Could not load pull requests. Check GitHub access and try again."); }
    finally { setBusy(false); }
  }
  async function inspect(number: number, page: number) {
    setBusy(true); setNotice(""); setInspection(null);
    try {
      const query = new URLSearchParams({ repository, number: String(number), page: String(page) });
      const response = await fetch(`/api/github/pull-requests/inspect?${query}`, { cache: "no-store" });
      const data = await response.json() as Inspection & { error?: string };
      if (!response.ok) throw new Error(data.error || "INSPECT_FAILED");
      setInspection(data);
    } catch (error) {
      setNotice(error instanceof Error && error.message === "GITHUB_HEAD_CHANGED" ? "The pull request changed during inspection. Refresh it before reviewing." : "Could not inspect the pull request. Check GitHub access and try again.");
    } finally { setBusy(false); }
  }
  return <section className="space-y-3 rounded-xl border border-border p-3" aria-label="Browse pull requests">
    <h3 className="text-sm font-semibold text-ink">Browse pull requests</h3>
    <p className="text-xs text-ink-2">Inspection is read-only, newest updates first. Shows up to 200 pull requests and 200 files per pull request.</p>
    <Button variant="secondary" disabled={busy} onClick={() => void loadList(1)}>{busy ? "Loading…" : "Load pull requests"}</Button>
    {list ? <div className="space-y-2">
      {list.pullRequests.length === 0 ? <p className="text-xs text-ink-3">No pull requests on this page.</p> : <ul className="space-y-1">{list.pullRequests.map((pr) => <li key={pr.number}><button type="button" disabled={busy} onClick={() => void inspect(pr.number, 1)} className="w-full rounded-lg border border-border p-2 text-left text-xs text-ink-2 hover:bg-surface-2"><span className="font-medium text-ink">#{pr.number} {pr.title}</span><span className="ml-2">{pr.merged ? "merged" : pr.state}{pr.draft ? " · draft" : ""}</span></button></li>)}</ul>}
      <div className="flex items-center gap-2 text-xs"><Button variant="secondary" disabled={busy || list.page <= 1} onClick={() => void loadList(list.page - 1)}>Previous</Button><span>Page {list.page}</span><Button variant="secondary" disabled={busy || !list.hasMore} onClick={() => void loadList(list.page + 1)}>Next</Button></div>
    </div> : null}
    {inspection ? <div className="space-y-2" aria-label="Pull request details">
      <h4 className="break-all text-xs font-semibold">#{inspection.pullRequest.number} {inspection.pullRequest.title}</h4>
      <p className="text-xs text-ink-2">{inspection.pullRequest.headRepository || "deleted fork"}:{inspection.pullRequest.head} ({inspection.pullRequest.headSha.slice(0, 12)}) → {inspection.pullRequest.base} ({inspection.pullRequest.baseSha.slice(0, 12)}) · {inspection.pullRequest.author || "unknown author"}</p>
      {inspection.pullRequest.body ? <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-surface-2 p-2 text-xs">{inspection.pullRequest.body}{inspection.pullRequest.bodyTruncated ? "\n…description truncated" : ""}</pre> : null}
      <p className="text-xs text-warning">This is not a frozen review. Branches and file pages can change; GitHub patches may omit or truncate details. Verify the current PR on GitHub before merging.</p>
      {inspection.files.map((file) => <details key={file.filename} className="rounded-lg border border-border p-2"><summary className="cursor-pointer break-all text-xs">{file.filename} · {file.status} · +{file.additions} −{file.deletions}{file.previousFilename ? ` · from ${file.previousFilename}` : ""}</summary><pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-all rounded bg-surface-2 p-2 text-xs">{file.patch === null ? "Patch unavailable (for example, a binary file)." : file.patch}{file.patchTruncated ? "\n…patch truncated" : ""}</pre></details>)}
      {inspection.files.length === 0 ? <p className="text-xs text-ink-3">No files on this page.</p> : null}
      <div className="flex flex-wrap items-center gap-2 text-xs"><Button variant="secondary" disabled={busy || inspection.page <= 1} onClick={() => void inspect(inspection.pullRequest.number, inspection.page - 1)}>Previous files</Button><span>File page {inspection.page}{inspection.pullRequest.changedFiles !== null ? ` · ${inspection.pullRequest.changedFiles} changed files` : ""}</span><Button variant="secondary" disabled={busy || !inspection.hasMore} onClick={() => void inspect(inspection.pullRequest.number, inspection.page + 1)}>Next files</Button></div>
      <a href={inspection.pullRequest.url} target="_blank" rel="noopener noreferrer" className="text-xs font-medium text-accent underline">Open current PR on GitHub</a>
      {inspection.pullRequest.state === "open" && !inspection.pullRequest.draft && inspection.pullRequest.headRepository.toLowerCase() === repository.toLowerCase() ? <GithubMergeReview key={inspection.pullRequest.number} repository={repository} number={inspection.pullRequest.number} /> : null}
    </div> : null}
    {notice ? <p role="status" className="text-xs text-warning">{notice}</p> : null}
  </section>;
}
