"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Github, GitPullRequestArrow, Link2, Loader2, LogOut, ShieldCheck } from "lucide-react";
import type { AgentFile } from "@/lib/ai/agent";
import { GithubPullRequestBrowser } from "@/components/github-pull-request-browser";
import { GithubPullRequest } from "@/components/github-pull-request";
import { useDialogs } from "@/components/dialogs";
import { Button, Input, Select } from "@/components/ui";

export type GithubStatus = {
  configured: boolean;
  connected: boolean;
  configuration_error?: string;
  connection?: { login: string; name: string; avatarUrl: string; connectedAt: string } | null;
};

type Repo = {
  id: number;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  permissions: { push: boolean };
};

type GithubFile = AgentFile & { encoding?: "utf8" | "base64" };
type Review = { head: string; expiresAt: number; reviewToken: string; files: Array<{ path: string; before: string | null; after: string; status: "new" | "changed" | "unchanged" }>; inputKey: string };

type ImportRequest = { files: Array<{ path: string; content: string }>; localFiles: Array<{ path: string; content: string }>; expectedRevision: number; projectId: string };
export function GithubConnection({ files = [], showPush = false, projectRevision, projectId, importDisabled = false, onImport }: {
  files?: GithubFile[]; showPush?: boolean; projectRevision?: number; projectId?: string; importDisabled?: boolean;
  onImport?: (request: ImportRequest) => Promise<void>;
}) {
  const dialogs = useDialogs();
  const [status, setStatus] = useState<GithubStatus | null>(null);
  const [connectHref, setConnectHref] = useState("/api/github/connect");
  useEffect(() => {
    const path = window.location.pathname;
    if (/^\/chat(?:\/[a-zA-Z0-9_-]{1,128})?$/.test(path)) {
      setConnectHref(`/api/github/connect?next=${encodeURIComponent(path)}`);
    }
  }, []);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [repository, setRepository] = useState("");
  const [branch, setBranch] = useState("");
  const [message, setMessage] = useState("Apply QORVYNA Agent changes");
  const [reviewed, setReviewed] = useState(false);
  const [importApproved, setImportApproved] = useState(false);
  const [preview, setPreview] = useState<Review | null>(null);
  const [excluded, setExcluded] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [commitUrl, setCommitUrl] = useState<string | null>(null);

  const selectedRepo = useMemo(() => repos.find((repo) => repo.fullName === repository), [repos, repository]);
  // Binary workspace assets are not text: never send their base64 as file text.
  const selectedFiles = files.filter((file) => file.encoding !== "base64" && !excluded.includes(file.path));
  const inputKey = JSON.stringify([repository, branch, projectRevision, selectedFiles.map((file) => [file.path, file.content])]);
  const previewCurrent = preview?.inputKey === inputKey && preview.expiresAt > Date.now();


  const loadStatus = useCallback(async () => {
    try {
      const response = await fetch("/api/github/status", { cache: "no-store" });
      if (!response.ok) throw new Error("status");
      setStatus((await response.json()) as GithubStatus);
    } catch {
      setStatus({ configured: true, connected: false });
      setNotice("GitHub status could not be loaded. Try again.");
    }
  }, []);

  useEffect(() => { void loadStatus(); }, [loadStatus]);

  useEffect(() => {
    if (!showPush || !status?.connected) return;
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/github/repos", { cache: "no-store" });
        if (!response.ok) throw new Error("repos");
        const data = (await response.json()) as { repositories?: Repo[] };
        if (cancelled) return;
        const next = data.repositories ?? [];
        setRepos(next);
        if (next[0]) {
          setRepository((value) => value || next[0].fullName);
          setBranch((value) => value || next[0].defaultBranch);
        }
      } catch {
        if (!cancelled) setNotice("Your repositories could not be loaded. Reconnect GitHub and try again.");
      }
    })();
    return () => { cancelled = true; };
  }, [showPush, status?.connected]);

  useEffect(() => {
    if (selectedRepo) setBranch(selectedRepo.defaultBranch);
  }, [selectedRepo]);

  async function disconnect() {
    const confirmed = await dialogs.confirm({ title: "Disconnect GitHub?", body: "QORVYNA loses access to your repositories. Files already generated or pushed are not deleted.", confirmLabel: "Disconnect" });
    if (!confirmed) return;
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch("/api/github/status", { method: "DELETE" });
      if (!response.ok) throw new Error("disconnect");
      setStatus((current) => ({ configured: current?.configured ?? true, connected: false }));
      setRepos([]);
      setPreview(null);
      setReviewed(false);
    } catch {
      setNotice("GitHub could not be disconnected. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function loadPreview() {
    if (!repository || !branch || !selectedFiles.length) return;
    setBusy(true);
    setNotice(null);
    setReviewed(false);
    setImportApproved(false);
    setPreview(null);
    try {
      const response = await fetch("/api/github/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repository, branch, files: selectedFiles }),
      });
      const data = (await response.json().catch(() => ({}))) as Omit<Review, "inputKey"> & { error?: string };
      if (!response.ok || !data.reviewToken) throw new Error(data.error || "preview");
      setPreview({ ...data, inputKey });
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      setNotice(code === "GITHUB_RATE_LIMITED" ? "Too many GitHub requests. Wait a minute before comparing again." :
        code === "FILES_SENSITIVE" ? "Deselect environment files and private-key files before reviewing." :
        code === "GITHUB_REMOTE_FILE_UNSUPPORTED" || code === "GITHUB_REMOTE_FILES_TOO_LARGE" ? "A remote file is binary, executable, a symlink, too large or otherwise unsupported. Review it in GitHub instead." :
        code === "GITHUB_PUSH_FORBIDDEN" ? "This account does not have push permission for the selected repository." :
        "Could not load a complete comparison. Check the repository and branch, then try again.");
    } finally { setBusy(false); }
  }

  async function push() {
    if (!reviewed || !previewCurrent || !preview || !repository || !branch || !message.trim() || !selectedFiles.length) return;
    const confirmed = await dialogs.confirm({
      title: `Push ${selectedFiles.length} file${selectedFiles.length === 1 ? "" : "s"} to ${branch}?`,
      body: `Commit to ${repository} on ${branch} at reviewed HEAD ${preview.head.slice(0, 7)} with message: ${message.trim()}`,

      confirmLabel: "Push",
      tone: "primary",
    });
    if (!confirmed) return;
    setBusy(true);
    setNotice(null);
    setCommitUrl(null);
    try {
      const response = await fetch("/api/github/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "agent",
          repository,
          branch,
          message: message.trim(),
          files: selectedFiles,
          reviewToken: preview.reviewToken,
        }),
      });
      const data = (await response.json().catch(() => ({}))) as { error?: string; commitUrl?: string; commitSha?: string };
      if (!response.ok || !data.commitUrl) throw new Error(data.error || "push");
      setCommitUrl(data.commitUrl);
      setNotice(`Pushed commit ${data.commitSha?.slice(0, 7) ?? "successfully"}.`);
      setReviewed(false);
      setPreview(null);
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      if (code === "GITHUB_HEAD_CHANGED" || code === "GITHUB_REVIEW_REQUIRED") { setPreview(null); setReviewed(false); }
      setNotice(code === "GITHUB_RATE_LIMITED" ? "Too many push attempts. Wait a minute before retrying." :
        code === "GITHUB_HEAD_CHANGED" ? "The remote branch changed since review. Refresh the comparison before pushing." :
        code === "GITHUB_REVIEW_REQUIRED" ? "The review expired or changed. Refresh the comparison before pushing." :
        code === "FILES_SENSITIVE" ? "Remove environment files or private-key material before pushing." :
        code === "FILES_INVALID" || code === "FILES_TOO_LARGE" ? "Review the file paths and size limits before pushing." :
        code.includes("409") || code.includes("422") ? "GitHub rejected the update. Refresh the branch, review changes and try again." :
        "The push could not be confirmed. Check the branch and repository access before retrying.");
    } finally {
      setBusy(false);
    }
  }

  async function importRemote() {
    if (!onImport || !projectId || !importApproved || importDisabled || !previewCurrent || !preview || projectRevision === undefined) return;
    const changed = preview.files.filter((file) => file.before !== null && file.status === "changed");
    if (!changed.length) return;
    const revision = projectRevision;
    const confirmed = await dialogs.confirm({
      title: `Import ${changed.length} remote file${changed.length === 1 ? "" : "s"}?`,
      body: `Replace the selected workspace files with the versions shown at ${repository} commit ${preview.head.slice(0, 12)}. A snapshot is saved first. Imported code is untrusted and may run in a project preview.`,
      confirmLabel: "Import reviewed files", tone: "danger",
    });
    if (!confirmed) return;
    setBusy(true); setNotice(null);
    try {
      await onImport({ files: changed.map((file) => ({ path: file.path, content: file.before! })),
        localFiles: changed.map((file) => ({ path: file.path, content: file.after })), expectedRevision: revision, projectId });
      setPreview(null); setReviewed(false); setImportApproved(false);
      setNotice(`Imported ${changed.length} reviewed file${changed.length === 1 ? "" : "s"}. A snapshot of the previous workspace was saved.`);
    } catch {
      setPreview(null); setReviewed(false); setImportApproved(false);
      setNotice("Import could not be confirmed or the workspace changed. Check the workspace, reload if necessary, and compare again before retrying.");
    } finally { setBusy(false); }
  }

  if (!status) {
    return <div className="flex items-center gap-2 py-4 text-sm text-ink-3"><Loader2 className="animate-spin" size={15} /> Checking GitHub connection…</div>;
  }

  if (!status.configured) {
    return (
      <div className="rounded-xl border border-warning/30 bg-warning-soft p-4">
        <p className="text-sm font-semibold text-warning">GitHub connection is not configured</p>
        <p className="mt-1 text-xs leading-relaxed text-ink-2">The administrator must configure the GitHub OAuth credentials, NEXT_PUBLIC_APP_URL and the matching callback URL before direct push can be enabled.{status.configuration_error ? ` (${status.configuration_error})` : ""}</p>
      </div>
    );
  }

  if (!status.connected) {
    return (
      <div className="rounded-xl border border-border bg-surface-2 p-4">
        <div className="flex items-start gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-border-strong bg-surface"><Github size={18} /></span>
          <div>
            <p className="text-sm font-semibold text-ink">Connect GitHub</p>
            <p className="mt-1 text-xs leading-relaxed text-ink-2">Authorise repository access to push files you have reviewed in Agent mode. QORVYNA encrypts the OAuth token server-side and never sends it to the AI model.</p>
          </div>
        </div>
        <a href={connectHref} className="mt-4 inline-flex min-h-10 w-full items-center justify-center gap-2 rounded-lg bg-ink px-4 text-sm font-medium text-bg hover:bg-ink-2">
          <Github size={15} /> Continue with GitHub
        </a>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-surface-2 p-3">
        <div className="flex min-w-0 items-center gap-2.5">
          {status.connection?.avatarUrl ? <img src={status.connection.avatarUrl} alt="" className="h-8 w-8 rounded-full" /> : <Github size={18} />}
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-ink">@{status.connection?.login}</p>
            <p className="flex items-center gap-1 text-[11px] text-success"><ShieldCheck size={11} /> Connected securely</p>
          </div>
        </div>
        <button type="button" onClick={() => void disconnect()} disabled={busy} className="grid h-9 w-9 place-items-center rounded-lg text-ink-3 hover:bg-surface hover:text-danger" aria-label="Disconnect GitHub" title="Disconnect GitHub">
          <LogOut size={14} />
        </button>
      </div>

      {showPush ? (
        <div className="space-y-3">
          <div>
            <label htmlFor="agent-repository" className="mb-1.5 block text-xs font-medium text-ink-2">Repository</label>
            <Select id="agent-repository" value={repository} onChange={(event) => { setRepository(event.target.value); setReviewed(false); setImportApproved(false); }} disabled={busy || repos.length === 0}>
              {repos.length === 0 ? <option value="">No writable repositories found</option> : repos.map((repo) => <option key={repo.id} value={repo.fullName}>{repo.fullName}{repo.private ? " · private" : ""}</option>)}
            </Select>
          </div>
          <div>
            <label htmlFor="agent-branch" className="mb-1.5 block text-xs font-medium text-ink-2">Branch</label>
            <Input id="agent-branch" value={branch} onChange={(event) => { setBranch(event.target.value); setReviewed(false); setImportApproved(false); }} disabled={busy} placeholder="main" />
          </div>
          <div>
            <label htmlFor="agent-commit" className="mb-1.5 block text-xs font-medium text-ink-2">Commit message</label>
            <Input id="agent-commit" value={message} onChange={(event) => { setMessage(event.target.value); setReviewed(false); }} disabled={busy} maxLength={160} />
          </div>
          <fieldset className="rounded-lg border border-border p-3">
            <legend className="px-1 text-xs font-medium text-ink-2">Files to review and push</legend>
            <div className="max-h-44 space-y-2 overflow-auto">
              {files.map((file) => (
                <label key={file.path} className="flex items-start gap-2 text-xs text-ink-2">
                  <input type="checkbox" disabled={busy || file.encoding === "base64"} checked={file.encoding !== "base64" && !excluded.includes(file.path)}
                    onChange={(event) => { setExcluded((current) => event.target.checked ? current.filter((path) => path !== file.path) : [...current, file.path]); setReviewed(false); setImportApproved(false); }} />
                  <span className="break-all">{file.path}{file.encoding === "base64" ? " · binary files are not supported" : ""}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <Button onClick={() => void loadPreview()} disabled={busy || !selectedFiles.length || !repository || !branch} variant="secondary" className="w-full">
            {busy ? <Loader2 className="animate-spin" size={15} /> : null} Compare with GitHub
          </Button>
          {preview && previewCurrent ? (
            <section className="space-y-2" aria-label="GitHub comparison">
              <p className="text-xs text-ink-2">Remote HEAD: <span className="font-mono">{preview.head.slice(0, 12)}</span>. Compare the remote and staged versions before approving. Deletions are not included.</p>
              {preview.files.map((file) => (
                <details key={file.path} className="rounded-lg border border-border p-2">
                  <summary className="cursor-pointer break-all text-xs font-medium text-ink">{file.path} · {file.status}</summary>
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    <div><p className="mb-1 text-xs text-ink-3">Remote</p><pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all rounded bg-surface-2 p-2 text-xs">{file.before === null ? "(new file)" : file.before}</pre></div>
                    <div><p className="mb-1 text-xs text-ink-3">Staged</p><pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all rounded bg-surface-2 p-2 text-xs">{file.after}</pre></div>
                  </div>
                </details>
              ))}
            </section>
          ) : preview ? <p className="text-xs text-warning">Files or target changed, or the review expired. Compare again.</p> : null}
          <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border p-3 text-xs leading-relaxed text-ink-2">
            <input type="checkbox" checked={reviewed && Boolean(previewCurrent)} disabled={!previewCurrent || busy} onChange={(event) => setReviewed(event.target.checked)} className="mt-0.5 accent-current" />
            <span>I reviewed the comparison for all {selectedFiles.length} selected file{selectedFiles.length === 1 ? "" : "s"} and approve this commit.</span>
          </label>
          <Button onClick={() => void push()} disabled={busy || !reviewed || !previewCurrent || !selectedFiles.length || !repository || !branch || !message.trim()} className="w-full">
            {busy ? <Loader2 className="animate-spin" size={15} /> : <GitPullRequestArrow size={15} />}
            Push to GitHub
          </Button>
          {!selectedFiles.length ? <p className="text-center text-xs text-ink-3">Select at least one text file to review.</p> : null}
          {onImport && preview && previewCurrent ? (
            <section className="space-y-2 rounded-lg border border-warning/30 p-3" aria-label="Import remote files">
              <p className="text-xs leading-relaxed text-ink-2">You can instead replace the selected changed workspace text files with the remote versions shown above. Remote-only files, deletions and merges are not included. Imported code is untrusted and may run in preview.</p>
              <label className="flex items-start gap-2 text-xs text-ink-2">
                <input type="checkbox" checked={importApproved} disabled={busy || importDisabled} onChange={(event) => setImportApproved(event.target.checked)} />
                <span>I reviewed the remote versions and approve replacing the corresponding workspace files.</span>
              </label>
              <Button variant="secondary" className="w-full" onClick={() => void importRemote()} disabled={busy || importDisabled || !importApproved || !preview.files.some((file) => file.before !== null && file.status === "changed")}>Import reviewed remote files</Button>
              {importDisabled ? <p className="text-xs text-warning">Save pending workspace changes or resolve the save error before importing.</p> : null}
            </section>
          ) : null}
        </div>
      ) : null}

      {showPush && selectedRepo ? <GithubPullRequestBrowser key={`browse:${selectedRepo.fullName}`} repository={repository} /> : null}
      {showPush && selectedRepo ? <GithubPullRequest key={selectedRepo.fullName} repository={repository} defaultBranch={selectedRepo.defaultBranch} sourceBranch={branch} /> : null}

      {notice ? (
        <div className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-xs text-ink-2">
          <span className="inline-flex items-center gap-1.5">{commitUrl ? <Check size={12} className="text-success" /> : null}{notice}</span>
          {commitUrl ? <a href={commitUrl} target="_blank" rel="noopener noreferrer" className="ml-2 inline-flex items-center gap-1 font-medium text-accent hover:underline"><Link2 size={11} /> View commit</a> : null}
        </div>
      ) : null}
      {dialogs.element}
    </div>
  );
}
