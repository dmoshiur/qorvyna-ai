// =============================================================================
// QORVYNA AI — Governed Workspace Terminal (qsh) & Unified Diff Engine.
//
// Security invariants:
//   1. Never spawns host OS processes (/bin/sh, child_process) and never reads
//      host filesystem paths or process.env secrets.
//   2. Rejects shell-chaining / redirection metacharacters (; && || | ` $() > <)
//      explicitly instead of pretending to run shell pipelines.
//   3. Executes only allowlisted project operations against the caller's owned
//      QORVYNA project adapter, plus time-bounded pure-JS evaluation inside a
//      locked-down node:vm compartment (codeGeneration disabled, 350ms timeout).
//   4. Never fabricates output for unsupported external tools (npm, git, curl,
//      apt, python): returns exitCode 126 with an explicit sandbox explanation.
//   5. Scrubs all output via AgentOps secret scrubber before returning.
// =============================================================================

import crypto from "node:crypto";
import vm from "node:vm";
import { assertSafeProjectPath, type ProjectFile } from "@/lib/projects/paths";
import { languageForPath } from "@/lib/ai/agent";
import { validateProject } from "@/lib/deploy/validate";
import { scrubSecrets } from "@/lib/agentops/governance";

export interface TerminalProjectState {
  projectId: string;
  title: string;
  revision: number;
  uid: string;
  files: ProjectFile[];
}

export interface TerminalProjectAdapter {
  getState(): Promise<TerminalProjectState>;
  upsertFile(path: string, content: string, expectedRevision: number): Promise<{ revision: number }>;
  renameFile(from: string, to: string, expectedRevision: number): Promise<void>;
  deleteFile(path: string, expectedRevision: number): Promise<void>;
}

export interface TerminalCommandResult {
  command: string;
  program: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  mutatedProject: boolean;
  requiresConfirmation?: {
    action: "rm";
    targetPath: string;
    message: string;
  };
}

const SHELL_METACHAR_RE = /[;|`<>]|\$\(|\|\||&&/;
const MAX_OUTPUT_CHARS = 16_000;

function capOutput(text: string): string {
  const scrubbed = scrubSecrets(text);
  if (scrubbed.length <= MAX_OUTPUT_CHARS) return scrubbed;
  return `${scrubbed.slice(0, MAX_OUTPUT_CHARS)}\n… [output truncated at ${MAX_OUTPUT_CHARS} chars]`;
}

/** Safe quote-aware tokenizer that blocks unquoted shell injection operators. */
export function tokenizeWorkspaceCommand(line: string): { ok: true; tokens: string[] } | { ok: false; error: string } {
  const trimmed = line.trim();
  if (!trimmed) return { ok: true, tokens: [] };

  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    const rest = trimmed.slice(i, i + 2);
    if (SHELL_METACHAR_RE.test(rest) || SHELL_METACHAR_RE.test(ch)) {
      return {
        ok: false,
        error: "SHELL_METACHAR_BLOCKED: Chaining, pipes, subshells, and redirections are blocked in governed workspace mode.",
      };
    }
    current += ch;
  }

  if (quote) {
    return { ok: false, error: "UNCLOSED_QUOTE: Command contains an unclosed string quote." };
  }
  if (current.length > 0) tokens.push(current);
  return { ok: true, tokens };
}

function runIsolatedJs(code: string, files: ProjectFile[]): { exitCode: number; stdout: string; stderr: string } {
  const logs: string[] = [];
  const errs: string[] = [];
  const pushLine = (bucket: string[], args: unknown[]) => {
    const formatted = args
      .map((a) => {
        if (typeof a === "string") return a;
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      })
      .join(" ");
    bucket.push(formatted);
  };

  const fileSnapshot = Object.create(null) as Record<string, string>;
  for (const f of files) {
    if (f.encoding !== "base64") {
      fileSnapshot[f.path] = f.content;
    }
  }
  Object.freeze(fileSnapshot);

  const sandboxConsole = Object.freeze({
    log: (...args: unknown[]) => pushLine(logs, args),
    info: (...args: unknown[]) => pushLine(logs, args),
    warn: (...args: unknown[]) => pushLine(errs, args),
    error: (...args: unknown[]) => pushLine(errs, args),
  });

  const context = vm.createContext(
    {
      console: sandboxConsole,
      PROJECT_FILES: fileSnapshot,
      Math,
      JSON,
      Date,
      Array,
      Object,
      String,
      Number,
      Boolean,
      RegExp,
      Map,
      Set,
       encodeURIComponent,
      decodeURIComponent,
    },
    {
      name: "qorvyna-workspace-vm",
      codeGeneration: { strings: false, wasm: false },
    },
  );

  try {
    const script = new vm.Script(code, { filename: "workspace-eval.js" });
    const result = script.runInContext(context, { timeout: 350 });
    if (result !== undefined) {
      pushLine(logs, [result]);
    }
    return { exitCode: 0, stdout: logs.join("\n"), stderr: errs.join("\n") };
  } catch (err) {
    errs.push(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    return { exitCode: 1, stdout: logs.join("\n"), stderr: errs.join("\n") };
  }
}

export async function executeWorkspaceCommand(
  rawLine: string,
  adapter: TerminalProjectAdapter,
  options: { confirmDestructive?: boolean } = {},
): Promise<TerminalCommandResult> {
  const started = Date.now();
  const parsed = tokenizeWorkspaceCommand(rawLine);
  if (!parsed.ok) {
    return {
      command: rawLine,
      program: "qsh",
      exitCode: 2,
      stdout: "",
      stderr: capOutput(parsed.error),
      durationMs: Math.max(1, Date.now() - started),
      mutatedProject: false,
    };
  }

  const [program = "", ...args] = parsed.tokens;
  if (!program) {
    return {
      command: rawLine,
      program: "",
      exitCode: 0,
      stdout: "",
      stderr: "",
      durationMs: Math.max(1, Date.now() - started),
      mutatedProject: false,
    };
  }

  const finish = (
    exitCode: number,
    stdout: string,
    stderr = "",
    mutatedProject = false,
    requiresConfirmation?: TerminalCommandResult["requiresConfirmation"],
  ): TerminalCommandResult => ({
    command: rawLine,
    program,
    exitCode,
    stdout: capOutput(stdout),
    stderr: capOutput(stderr),
    durationMs: Math.max(1, Date.now() - started),
    mutatedProject,
    requiresConfirmation,
  });

  try {
    const state = await adapter.getState();
    const byPath = new Map(state.files.map((f) => [f.path, f]));

    switch (program) {
      case "help":
        return finish(
          0,
          [
            "QORVYNA Governed Workspace Shell (qsh) — real project & VM operations:",
            "  help                     Show allowlisted workspace commands",
            "  pwd | env | whoami       Inspect isolated workspace metadata",
            "  ls [prefix]              List project files with byte sizes & SHA-256",
            "  cat <path>               Print utf8 project file contents",
            "  head [-n N] <path>       Print first N lines of a project file (default 20)",
            "  stat <path>              Show bytes, lines, language, encoding & SHA-256",
            "  grep <pattern> [prefix]  Search across project text files",
            "  validate | check         Run QORVYNA static build/syntax/asset/route validator",
            "  js <expr>                Evaluate pure JS in 350ms isolated VM (reads PROJECT_FILES)",
            "  run <path.js>            Run a project .js/.mjs file inside the isolated VM",
            "  touch <path>             Create an empty file if it does not exist",
            "  write <path> <text...>   Write utf8 text to a project file (CAS revision guarded)",
            "  mv <from> <to>           Rename/move a project file",
            "  rm <path>                Delete a project file (requires explicit confirmation)",
          ].join("\n"),
        );

      case "pwd":
        return finish(0, `/workspace/projects/${state.projectId}`);

      case "whoami":
        return finish(0, `user:${state.uid.slice(0, 12)} (isolated-tenant)`);

      case "env":
        return finish(
          0,
          [
            `QORVYNA_PROJECT_ID=${state.projectId}`,
            `QORVYNA_PROJECT_TITLE=${state.title}`,
            `QORVYNA_PROJECT_REVISION=${state.revision}`,
            `QORVYNA_SANDBOX_RUNTIME=qsh-vm-isolated`,
            `QORVYNA_HOST_ENV_EXPOSED=false`,
          ].join("\n"),
        );

      case "ls": {
        const prefix = args[0] ? args[0].replace(/^\.\//, "").replace(/\/+$/, "") : "";
        const matching = state.files.filter((f) => !prefix || f.path === prefix || f.path.startsWith(`${prefix}/`));
        if (matching.length === 0) {
          return finish(0, prefix ? `(no files matching ${prefix})` : "(empty project)");
        }
        const rows = matching.map((f) => {
          const enc = f.encoding ?? "utf8";
          const bytes = enc === "base64" ? Math.floor(f.content.length * 0.75) : Buffer.byteLength(f.content, "utf8");
          const sha = crypto.createHash("sha256").update(f.content).digest("hex").slice(0, 10);
          return `${String(bytes).padStart(7, " ")}B  ${enc.padEnd(6, " ")}  ${sha}  ${f.path}`;
        });
        return finish(0, rows.join("\n"));
      }

      case "cat": {
        const target = args[0];
        if (!target) return finish(1, "", "Usage: cat <path>");
        const safe = assertSafeProjectPath(target);
        const file = byPath.get(safe);
        if (!file) return finish(1, "", `cat: ${safe}: No such project file`);
        if (file.encoding === "base64") return finish(1, "", `cat: ${safe}: Binary/base64 file omitted`);
        return finish(0, file.content);
      }

      case "head": {
        let count = 20;
        let pathArg = args[0];
        if (args[0] === "-n" && args[1]) {
          count = Math.max(1, Math.min(200, Number(args[1]) || 20));
          pathArg = args[2];
        }
        if (!pathArg) return finish(1, "", "Usage: head [-n lines] <path>");
        const safe = assertSafeProjectPath(pathArg);
        const file = byPath.get(safe);
        if (!file) return finish(1, "", `head: ${safe}: No such project file`);
        if (file.encoding === "base64") return finish(1, "", `head: ${safe}: Binary/base64 file omitted`);
        return finish(0, file.content.split("\n").slice(0, count).join("\n"));
      }

      case "stat": {
        const target = args[0];
        if (!target) return finish(1, "", "Usage: stat <path>");
        const safe = assertSafeProjectPath(target);
        const file = byPath.get(safe);
        if (!file) return finish(1, "", `stat: ${safe}: No such project file`);
        const bytes = file.encoding === "base64" ? Math.floor(file.content.length * 0.75) : Buffer.byteLength(file.content, "utf8");
        const lines = file.encoding === "base64" ? 0 : file.content.split("\n").length;
        const sha = crypto.createHash("sha256").update(file.content).digest("hex");
        return finish(
          0,
          [
            `Path:     ${file.path}`,
            `Language: ${languageForPath(file.path)}`,
            `Encoding: ${file.encoding}`,
            `Bytes:    ${bytes}`,
            `Lines:    ${lines}`,
            `SHA-256:  ${sha}`,
          ].join("\n"),
        );
      }

      case "grep": {
        const pattern = args[0];
        const prefix = args[1] ?? "";
        if (!pattern) return finish(1, "", "Usage: grep <pattern> [pathPrefix]");
        if (pattern.length > 160) return finish(1, "", "grep: pattern too long (max 160 chars)");
        const hits: string[] = [];
        const needle = pattern.toLowerCase();
        for (const file of state.files) {
          if (file.encoding === "base64") continue;
          if (prefix && !file.path.startsWith(prefix)) continue;
          const lines = file.content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].toLowerCase().includes(needle)) {
              hits.push(`${file.path}:${i + 1}: ${lines[i].slice(0, 200)}`);
              if (hits.length >= 100) break;
            }
          }
          if (hits.length >= 100) break;
        }
        return finish(hits.length > 0 ? 0 : 1, hits.join("\n"));
      }

      case "validate":
      case "check": {
        const report = validateProject(state.files);
        const lines: string[] = [
          `Build validation summary: ${report.summary}`,
          `Blocking: ${report.blocking ? "YES" : "NO"} | Errors: ${report.errors} | Warnings: ${report.warnings}`,
        ];
        for (const check of report.checks) {
          lines.push(`  [${check.status.toUpperCase().padEnd(7, " ")}] ${check.label}: ${check.message}`);
          for (const issue of check.issues.slice(0, 10)) {
            lines.push(`      ${issue.severity.toUpperCase()} ${issue.path}${issue.line ? `:${issue.line}` : ""} — ${issue.message}`);
          }
        }
        return finish(report.blocking ? 1 : 0, lines.join("\n"));
      }

      case "js": {
        const expr = args.join(" ").trim();
        if (!expr) return finish(1, "", "Usage: js <javascript-expression>");
        const vmRes = runIsolatedJs(expr, state.files);
        return finish(vmRes.exitCode, vmRes.stdout, vmRes.stderr);
      }

      case "run": {
        const target = args[0];
        if (!target) return finish(1, "", "Usage: run <path.js>");
        const safe = assertSafeProjectPath(target);
        if (!/\.(c|m)?js$/i.test(safe)) {
          return finish(126, "", `run: ${safe}: Only .js/.mjs/.cjs files can run inside the isolated JS VM.`);
        }
        const file = byPath.get(safe);
        if (!file || file.encoding === "base64") {
          return finish(1, "", `run: ${safe}: File not found or binary`);
        }
        const vmRes = runIsolatedJs(file.content, state.files);
        return finish(vmRes.exitCode, vmRes.stdout, vmRes.stderr);
      }

      case "touch": {
        const target = args[0];
        if (!target) return finish(1, "", "Usage: touch <path>");
        const safe = assertSafeProjectPath(target);
        if (byPath.has(safe)) return finish(0, `unchanged ${safe}`);
        const res = await adapter.upsertFile(safe, "", state.revision);
        return finish(0, `created ${safe} (revision ${res.revision})`, "", true);
      }

      case "write": {
        const target = args[0];
        const content = args.slice(1).join(" ");
        if (!target) return finish(1, "", "Usage: write <path> <content>");
        const safe = assertSafeProjectPath(target);
        const res = await adapter.upsertFile(safe, content, state.revision);
        return finish(0, `wrote ${Buffer.byteLength(content, "utf8")} bytes to ${safe} (revision ${res.revision})`, "", true);
      }

      case "mv": {
        const [from, to] = args;
        if (!from || !to) return finish(1, "", "Usage: mv <from> <to>");
        const safeFrom = assertSafeProjectPath(from);
        const safeTo = assertSafeProjectPath(to);
        await adapter.renameFile(safeFrom, safeTo, state.revision);
        return finish(0, `renamed ${safeFrom} -> ${safeTo}`, "", true);
      }

      case "rm": {
        const target = args[0];
        if (!target) return finish(1, "", "Usage: rm <path>");
        const safe = assertSafeProjectPath(target);
        if (!byPath.has(safe)) return finish(1, "", `rm: ${safe}: No such project file`);
        if (!options.confirmDestructive) {
          return finish(
            2,
            "",
            `CONFIRMATION_REQUIRED: Deleting '${safe}' requires explicit Human-in-the-Loop confirmation.`,
            false,
            {
              action: "rm",
              targetPath: safe,
              message: `Confirm deletion of '${safe}' from project '${state.title}'?`,
            },
          );
        }
        await adapter.deleteFile(safe, state.revision);
        return finish(0, `deleted ${safe}`, "", true);
      }

      default:
        return finish(
          126,
          "",
          `COMMAND_NOT_PERMITTED_IN_SANDBOX: '${program}' is not executed as a host OS binary. QORVYNA Workspace Terminal runs allowlisted project & isolated-VM commands only (run 'help' to inspect available commands).`,
        );
    }
  } catch (err) {
    return finish(1, "", err instanceof Error ? err.message : String(err));
  }
}

export interface FileDiffSummary {
  path: string;
  changeType: "added" | "modified" | "unchanged";
  addedLines: number;
  removedLines: number;
  preview: string;
}

/** Deterministic unified-style diff preview for AI Coding Workspace patch review. */
export function computeUnifiedFileDiff(
  path: string,
  beforeContent: string | undefined,
  afterContent: string,
): FileDiffSummary {
  if (beforeContent === undefined) {
    const afterLines = afterContent.split("\n");
    const body = afterLines.slice(0, 60).map((l) => `+ ${l}`).join("\n");
    return {
      path,
      changeType: "added",
      addedLines: afterLines.length,
      removedLines: 0,
      preview: `--- /dev/null\n+++ b/${path}\n${body}${afterLines.length > 60 ? `\n… (+${afterLines.length - 60} more lines)` : ""}`,
    };
  }
  if (beforeContent === afterContent) {
    return {
      path,
      changeType: "unchanged",
      addedLines: 0,
      removedLines: 0,
      preview: `--- a/${path}\n+++ b/${path}\n(no changes)`,
    };
  }

  const oldLines = beforeContent.split("\n");
  const newLines = afterContent.split("\n");
  const maxLen = Math.max(oldLines.length, newLines.length);
  const diffRows: string[] = [`--- a/${path}`, `+++ b/${path}`];
  let added = 0;
  let removed = 0;

  for (let i = 0; i < maxLen; i++) {
    const o = oldLines[i];
    const n = newLines[i];
    if (o === n) {
      if (diffRows.length < 80 && o !== undefined) diffRows.push(`  ${o}`);
      continue;
    }
    if (o !== undefined) {
      removed += 1;
      if (diffRows.length < 80) diffRows.push(`- ${o}`);
    }
    if (n !== undefined) {
      added += 1;
      if (diffRows.length < 80) diffRows.push(`+ ${n}`);
    }
  }
  if (oldLines.length + newLines.length > 80) {
    diffRows.push(`… (+${added} added / -${removed} removed total)`);
  }

  return {
    path,
    changeType: "modified",
    addedLines: added,
    removedLines: removed,
    preview: diffRows.join("\n"),
  };
}
