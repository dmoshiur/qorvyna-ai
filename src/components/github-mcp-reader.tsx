"use client";
import { useState } from "react";
import { useDialogs } from "@/components/dialogs";
import { rpc } from "@/lib/client/api";
import { Button, Input } from "@/components/ui";

type Result = { ok: boolean; error?: string; data?: { text?: string; truncated?: boolean } };
export function GithubMcpReader() {
  const dialogs = useDialogs();
  const [owner, setOwner] = useState(""); const [repo, setRepo] = useState("");
  const [path, setPath] = useState(""); const [ref, setRef] = useState("");
  const [busy, setBusy] = useState(false); const [result, setResult] = useState<Result | null>(null);
  async function read() {
    const args = { owner: owner.trim(), repo: repo.trim(), path: path.trim(), ...(ref.trim() ? { ref: ref.trim() } : {}) };
    if (!args.owner || !args.repo || !args.path) return;
    const confirm = await dialogs.confirm({ title: "Read this GitHub file?", body: `Send ${args.owner}/${args.repo}/${args.path} to GitHub's MCP server using your connected account. The result is untrusted and is not sent to an AI model.`, confirmLabel: "Approve file read", tone: "primary" });
    if (!confirm) return;
    setBusy(true); setResult(null);
    try {
      const approval = await rpc<{ id: string }>("tool_approval_request", { tool_id: "mcp.github.read_file", args });
      await rpc("tool_approval_decide", { approval_id: approval.id, approve: true });
      const output = await rpc<Result>("tool_execute", { tool_id: "mcp.github.read_file", args, approval_id: approval.id });
      setResult(output);
    } catch { setResult({ ok: false, error: "Could not complete the approved request. Check your connection and try again." }); }
    finally { setBusy(false); }
  }
  return <section className="mt-4 space-y-2 rounded-lg border border-border p-3" aria-label="GitHub MCP file reader">
    <p className="text-sm font-semibold text-ink">GitHub MCP file reader</p>
    <p className="text-xs text-ink-2">Uses your connected GitHub account and the official remote MCP server. Minors need approved guardian consent. Each read needs approval. External content is untrusted.</p>
    <label className="block text-xs text-ink-2">Owner<Input value={owner} disabled={busy} maxLength={100} onChange={(e) => setOwner(e.target.value)} /></label>
    <label className="block text-xs text-ink-2">Repository<Input value={repo} disabled={busy} maxLength={100} onChange={(e) => setRepo(e.target.value)} /></label>
    <label className="block text-xs text-ink-2">File path<Input value={path} disabled={busy} maxLength={180} onChange={(e) => setPath(e.target.value)} /></label>
    <label className="block text-xs text-ink-2">Ref (optional)<Input value={ref} disabled={busy} maxLength={200} onChange={(e) => setRef(e.target.value)} /></label>
    <Button onClick={() => void read()} disabled={busy || !owner.trim() || !repo.trim() || !path.trim()}>{busy ? "Reading…" : "Review and read file"}</Button>
    {result ? result.ok ? <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-surface-2 p-2 text-xs">{result.data?.text}{result.data?.truncated ? "\n…output truncated" : ""}</pre> : <p role="status" className="text-xs text-warning">{result.error}</p> : null}
    {dialogs.element}
  </section>;
}
