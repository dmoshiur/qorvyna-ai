"use client";
import { useState } from "react";
import { useDialogs } from "@/components/dialogs";
import { Button } from "@/components/ui";

type File = { filename: string; previousFilename: string; status: string; additions: number; deletions: number; patch: string };
type Review = { title: string; base: string; baseSha: string; headSha: string; files: File[]; expiresAt: number; reviewToken: string };
export function GithubMergeReview({ repository, number }: { repository: string; number: number }) {
  const dialogs = useDialogs();
  const [review, setReview] = useState<Review | null>(null);
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [merged, setMerged] = useState(false);
  async function preview() {
    setBusy(true); setReview(null); setApproved(false); setNotice("");
    try {
      const response = await fetch("/api/github/pull-requests/merge/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repository, number }) });
      const data = await response.json() as Review & { error?: string };
      if (!response.ok || !data.reviewToken) throw new Error(data.error || "PREVIEW_FAILED");
      setReview(data);
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      setNotice(code === "GITHUB_HEAD_CHANGED" ? "The PR changed during review. Refresh before trying again." : code === "GITHUB_PR_MERGE_UNAVAILABLE" ? "This PR is not eligible, GitHub is still computing mergeability, or it is unsupported here." : "A complete supported merge preview could not be loaded. Review on GitHub instead.");
    } finally { setBusy(false); }
  }
  async function merge() {
    if (!review || !approved || review.expiresAt <= Date.now()) return;
    const confirmed = await dialogs.confirm({ title: `Merge pull request #${number}?`, body: `Merge ${repository} PR #${number} into ${review.base}. GitHub checks the source commit but the target branch can move during the merge. This changes the repository.`, confirmLabel: "Merge pull request", tone: "danger" });
    if (!confirmed) return;
    setBusy(true); setNotice("");
    try {
      const response = await fetch("/api/github/pull-requests/merge/execute", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repository, number, reviewToken: review.reviewToken }) });
      const data = await response.json() as { merged?: boolean; sha?: string; error?: string };
      if (!response.ok || data.merged !== true || !data.sha) throw new Error(data.error || "MERGE_UNCONFIRMED");
      setMerged(true); setNotice(`GitHub confirmed merge commit ${data.sha.slice(0, 12)}.`); setReview(null); setApproved(false);
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      setReview(null); setApproved(false);
      setNotice(code === "GITHUB_HEAD_CHANGED" || code === "GITHUB_REVIEW_REQUIRED" ? "The review or branch changed. Load a new merge review." : "Merge could not be confirmed. Check the PR on GitHub before trying again.");
    } finally { setBusy(false); }
  }
  return <section aria-label="Review merge" className="space-y-2 rounded-lg border border-warning/30 p-3">
    <p className="text-xs text-ink-2">Merging changes the target branch. GitHub enforces repository permissions and branch protection.</p>
    <Button variant="secondary" disabled={busy || merged} onClick={() => void preview()}>Load merge review</Button>
    {review && review.expiresAt > Date.now() ? <div className="space-y-2">
      <p className="text-xs text-warning">{review.title} · target {review.base} at {review.baseSha.slice(0, 12)} · source {review.headSha.slice(0, 12)}. GitHub patches may omit details; inspect the full current PR on GitHub. GitHub checks the source SHA during merge, but the target branch may change after this check.</p>
      {review.files.map((file) => <details key={file.filename} className="rounded-lg border border-border p-2"><summary className="cursor-pointer break-all text-xs">{file.filename} · {file.status} · +{file.additions} −{file.deletions}{file.previousFilename ? ` · from ${file.previousFilename}` : ""}</summary><pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-all rounded bg-surface-2 p-2 text-xs">{file.patch}</pre></details>)}
      <label className="flex items-start gap-2 text-xs text-ink-2"><input type="checkbox" disabled={busy} checked={approved} onChange={(event) => setApproved(event.target.checked)} /><span>I reviewed the current pull request and approve merging it into {review.base}.</span></label>
      <Button disabled={busy || !approved} onClick={() => void merge()}>Merge pull request</Button>
    </div> : review ? <p className="text-xs text-warning">Review expired. Load it again.</p> : null}
    {notice ? <p role="status" className="text-xs text-ink-2">{notice}</p> : null}
    {dialogs.element}
  </section>;
}
