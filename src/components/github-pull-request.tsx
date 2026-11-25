"use client";
import { useEffect, useState } from "react";
import { GitPullRequest, Loader2 } from "lucide-react";
import { useDialogs } from "@/components/dialogs";
import { Button, Input } from "@/components/ui";

type PrFile = { filename: string; status: string; additions: number; deletions: number; patch: string; previousFilename?: string };
type PrReview = { baseSha: string; headSha: string; totalCommits: number; files: PrFile[]; expiresAt: number; reviewToken: string; inputKey: string };

/** Same-repository PR creation only; never merges or creates a branch. */
export function GithubPullRequest({ repository, defaultBranch, sourceBranch }: { repository: string; defaultBranch: string; sourceBranch: string }) {
  const dialogs = useDialogs();
  const [base, setBase] = useState(defaultBranch);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [review, setReview] = useState<PrReview | null>(null);
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [prUrl, setPrUrl] = useState("");
  const input = { repository, base, head: sourceBranch, title: title.trim(), body };
  const inputKey = JSON.stringify(input);
  const current = review?.inputKey === inputKey && review.expiresAt > Date.now();
  useEffect(() => { setApproved(false); }, [inputKey]);

  async function compare() {
    if (!repository || !base || !sourceBranch || !title.trim()) return;
    setBusy(true); setNotice(""); setApproved(false); setReview(null); setPrUrl("");
    try {
      const response = await fetch("/api/github/pull-requests/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
      const result = await response.json() as Omit<PrReview, "inputKey"> & { error?: string };
      if (!response.ok || !result.reviewToken) throw new Error(result.error || "PR_PREVIEW_FAILED");
      setReview({ ...result, inputKey });
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      setNotice(code === "GITHUB_PR_COMPARISON_INCOMPLETE" ? "GitHub did not provide a supported comparison. Review and create this pull request on GitHub instead." : "Could not compare branches. Check their names, permissions and rate limits, then try again.");
    } finally { setBusy(false); }
  }
  async function create() {
    if (!review || !current || !approved) return;
    const ok = await dialogs.confirm({ title: "Create pull request?", body: `Open a pull request in ${repository} from ${sourceBranch} to ${base}. GitHub tracks live branches, which may change after this comparison. This does not merge.`, confirmLabel: "Create pull request", tone: "primary" });
    if (!ok) return;
    setBusy(true); setNotice("");
    try {
      const response = await fetch("/api/github/pull-requests/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...input, reviewToken: review.reviewToken }) });
      const result = await response.json() as { error?: string; url?: string; number?: number };
      if (!response.ok || !result.url) throw new Error(result.error || "PR_UNCONFIRMED");
      setPrUrl(result.url); setNotice(`Pull request #${result.number} created. Inspect its current changes on GitHub before merging.`); setReview(null); setApproved(false);
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      setReview(null); setApproved(false);
      setNotice(code === "GITHUB_HEAD_CHANGED" || code === "GITHUB_REVIEW_REQUIRED" ? "A branch or review changed. Compare again before creating a pull request." : "Creation could not be confirmed. Check existing pull requests on GitHub before retrying to avoid duplicates.");
    } finally { setBusy(false); }
  }
  return (
    <section className="space-y-3 rounded-xl border border-border p-3" aria-label="Pull request">
      <h3 className="flex items-center gap-2 text-sm font-semibold"><GitPullRequest size={15} /> Create pull request</h3>
      <p className="text-xs leading-relaxed text-ink-2">Source: <span className="font-mono">{sourceBranch || "select a branch above"}</span>. Same-repository branches only; creating a pull request does not merge it.</p>
      <label className="block text-xs text-ink-2">Target branch<Input value={base} onChange={(event) => { setBase(event.target.value); setApproved(false); }} disabled={busy} maxLength={180} /></label>
      <label className="block text-xs text-ink-2">Title<Input value={title} onChange={(event) => { setTitle(event.target.value); setApproved(false); }} disabled={busy} maxLength={160} /></label>
      <label className="block text-xs text-ink-2">Description<textarea value={body} onChange={(event) => { setBody(event.target.value); setApproved(false); }} disabled={busy} maxLength={10000} rows={3} className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink" /></label>
      <Button variant="secondary" className="w-full" disabled={busy || !repository || !sourceBranch || !base || !title.trim()} onClick={() => void compare()}>{busy ? <Loader2 className="animate-spin" size={15} /> : null} Compare branches</Button>
      {review && current ? <div className="space-y-2" aria-label="Pull request comparison">
        <p className="text-xs text-ink-2">Base {review.baseSha.slice(0, 12)} · source {review.headSha.slice(0, 12)} · {review.totalCommits} commit(s). GitHub-supplied patches may omit detail; verify the current PR on GitHub before merging. Branches can change at any time.</p>
        {review.files.map((file) => <details key={file.filename} className="rounded-lg border border-border p-2"><summary className="cursor-pointer break-all text-xs">{file.filename} · {file.status} · +{file.additions} −{file.deletions}{file.previousFilename ? ` · from ${file.previousFilename}` : ""}</summary><pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-all rounded bg-surface-2 p-2 text-xs">{file.patch}</pre></details>)}
        <label className="flex items-start gap-2 text-xs text-ink-2"><input type="checkbox" checked={approved} disabled={busy} onChange={(event) => setApproved(event.target.checked)} /><span>I reviewed these branch changes and approve creating this pull request.</span></label>
        <Button className="w-full" disabled={busy || !approved} onClick={() => void create()}>Create pull request</Button>
      </div> : review ? <p className="text-xs text-warning">Inputs changed or review expired. Compare again.</p> : null}
      {notice ? <p className="text-xs leading-relaxed text-ink-2">{notice} {prUrl ? <a href={prUrl} target="_blank" rel="noopener noreferrer" className="font-medium text-accent underline">Open pull request</a> : null}</p> : null}
      {dialogs.element}
    </section>
  );
}
