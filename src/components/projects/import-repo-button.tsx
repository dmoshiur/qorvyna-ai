"use client";

// Small client island that opens the governed "Import from GitHub repo" dialog.
// Used on the Workspace → Projects page and next to "New Project" in the
// terminal coding workspace.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { DownloadCloud } from "lucide-react";
import { RepoImportDialog } from "@/components/projects/repo-import-dialog";

export function ImportRepoButton({ className = "" }: { className?: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-border bg-surface px-4 text-sm font-medium text-ink hover:bg-surface-2 ${className}`}
      >
        <DownloadCloud size={15} aria-hidden="true" />
        Import from GitHub repo
      </button>
      <RepoImportDialog
        open={open}
        onClose={() => setOpen(false)}
        onImported={(projectId) => { setOpen(false); router.push(`/projects/${projectId}`); }}
      />
    </>
  );
}
