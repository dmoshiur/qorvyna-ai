"use client";

// "Import from GitHub repo" dialog. Shared by the Workspace → Projects page and
// the terminal coding workspace. It runs the governed server-side clone via the
// `project_import_repo` RPC; the GitHub token (private repos only) stays on the
// server and is never sent to the client.

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Github, Loader2, X } from "lucide-react";
import { rpc, RpcCallError } from "@/lib/client/api";
import { GithubConnection } from "@/components/github-connection";

type ImportResult = {
  projectId: string;
  title: string;
  fileCount: number;
  bytes: number;
  elapsedMs: number;
  repo: { owner: string; name: string; htmlUrl: string };
  private: boolean;
};

export function RepoImportDialog({
  open,
  onClose,
  onImported,
  defaultTitle = "",
}: {
  open: boolean;
  onClose: () => void;
  onImported?: (projectId: string) => void;
  defaultTitle?: string;
}) {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState(defaultTitle);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  if (!open) return null;

  const close = () => {
    if (busy) return;
    setError(null);
    setResult(null);
    setUrl("");
    setTitle(defaultTitle);
    onClose();
  };

  const submit = async () => {
    const repoUrl = url.trim();
    if (!repoUrl) {
      setError({ code: "REPO_URL_INVALID", message: "Enter a GitHub repository URL to import." });
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const data = await rpc<ImportResult>("project_import_repo", {
        repo_url: repoUrl,
        ...(title.trim() ? { title: title.trim() } : {}),
      });
      setResult(data);
      onImported?.(data.projectId);
    } catch (err) {
      const code = err instanceof RpcCallError ? err.code : "REPO_IMPORT_FAILED";
      const message = err instanceof RpcCallError ? (err.detail ?? err.code) : "The repository could not be imported. Try again.";
      setError({ code, message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Import a GitHub repository">
      <button type="button" className="absolute inset-0 bg-black/55 backdrop-blur-sm" onClick={close} aria-label="Close" tabIndex={-1} />
      <div className="fade-in relative w-full max-w-md overflow-hidden rounded-2xl border border-border bg-surface shadow-[var(--shadow-pop)]">
        <div className="flex items-start gap-3 border-b border-border px-4 py-3.5">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-accent/40 bg-accent-soft text-accent" aria-hidden="true">
            <Github size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[15px] font-semibold text-ink">Import from GitHub repo</h2>
            <p className="mt-0.5 text-[12px] text-ink-2">
              Public repositories import with no connection. Private repositories use your connected GitHub account.
            </p>
          </div>
          <button type="button" onClick={close} disabled={busy} className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-ink-3 hover:bg-surface-2 hover:text-ink" aria-label="Close">
            <X size={15} />
          </button>
        </div>

        <div className="space-y-3 px-4 py-3.5">
          {result ? (
            <div className="space-y-3">
              <p className="rounded-lg border border-success/40 bg-success-soft px-3 py-2 text-[13px] leading-relaxed text-ink">
                Imported <span className="font-semibold">{result.fileCount}</span> file{result.fileCount === 1 ? "" : "s"} from{" "}
                <span className="font-mono">{result.repo.owner}/{result.repo.name}</span> into project{" "}
                <span className="font-semibold">{result.title}</span>.
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => { close(); router.push(`/projects/${result.projectId}`); }}
                  className="inline-flex min-h-9 items-center rounded-lg bg-accent-solid px-3 text-[12.5px] font-semibold text-accent-ink hover:bg-accent-solid-hover"
                >
                  Open project
                </button>
                <button type="button" onClick={close} className="inline-flex min-h-9 items-center rounded-lg border border-border px-3 text-[12.5px] font-medium text-ink-2 hover:text-ink">
                  Close
                </button>
              </div>
            </div>
          ) : (
            <>
              <label className="block">
                <span className="eyebrow text-ink-3">Repository URL</span>
                <input
                  type="url"
                  value={url}
                  onChange={(e) => { setUrl(e.target.value); if (error) setError(null); }}
                  placeholder="https://github.com/owner/repo"
                  disabled={busy}
                  autoFocus
                  className="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-2 text-[13px] text-ink outline-none focus:border-accent"
                />
              </label>
              <label className="block">
                <span className="eyebrow text-ink-3">Project name (optional)</span>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Defaults to the repository name"
                  disabled={busy}
                  className="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-2 text-[13px] text-ink outline-none focus:border-accent"
                />
              </label>

              {error ? (
                error.code === "GITHUB_NOT_CONNECTED" ? (
                  <div className="space-y-3">
                    <p className="rounded-lg border border-warning/40 bg-warning-soft px-3 py-2 text-[12.5px] leading-relaxed text-ink">
                      {error.message}
                    </p>
                    <GithubConnection showPush />
                  </div>
                ) : (
                  <p className="rounded-lg border border-danger/40 bg-danger-soft px-3 py-2 text-[12.5px] leading-relaxed text-danger" role="alert">
                    {error.message}
                  </p>
                )
              ) : null}

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void submit()}
                  disabled={busy}
                  className="inline-flex min-h-9 items-center gap-2 rounded-lg bg-accent-solid px-3 text-[12.5px] font-semibold text-accent-ink hover:bg-accent-solid-hover disabled:opacity-50"
                >
                  {busy ? <Loader2 size={13} className="animate-spin" /> : <Github size={13} />}
                  {busy ? "Importing…" : "Import repository"}
                </button>
                <button type="button" onClick={close} disabled={busy} className="inline-flex min-h-9 items-center rounded-lg border border-border px-3 text-[12.5px] font-medium text-ink-2 hover:text-ink">
                  Cancel
                </button>
              </div>
              <p className="text-[11px] text-ink-3">
                Repositories over 100 MB or 2,000 files are refused. Temporary clone files are deleted after import.{" "}
                <Link href="/projects" className="text-accent hover:underline">Projects</Link>
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
