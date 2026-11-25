"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  Activity,
  CheckCircle2,
  Code2,
  Eye,
  FileCode2,
  FolderPlus,
  Play,
  RefreshCw,
  Save,
  ShieldAlert,
  Sparkles,
  Terminal as TerminalIcon,
} from "lucide-react";
import { Alert, Badge, Button, Card } from "@/components/ui";

interface WorkspaceProjectSummary {
  id: string;
  title: string;
  revision: number;
  file_count?: number;
  live_url?: string | null;
}

interface WorkspaceFile {
  path: string;
  content: string;
  encoding: "utf8" | "base64";
  language?: string;
}

interface TerminalEntry {
  id: string;
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  executionId?: string;
  pendingConfirm?: {
    action: "rm";
    targetPath: string;
    message: string;
  };
}

interface ProposedPatch {
  executionId: string;
  expectedRevision: number;
  reply: string;
  provider: string;
  model: string;
  latencyMs: number;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  proposedFiles: Array<{ path: string; content: string; language: string }>;
  diffs: Array<{
    path: string;
    changeType: "added" | "modified" | "unchanged";
    addedLines: number;
    removedLines: number;
    preview: string;
  }>;
}

export function AiCodingWorkspace() {
  const [projects, setProjects] = useState<WorkspaceProjectSummary[]>([]);
  const [activeProject, setActiveProject] = useState<WorkspaceProjectSummary | null>(null);
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [selectedPath, setSelectedPath] = useState<string>("");
  const [draftContent, setDraftContent] = useState<string>("");
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [rightPane, setRightPane] = useState<"preview" | "ai">("preview");

  // Terminal state
  const [commandInput, setCommandInput] = useState("");
  const [runningCmd, setRunningCmd] = useState(false);
  const [history, setHistory] = useState<TerminalEntry[]>([]);
  const termEndRef = useRef<HTMLDivElement | null>(null);

  // AI coding assistant state
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [proposedPatch, setProposedPatch] = useState<ProposedPatch | null>(null);

  const [banner, setBanner] = useState<{ tone: "info" | "success" | "warning" | "danger"; text: string } | null>(null);

  const loadWorkspace = useCallback(async (projectId?: string) => {
    setLoading(true);
    try {
      const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
      const res = await fetch(`/api/terminal${qs}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setProjects(data.projects ?? []);
      setActiveProject(data.activeProject ?? null);
      const nextFiles: WorkspaceFile[] = data.files ?? [];
      setFiles(nextFiles);
      if (nextFiles.length > 0) {
        const keep = nextFiles.find((f) => f.path === selectedPath) ?? nextFiles[0];
        setSelectedPath(keep.path);
        setDraftContent(keep.encoding === "base64" ? "(binary/base64 asset)" : keep.content);
        setDirty(false);
      } else {
        setSelectedPath("");
        setDraftContent("");
        setDirty(false);
      }
    } catch (err) {
      setBanner({
        tone: "danger",
        text: err instanceof Error ? err.message : "Failed to load coding workspace.",
      });
    } finally {
      setLoading(false);
    }
  }, [selectedPath]);

  useEffect(() => {
    void loadWorkspace();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    termEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [history]);

  const selectFile = (file: WorkspaceFile) => {
    setSelectedPath(file.path);
    setDraftContent(file.encoding === "base64" ? "(binary/base64 asset)" : file.content);
    setDirty(false);
  };

  const createProject = async () => {
    setSaving(true);
    setBanner(null);
    try {
      const res = await fetch("/api/terminal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "init_project", title: "QORVYNA AI Workspace" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to create workspace project");
      await loadWorkspace(data.activeProject?.id);
      setBanner({ tone: "success", text: "Initialized new governed coding workspace project." });
    } catch (err) {
      setBanner({ tone: "danger", text: err instanceof Error ? err.message : "Project init failed" });
    } finally {
      setSaving(false);
    }
  };

  const saveCurrentFile = async () => {
    if (!activeProject || !selectedPath) return;
    setSaving(true);
    setBanner(null);
    try {
      const res = await fetch("/api/terminal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save_file",
          projectId: activeProject.id,
          path: selectedPath,
          content: draftContent,
          expectedRevision: activeProject.revision,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Save failed");
      setActiveProject((prev) => (prev ? { ...prev, revision: data.revision } : prev));
      setFiles((prev) => prev.map((f) => (f.path === selectedPath ? { ...f, content: draftContent } : f)));
      setDirty(false);
      setBanner({ tone: "success", text: `Saved ${selectedPath} (revision ${data.revision}).` });
    } catch (err) {
      setBanner({ tone: "danger", text: err instanceof Error ? err.message : "Save failed" });
    } finally {
      setSaving(false);
    }
  };

  const runTerminalCommand = async (rawCmd: string, confirmDestructive = false) => {
    if (!activeProject || !rawCmd.trim()) return;
    setRunningCmd(true);
    try {
      const res = await fetch("/api/terminal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "exec",
          projectId: activeProject.id,
          command: rawCmd.trim(),
          confirmDestructive,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      const r = data.result;
      setHistory((prev) => [
        ...prev,
        {
          id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          command: rawCmd.trim(),
          stdout: r.stdout ?? "",
          stderr: r.stderr ?? "",
          exitCode: r.exitCode ?? 0,
          durationMs: r.durationMs ?? 1,
          executionId: data.executionId,
          pendingConfirm: r.requiresConfirmation,
        },
      ]);
      if (data.activeProject) setActiveProject(data.activeProject);
      if (Array.isArray(data.files)) {
        setFiles(data.files);
        const updated = data.files.find((f: WorkspaceFile) => f.path === selectedPath) ?? data.files[0];
        if (updated && !dirty) {
          setSelectedPath(updated.path);
          setDraftContent(updated.encoding === "base64" ? "(binary/base64 asset)" : updated.content);
        }
      }
      if (!confirmDestructive) setCommandInput("");
    } catch (err) {
      setHistory((prev) => [
        ...prev,
        {
          id: `${Date.now()}_err`,
          command: rawCmd.trim(),
          stdout: "",
          stderr: err instanceof Error ? err.message : "Execution error",
          exitCode: 1,
          durationMs: 1,
        },
      ]);
    } finally {
      setRunningCmd(false);
    }
  };

  const proposeAiPatch = async () => {
    if (!activeProject || !aiPrompt.trim()) return;
    setAiBusy(true);
    setBanner(null);
    setProposedPatch(null);
    try {
      const res = await fetch("/api/terminal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "ai_propose",
          projectId: activeProject.id,
          instruction: aiPrompt.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message ?? data.error ?? "AI patch proposal failed");
      setProposedPatch(data);
    } catch (err) {
      setBanner({ tone: "danger", text: err instanceof Error ? err.message : "AI request failed" });
    } finally {
      setAiBusy(false);
    }
  };

  const applyProposedPatch = async () => {
    if (!activeProject || !proposedPatch || proposedPatch.proposedFiles.length === 0) return;
    setAiBusy(true);
    setBanner(null);
    try {
      const res = await fetch("/api/terminal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "ai_apply",
          projectId: activeProject.id,
          expectedRevision: activeProject.revision,
          files: proposedPatch.proposedFiles.map((f) => ({ path: f.path, content: f.content })),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to apply patch");
      setActiveProject(data.activeProject);
      setFiles(data.files ?? []);
      const firstChanged = proposedPatch.proposedFiles[0];
      if (firstChanged) {
        setSelectedPath(firstChanged.path);
        setDraftContent(firstChanged.content);
        setDirty(false);
      }
      setProposedPatch(null);
      setAiPrompt("");
      setBanner({
        tone: "success",
        text: `Applied ${proposedPatch.proposedFiles.length} file(s) at revision ${data.activeProject?.revision}.`,
      });
    } catch (err) {
      setBanner({ tone: "danger", text: err instanceof Error ? err.message : "Apply failed" });
    } finally {
      setAiBusy(false);
    }
  };

  const previewSrcDoc = useMemo(() => {
    const working = files.map((f) =>
      f.path === selectedPath && f.encoding !== "base64" ? { ...f, content: draftContent } : f,
    );
    const entry = working.find((f) => /(^|\/)index\.html?$/i.test(f.path));
    if (!entry) {
      return `<!DOCTYPE html><html><body style="font-family:system-ui;padding:2rem;color:#94a3b8;background:#090d16">No index.html in current project. Create index.html or run <code>touch index.html</code> in qsh.</body></html>`;
    }
    let html = entry.content;
    for (const css of working.filter((f) => /\.css$/i.test(f.path))) {
      const escaped = css.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const linkRe = new RegExp(`<link[^>]+href=["'](?:\\./)?${escaped}["'][^>]*>`, "gi");
      html = html.replace(linkRe, `<style data-path="${css.path}">\n${css.content}\n</style>`);
    }
    for (const js of working.filter((f) => /\.m?js$/i.test(f.path))) {
      const escaped = js.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const scriptRe = new RegExp(`<script[^>]+src=["'](?:\\./)?${escaped}["'][^>]*>\\s*</script>`, "gi");
      html = html.replace(scriptRe, `<script data-path="${js.path}">\n${js.content}\n</script>`);
    }
    return html;
  }, [files, selectedPath, draftContent]);

  return (
    <div className="mx-auto max-w-7xl space-y-5 p-4 md:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <TerminalIcon className="h-5 w-5 text-emerald-400" />
            <h1 className="text-xl font-semibold tracking-tight">
              AI Terminal &amp; Coding Workspace
            </h1>
            <Badge tone="neutral">qsh Governed Sandbox</Badge>
          </div>
          <p className="mt-1 text-xs text-[var(--fg-muted)]">
            Isolated project shell, CAS-guarded multi-file editor, live preview, and diff-reviewed AI code generation instrumented with AgentOps.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {projects.length > 0 && (
            <select
              aria-label="Select workspace project"
              value={activeProject?.id ?? ""}
              onChange={(e) => void loadWorkspace(e.target.value)}
              className="rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-1.5 text-xs"
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title} (rev {p.revision})
                </option>
              ))}
            </select>
          )}
          <Button variant="secondary" onClick={() => void createProject()} disabled={saving}>
            <FolderPlus className="mr-1.5 h-3.5 w-3.5" />
            New Project
          </Button>
          <Link
            href="/agentops"
            className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-1.5 text-xs font-medium hover:bg-[var(--bg-subtle)]"
          >
            <Activity className="h-3.5 w-3.5 text-sky-400" />
            AgentOps Traces
          </Link>
        </div>
      </div>

      {banner && <Alert tone={banner.tone}>{banner.text}</Alert>}

      {!loading && !activeProject ? (
        <Card className="p-8 text-center">
          <Code2 className="mx-auto h-8 w-8 text-[var(--fg-muted)]" />
          <h2 className="mt-3 text-base font-semibold">No workspace project yet</h2>
          <p className="mt-1 text-xs text-[var(--fg-muted)]">
            Initialize a governed project to edit files, run isolated qsh commands, and review AI patches.
          </p>
          <div className="mt-4">
            <Button onClick={() => void createProject()} disabled={saving}>
              Initialize Starter Workspace
            </Button>
          </div>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
            {/* File Explorer */}
            <Card className="p-3 lg:col-span-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wider text-[var(--fg-muted)]">
                  Files ({files.length})
                </span>
                <button
                  type="button"
                  onClick={() => void loadWorkspace(activeProject?.id)}
                  className="rounded p-1 text-[var(--fg-muted)] hover:bg-[var(--bg-subtle)]"
                  title="Reload project files"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="space-y-1">
                {files.map((file) => (
                  <button
                    key={file.path}
                    type="button"
                    onClick={() => selectFile(file)}
                    className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs transition ${
                      selectedPath === file.path
                        ? "bg-sky-500/15 font-medium text-sky-300"
                        : "text-[var(--fg-default)] hover:bg-[var(--bg-subtle)]"
                    }`}
                  >
                    <FileCode2 className="h-3.5 w-3.5 shrink-0 opacity-75" />
                    <span className="truncate">{file.path}</span>
                  </button>
                ))}
              </div>
            </Card>

            {/* Code Editor */}
            <Card className="flex flex-col p-3 lg:col-span-5">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 truncate text-xs font-mono">
                  <span className="truncate font-semibold">{selectedPath || "No file selected"}</span>
                  {dirty && <Badge tone="warning">unsaved</Badge>}
                </div>
                <div className="flex items-center gap-1.5">
                  <Button
                    variant="secondary"
                    onClick={() => void runTerminalCommand("validate")}
                    disabled={!activeProject || runningCmd}
                  >
                    <CheckCircle2 className="mr-1 h-3.5 w-3.5" />
                    Validate
                  </Button>
                  <Button
                    onClick={() => void saveCurrentFile()}
                    disabled={!dirty || saving || !selectedPath}
                  >
                    <Save className="mr-1 h-3.5 w-3.5" />
                    Save
                  </Button>
                </div>
              </div>
              <textarea
                aria-label="Project source editor"
                value={draftContent}
                onChange={(e) => {
                  setDraftContent(e.target.value);
                  setDirty(true);
                }}
                spellCheck={false}
                className="min-h-[340px] flex-1 resize-y rounded-lg border border-[var(--border)] bg-[#090d16] p-3 font-mono text-xs leading-relaxed text-slate-100 focus:outline-none focus:ring-1 focus:ring-sky-500"
              />
            </Card>

            {/* Live Preview + AI Patch Reviewer */}
            <Card className="flex flex-col p-3 lg:col-span-4">
              <div className="mb-2 flex items-center justify-between">
                <div className="flex gap-1">
                  <button
                    type="button"
                    onClick={() => setRightPane("preview")}
                    className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium ${
                      rightPane === "preview"
                        ? "bg-sky-500/15 text-sky-300"
                        : "text-[var(--fg-muted)] hover:bg-[var(--bg-subtle)]"
                    }`}
                  >
                    <Eye className="h-3.5 w-3.5" />
                    Preview
                  </button>
                  <button
                    type="button"
                    onClick={() => setRightPane("ai")}
                    className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium ${
                      rightPane === "ai"
                        ? "bg-violet-500/15 text-violet-300"
                        : "text-[var(--fg-muted)] hover:bg-[var(--bg-subtle)]"
                    }`}
                  >
                    <Sparkles className="h-3.5 w-3.5" />
                    AI Patch Studio
                  </button>
                </div>
                {activeProject && (
                  <span className="font-mono text-[11px] text-[var(--fg-muted)]">
                    rev #{activeProject.revision}
                  </span>
                )}
              </div>

              {rightPane === "preview" ? (
                <iframe
                  title="Workspace sandboxed preview"
                  sandbox="allow-scripts"
                  srcDoc={previewSrcDoc}
                  className="min-h-[340px] w-full flex-1 rounded-lg border border-[var(--border)] bg-white"
                />
              ) : (
                <div className="flex min-h-[340px] flex-1 flex-col gap-3 overflow-y-auto">
                  <textarea
                    rows={3}
                    value={aiPrompt}
                    onChange={(e) => setAiPrompt(e.target.value)}
                    placeholder="Describe code changes across your project (diff-reviewed before write)..."
                    className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg-subtle)] p-2.5 text-xs"
                  />
                  <Button onClick={() => void proposeAiPatch()} disabled={aiBusy || !aiPrompt.trim()}>
                    <Sparkles className="mr-1.5 h-3.5 w-3.5" />
                    {aiBusy ? "Generating Diff Proposal..." : "Propose Multi-File Patch"}
                  </Button>

                  {proposedPatch && (
                    <div className="space-y-2 rounded-lg border border-[var(--border)] bg-[var(--bg-subtle)] p-3 text-xs">
                      <div className="flex flex-wrap items-center justify-between gap-1">
                        <Badge tone="accent">
                          {proposedPatch.provider} · {proposedPatch.latencyMs}ms
                        </Badge>
                        <span className="font-mono text-[11px] text-[var(--fg-muted)]">
                          {proposedPatch.usage.totalTokens} tokens
                        </span>
                      </div>
                      {proposedPatch.reply && (
                        <p className="text-[var(--fg-muted)]">{proposedPatch.reply}</p>
                      )}
                      {proposedPatch.diffs.map((d) => (
                        <div key={d.path} className="space-y-1">
                          <div className="flex items-center justify-between font-mono text-[11px]">
                            <span>{d.path}</span>
                            <span className="text-emerald-400">
                              +{d.addedLines} / -{d.removedLines}
                            </span>
                          </div>
                          <pre className="max-h-36 overflow-auto rounded bg-[#090d16] p-2 font-mono text-[10px] text-slate-200">
                            {d.preview}
                          </pre>
                        </div>
                      ))}
                      {proposedPatch.proposedFiles.length > 0 && (
                        <div className="flex gap-2 pt-1">
                          <Button onClick={() => void applyProposedPatch()} disabled={aiBusy}>
                            Apply Reviewed Patch
                          </Button>
                          <Button
                            variant="secondary"
                            onClick={() => setProposedPatch(null)}
                            disabled={aiBusy}
                          >
                            Discard
                          </Button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </Card>
          </div>

          {/* Governed Workspace Terminal (qsh) */}
          <Card className="p-4">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <TerminalIcon className="h-4 w-4 text-emerald-400" />
                <span className="font-mono text-xs font-semibold">
                  qsh — Governed Workspace Terminal
                </span>
                <span className="text-[11px] text-[var(--fg-muted)]">
                  (try <code>help</code>, <code>ls</code>, <code>validate</code>, <code>grep h1</code>, or <code>js Object.keys(PROJECT_FILES)</code>)
                </span>
              </div>
              {history.length > 0 && (
                <button
                  type="button"
                  onClick={() => setHistory([])}
                  className="text-xs text-[var(--fg-muted)] hover:underline"
                >
                  Clear output
                </button>
              )}
            </div>

            <div className="max-h-64 overflow-y-auto rounded-lg border border-[var(--border)] bg-[#060911] p-3 font-mono text-xs text-slate-200">
              {history.length === 0 ? (
                <div className="text-slate-500">
                  QORVYNA Governed Workspace Shell ready. Host OS binaries &amp; secret env vars are isolated; all executions emit AgentOps spans.
                </div>
              ) : (
                <div className="space-y-3">
                  {history.map((entry) => (
                    <div key={entry.id} className="space-y-1">
                      <div className="flex items-center justify-between text-emerald-400">
                        <span>$ {entry.command}</span>
                        <span className="text-[10px] text-slate-500">
                          exit {entry.exitCode} · {entry.durationMs}ms
                        </span>
                      </div>
                      {entry.stdout && (
                        <pre className="whitespace-pre-wrap text-slate-200">{entry.stdout}</pre>
                      )}
                      {entry.stderr && (
                        <pre className="whitespace-pre-wrap text-rose-400">{entry.stderr}</pre>
                      )}
                      {entry.pendingConfirm && (
                        <div className="mt-1 flex items-center gap-2 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-amber-200">
                          <ShieldAlert className="h-4 w-4 shrink-0" />
                          <span>{entry.pendingConfirm.message}</span>
                          <Button
                            variant="danger"
                            onClick={() => void runTerminalCommand(entry.command, true)}
                            disabled={runningCmd}
                          >
                            Approve Delete
                          </Button>
                        </div>
                      )}
                    </div>
                  ))}
                  <div ref={termEndRef} />
                </div>
              )}
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                void runTerminalCommand(commandInput);
              }}
              className="mt-2.5 flex gap-2"
            >
              <input
                type="text"
                aria-label="qsh terminal command input"
                value={commandInput}
                onChange={(e) => setCommandInput(e.target.value)}
                placeholder="qsh> ls | cat index.html | validate | js 2 + 2"
                className="flex-1 rounded-lg border border-[var(--border)] bg-[#090d16] px-3 py-2 font-mono text-xs text-slate-100 focus:outline-none focus:ring-1 focus:ring-emerald-500"
              />
              <Button type="submit" disabled={runningCmd || !commandInput.trim() || !activeProject}>
                <Play className="mr-1 h-3.5 w-3.5" />
                Run
              </Button>
            </form>
          </Card>
        </>
      )}
    </div>
  );
}
