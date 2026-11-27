// Governed conversation execution. The model cannot choose a sandbox, a
// credential, an executable outside the allowlist, or a host working directory.
import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { RootOnlyClientV0 as Daytona, DaytonaNotFoundError } from "@daytona/sdk/v0";
import type { Db } from "@/lib/firebase/admin";
import { tokenizeWorkspaceCommand } from "@/lib/terminal/engine";
import { resolveDaytonaCredentials } from "@/lib/server/daytona";
import { redactPII } from "@/lib/ai/pii";
import { scrubSecrets } from "@/lib/agentops/governance";
import { agentOpsHandle, getServerAgentOps } from "@/lib/agentops/server";

const SAFE = new Set(["echo", "pwd", "whoami", "ls", "cat", "stat", "grep"]);
const AGENT = new Set([...SAFE, "sleep"]);
const MAX_OUTPUT = 4096;
const LIFETIME_MS = 60 * 60_000;
const LEASE_MS = 180_000;

export type SandboxOutput = {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  /** Sandbox id + region, shown in the chat transcript for traceability (Issue 7). */
  sandboxId?: string;
  region?: string;
};
export type SandboxResult =
  | { ok: true; output: SandboxOutput }
  | { ok: false; error: "EXECUTION_UNAVAILABLE" | "COMMAND_NOT_ALLOWED" | "AGENT_MODE_REQUIRED" | "INVALID_COMMAND" | "SANDBOX_BUSY"; message: string; command: string };

/** Validate program and flags before any remotely executed code is built. */
export function validateSandboxCommand(command: string, mode: "chat" | "agent"):
  | { ok: true; argv: string[] }
  | { ok: false; error: "COMMAND_NOT_ALLOWED" | "AGENT_MODE_REQUIRED" | "INVALID_COMMAND" } {
  if (!command.trim() || command.length > 4000 || /[\0\r\n]/.test(command)) return { ok: false, error: "INVALID_COMMAND" };
  const parsed = tokenizeWorkspaceCommand(command);
  if (!parsed.ok || !parsed.tokens.length || parsed.tokens.length > 64) return { ok: false, error: "INVALID_COMMAND" };
  const [program, ...args] = parsed.tokens;
  if (!AGENT.has(program)) return { ok: false, error: mode === "chat" ? "AGENT_MODE_REQUIRED" : "COMMAND_NOT_ALLOWED" };
  if (mode === "chat" && !SAFE.has(program)) return { ok: false, error: "AGENT_MODE_REQUIRED" };
  if (program === "sleep" && (args.length !== 1 || !/^\d+(?:\.\d+)?$/.test(args[0]))) return { ok: false, error: "INVALID_COMMAND" };
  if ((program === "pwd" || program === "whoami") && args.length) return { ok: false, error: "INVALID_COMMAND" };
  // Never allow flags that can name external files or recurse through links.
  const flags: Record<string, Set<string>> = {
    ls: new Set(["-a", "-l", "-al", "-la", "-1"]),
    grep: new Set(["-i", "-n", "-v", "-F", "-c"]),
    cat: new Set(), stat: new Set(),
  };
  if (flags[program] && args.some((arg) => arg.startsWith("-") && !flags[program].has(arg))) return { ok: false, error: "COMMAND_NOT_ALLOWED" };
  return { ok: true, argv: parsed.tokens };
}

// Run subprocesses without a shell. Paths are resolved in the sandbox, so even
// symlinks cannot escape its working directory. No credentials are mounted;
// networkBlockAll is enforced by Daytona, not by this process. stdout/stderr
// go to bounded temporary files instead of an unbounded in-memory pipe.
const RUNNER = String.raw`
import base64,json,os,resource,subprocess,sys,tempfile
p=json.loads(base64.b64decode(sys.argv[1])); argv=p['argv']; program=argv[0]
root=os.path.realpath(os.getcwd()); cwd=os.path.realpath(os.path.join(root,p['cwd']))
def allowed(path):
    real=os.path.realpath(os.path.join(cwd,path))
    parts=real.lower().split(os.sep)
    return (real==root or real.startswith(root+os.sep)) and not any(x in parts for x in ['.ssh','.aws','.config','.git']) and not any(x.startswith('.env') for x in parts)
if not allowed(cwd) or not os.path.isdir(cwd):
    print(json.dumps({'error':'invalid working directory'})); sys.exit(0)
args=argv[1:]
if program in ('ls','cat','stat','grep'):
    nonflags=[x for x in args if not x.startswith('-')]
    paths=nonflags[1:] if program=='grep' else nonflags
    if any(not allowed(x) for x in paths):
        print(json.dumps({'error':'path is outside the sandbox workspace or is protected'})); sys.exit(0)
def limit():
    resource.setrlimit(resource.RLIMIT_FSIZE,(65536,65536))
    resource.setrlimit(resource.RLIMIT_CORE,(0,0))
with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
    try:
        proc=subprocess.run(argv,cwd=cwd,stdin=subprocess.DEVNULL,stdout=out,stderr=err,timeout=p['timeout'],preexec_fn=limit,env={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8','HOME':root})
        code=proc.returncode; timed=False
    except subprocess.TimeoutExpired:
        code=None; timed=True
    except OSError:
        print(json.dumps({'error':'executable is unavailable'})); sys.exit(0)
    out.seek(0); err.seek(0)
    print(json.dumps({'stdout':out.read(4096).decode('utf-8','replace'),'stderr':err.read(4096).decode('utf-8','replace'),'exitCode':code,'timedOut':timed}))
`;

function cleanOutput(value: string, key: string): string {
  return scrubSecrets(value.split(key).join("[REDACTED]")).slice(0, MAX_OUTPUT);
}

/** Run at most one command at a time per user, even across multiple chats. */
export async function runConversationSandbox(input: {
  d: Db; uid: string; conversationId: string; mode: "chat" | "agent";
  command: string; cwd?: string; timeoutMs?: number; executionId: string;
}): Promise<SandboxResult> {
  const { d, uid, conversationId, command, mode, executionId } = input;
  const creds = await resolveDaytonaCredentials();
  if ((creds?.apiKey && command.includes(creds.apiKey)) || /\bdtn_[a-zA-Z0-9_-]+\b/.test(command) || scrubSecrets(command) !== command) return { ok: false, error: "INVALID_COMMAND", command: "[redacted]", message: "Remove credentials from the command before retrying." };
  const validation = validateSandboxCommand(command, mode);
  if (!validation.ok) return { ok: false, error: validation.error, command, message: validation.error === "AGENT_MODE_REQUIRED" ? "This command requires Agent mode." : "This command is not permitted in the governed sandbox." };
  const cwd = input.cwd ?? ".";
  if (cwd.length > 500 || cwd.startsWith("/") || cwd.includes("\0")) return { ok: false, error: "INVALID_COMMAND", command, message: "Use a working directory inside the sandbox workspace." };
  if (!creds) return { ok: false, error: "EXECUTION_UNAVAILABLE", command, message: "Execution is unavailable right now because the sandbox is not configured. Use the [qsh terminal](/terminal) for safe read-only commands." };
  const timeout = Math.max(1, Math.min(30, Math.ceil((input.timeoutMs ?? 10_000) / 1000)));
  // One sandbox per user (a stricter cap than one per browser session). This
  // prevents creating unlimited billable sandboxes by opening new conversations.
  const sessionKey = createHash("sha256").update(uid).digest("hex");
  const ref = d.collection("conversation_sandboxes").doc(sessionKey);
  const lease = randomUUID();
  const now = Date.now();
  const started = now;
  let sandboxId: string | null = null;
  let client: Daytona | null = null;
  const traceId = getServerAgentOps().rootAgentId(executionId);
  const traceCommand = redactPII(scrubSecrets(command)).redacted.slice(0, 300);
  const stepId = `sandbox-${lease}`;
  await agentOpsHandle({ type: "step.start", executionId, agentId: traceId, stepId, label: `Sandbox: ${traceCommand.slice(0, 120)}`, model: "sandbox", provider: "sandbox", startedAt: started });
  try {
    const locked = await d.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.data();
      if (data?.lease_until > now) return false;
      sandboxId = typeof data?.sandbox_id === "string" && data.expires_at > now ? data.sandbox_id : null;
      tx.set(ref, { uid, conversation_id: conversationId, lease, lease_until: now + LEASE_MS, ...(sandboxId ? {} : { expires_at: now + LIFETIME_MS }) }, { merge: true });
      return true;
    });
    if (!locked) return { ok: false, error: "SANDBOX_BUSY", command, message: "Another sandbox command is running; retry when it finishes." };
    const apiUrl = process.env.DAYTONA_API_URL?.trim();
    client = new Daytona({ apiKey: creds.apiKey, ...(creds.target ? { target: creds.target } : {}), ...(apiUrl ? { apiUrl } : {}), requestTimeoutMs: 15_000 });
    let sandbox;
    if (sandboxId) {
      try {
        sandbox = await client.get(sandboxId);
        if (sandbox.state !== "started") await sandbox.start(30);
      } catch (error) {
        // A transient outage must not create a duplicate billable sandbox.
        if (!(error instanceof DaytonaNotFoundError)) throw error;
        sandbox = undefined; sandboxId = null;
      }
    }
    if (!sandbox) {
      await agentOpsHandle({ type: "step.start", executionId, agentId: traceId, stepId: `${stepId}-create`, label: "Sandbox create", model: "sandbox", provider: "sandbox", startedAt: Date.now() });
      sandbox = await client.create({ language: "typescript", autoStopInterval: 15, autoDeleteInterval: 0, ttlMinutes: 60, networkBlockAll: true }, { timeout: 45 });
      sandboxId = sandbox.id;
      if (!sandboxId) throw new Error("SANDBOX_ID_MISSING");
      await ref.set({ sandbox_id: sandboxId, created_at: Date.now(), expires_at: Date.now() + LIFETIME_MS }, { merge: true });
      await agentOpsHandle({ type: "step.done", executionId, agentId: traceId, stepId: `${stepId}-create`, status: "done", model: sandboxId, attempts: [], durationMs: Math.max(1, Date.now() - started), usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, detail: "Sandbox created; idle auto-stop 15 min, wall-clock TTL 60 min, network blocked.", finishedAt: Date.now() });
    }
    const data = Buffer.from(JSON.stringify({ argv: validation.argv, cwd, timeout })).toString("base64");
    const script = Buffer.from(RUNNER).toString("base64");
    const response = await sandbox.process.executeCommand(`python3 -c "import base64;exec(base64.b64decode('${script}'))" '${data}'`, undefined, undefined, timeout + 3);
    if (response.exitCode !== 0) throw new Error("SANDBOX_RUNNER_FAILED");
    const parsed: { error?: string; stdout?: string; stderr?: string; exitCode?: number | null; timedOut?: boolean } = JSON.parse(response.result);
    if (parsed.error) {
      await agentOpsHandle({ type: "step.done", executionId, agentId: traceId, stepId, status: "failed", model: sandboxId ?? "sandbox", attempts: [], durationMs: Math.max(1, Date.now() - started), usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, detail: `Sandbox ${sandboxId}; exit denied; command ${traceCommand}`, finishedAt: Date.now() });
      return { ok: false, error: "COMMAND_NOT_ALLOWED", command, message: parsed.error };
    }
    if (typeof parsed.stdout !== "string" || typeof parsed.stderr !== "string" || !(typeof parsed.exitCode === "number" || parsed.exitCode === null)) throw new Error("SANDBOX_INVALID_RESPONSE");
    const output: SandboxOutput = { command: cleanOutput(command, creds.apiKey), stdout: cleanOutput(parsed.stdout, creds.apiKey), stderr: cleanOutput(parsed.stderr, creds.apiKey), exitCode: parsed.exitCode, timedOut: parsed.timedOut === true, durationMs: Math.max(1, Date.now() - started), sandboxId: sandboxId ?? undefined, region: creds.target ?? undefined };
    await agentOpsHandle({ type: "step.done", executionId, agentId: traceId, stepId, status: output.timedOut || output.exitCode !== 0 ? "failed" : "done", model: sandboxId ?? "sandbox", attempts: [], durationMs: output.durationMs, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, detail: `Sandbox ${sandboxId}; exit ${output.exitCode ?? "timeout"}; command ${traceCommand}`, finishedAt: Date.now() });
    return { ok: true, output };
  } catch {
    await agentOpsHandle({ type: "step.done", executionId, agentId: traceId, stepId, status: "failed", model: sandboxId ?? "sandbox", attempts: [], durationMs: Math.max(1, Date.now() - started), usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, detail: "Sandbox unavailable.", finishedAt: Date.now() });
    return { ok: false, error: "EXECUTION_UNAVAILABLE", command: scrubSecrets(command), message: "Execution is unavailable right now because the sandbox service could not complete the request. Use the [qsh terminal](/terminal) for safe read-only commands." };
  } finally {
    if (client) await client[Symbol.asyncDispose]().catch(() => {});
    await d.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.data()?.lease === lease) tx.set(ref, { lease: null, lease_until: 0, last_used_at: Date.now() }, { merge: true });
    }).catch(() => {});
  }
}

/** Remove stale bookkeeping. Daytona's own TTL destroys sandboxes even if this job never runs. */
export async function cleanupConversationSandboxes(d: Db, now = Date.now()): Promise<number> {
  const snapshot = await d.collection("conversation_sandboxes").where("expires_at", "<=", now).limit(100).get();
  let deleted = 0;
  for (const doc of snapshot.docs) {
    await d.runTransaction(async (tx) => {
      const current = await tx.get(doc.ref);
      const data = current.data();
      if (data && Number(data.expires_at) <= now && Number(data.lease_until ?? 0) <= now) {
        tx.delete(doc.ref);
        deleted++;
      }
    });
  }
  return deleted;
}
