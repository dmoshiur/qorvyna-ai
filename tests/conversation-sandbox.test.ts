import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { startProviderStub, type StubBehavior } from "./helpers/provider-stub";

const state = vi.hoisted(() => ({ configured: true, create: vi.fn(), get: vi.fn(), dispose: vi.fn() }));
vi.mock("@daytona/sdk/v0", () => ({
  RootOnlyClientV0: class {
    create = state.create;
    get = state.get;
    [Symbol.asyncDispose] = state.dispose;
  },
  DaytonaNotFoundError: class extends Error {},
}));
vi.mock("@/lib/server/daytona", () => ({ resolveDaytonaCredentials: async () => state.configured ? { apiKey: "dtn_synthetic_key_123456789", target: "us", source: "env" } : null }));
vi.mock("@/lib/firebase/admin", async () => {
  const { sharedFirestoreStub, makeAdminModule } = await import("./helpers/firestore-stub");
  return { ...makeAdminModule(sharedFirestoreStub()), adminConfigured: () => false };
});
vi.mock("@/lib/firebase/session", () => ({ verifySession: vi.fn(async () => ({ uid: "probe-user-1", email: null, emailVerified: true })) }));

import { sharedFirestoreStub } from "./helpers/firestore-stub";
import { cleanupConversationSandboxes, runConversationSandbox, validateSandboxCommand } from "../src/lib/server/conversation-sandbox";
import { explicitSandboxCommand, requestsSandboxExecution } from "../src/lib/ai/sandbox-intent";
import { POST } from "../src/app/api/ai/route";
import { resetServerAgentOpsForTests } from "../src/lib/agentops/server";

const db = sharedFirestoreStub();
const workspace = mkdtempSync(join(process.cwd(), ".sandbox-test-"));
const exec = vi.fn(async (command: string) => ({
  exitCode: 0,
  result: execFileSync("/bin/sh", ["-c", command], { cwd: workspace, encoding: "utf8", timeout: 5000 }),
}));
const sandbox = { id: "test-sandbox-1", state: "started", start: vi.fn(), process: { executeCommand: exec } };
afterAll(() => rmSync(workspace, { recursive: true, force: true }));
beforeEach(() => {
  db._state.docs.clear();
  db.clearFaults();
  state.configured = true;
  state.create.mockReset().mockResolvedValue(sandbox);
  state.get.mockReset().mockResolvedValue(sandbox);
  state.dispose.mockReset().mockResolvedValue(undefined);
  exec.mockClear();
  resetServerAgentOpsForTests();
});

const run = (command: string, extra: Partial<Parameters<typeof runConversationSandbox>[0]> = {}) => runConversationSandbox({
  d: db as never, uid: "user-1", conversationId: "chat-1", mode: "agent", command, executionId: "exec-test", ...extra,
});

describe("conversation sandbox", () => {
  it("detects explicit execution without treating normal discussion as a command", () => {
    expect(requestsSandboxExecution('Run this in your sandbox: echo "test"')).toBe(true);
    expect(explicitSandboxCommand('Run this in your sandbox: echo "test"')).toBe('echo "test"');
    expect(requestsSandboxExecution('echo "test"')).toBe(true);
    expect(requestsSandboxExecution("How does echo work?")).toBe(false);
    expect(requestsSandboxExecution("Build a website and test the code")).toBe(false);
  });
  it("runs real subprocesses with independent stdout and stderr and reuses the sandbox", async () => {
    const first = await run('echo "test"');
    expect(first).toMatchObject({ ok: true, output: { stdout: "test\n", stderr: "", exitCode: 0 } });
    // New chats for the same user do not create additional billable sandboxes.
    const second = await run("cat missing-file", { conversationId: "another-chat" });
    expect(second).toMatchObject({ ok: true, output: { stdout: "", exitCode: 1 } });
    if (second.ok) expect(second.output.stderr).toContain("missing-file");
    expect(state.create).toHaveBeenCalledTimes(1);
    expect(state.get).toHaveBeenCalledWith("test-sandbox-1");
    expect(state.create.mock.calls[0][0]).toMatchObject({ autoStopInterval: 15, autoDeleteInterval: 0, ttlMinutes: 60, networkBlockAll: true });
  });
  it("rejects escape paths, protected files, shell chaining and risky programs", async () => {
    writeFileSync(join(workspace, ".env"), "SECRET=hello");
    symlinkSync("/etc/passwd", join(workspace, "outside-link"));
    expect(await run("cat ../package.json")).toMatchObject({ ok: false, error: "COMMAND_NOT_ALLOWED" });
    expect(await run("cat outside-link")).toMatchObject({ ok: false, error: "COMMAND_NOT_ALLOWED" });
    expect(await run("cat .env")).toMatchObject({ ok: false, error: "COMMAND_NOT_ALLOWED" });
    expect(validateSandboxCommand("echo a; curl example.com", "agent").ok).toBe(false);
    expect(validateSandboxCommand("git status", "agent").ok).toBe(false);
    expect(validateSandboxCommand("curl example.com", "chat")).toMatchObject({ error: "AGENT_MODE_REQUIRED" });
    expect(validateSandboxCommand("sleep 60", "chat")).toMatchObject({ error: "AGENT_MODE_REQUIRED" });
  });
  it("does not create a duplicate on a transient lookup outage and prunes expired records", async () => {
    expect((await run("echo one")).ok).toBe(true);
    state.get.mockRejectedValue(new Error("service offline"));
    const second = await run("echo two");
    expect(second).toMatchObject({ ok: false, error: "EXECUTION_UNAVAILABLE" });
    expect(state.create).toHaveBeenCalledTimes(1);
    expect(await cleanupConversationSandboxes(db as never, Date.now() + 60 * 60_000 + 1)).toBe(1);
  });
  it("enforces timeout, caps output, and reports unavailable without fabricating output", async () => {
    const timeout = await run("sleep 3", { timeoutMs: 1000 });
    expect(timeout).toMatchObject({ ok: true, output: { timedOut: true, exitCode: null } });
    writeFileSync(join(workspace, "large"), "x".repeat(10_000));
    const large = await run("cat large");
    if (!large.ok) throw new Error(large.error);
    expect(large.output.stdout.length).toBe(4096);
    state.configured = false;
    expect(await run('echo "test"')).toMatchObject({ ok: false, error: "EXECUTION_UNAVAILABLE", message: expect.stringContaining("unavailable") });
  });
});

describe("sandbox through the actual chat gateway", () => {
  it("returns genuine output and stores it for both Agent and Chat, with an AgentOps span", async () => {
    const behavior: { current: StubBehavior } = { current: { kind: "ok", content: "not used" } };
    const provider = await startProviderStub(behavior);
    process.env.GPT_OSS_API_KEY = "sk-test-provider-123456789";
    process.env.GPT_OSS_BASE_URL = `http://127.0.0.1:${provider.port}/v1`;
    try {
      for (const [index, mode] of ["agent", "general"].entries()) {
        const req = new NextRequest("http://localhost:3000/api/ai", { method: "POST", headers: { Authorization: "Bearer aaa.bbb.ccc", "Content-Type": "application/json" }, body: JSON.stringify({ action: "chat", mode, stream: true, message: 'Run this in your sandbox: echo "test"', request_id: `sandbox-test-${index}` }) });
        const response = await POST(req);
        const data = await response.json();
        expect(response.status).toBe(200);
        expect(data.sandbox_output).toMatchObject({ stdout: "test\n", stderr: "", exitCode: 0 });
        expect(JSON.stringify(data)).not.toContain("dtn_synthetic_key_123456789");
        const record = await resetOrGet(`exec_sandbox-test-${index}`);
        expect(record?.steps.some((step) => step.stepId.startsWith("sandbox-") && step.detail?.includes("test-sandbox-1"))).toBe(true);
        const { recordToSpans } = await import("../src/lib/agentops/telemetry");
        expect(recordToSpans(record!).some((span) => span.attributes["agentops.sandbox.id"] === "test-sandbox-1" && span.attributes["agentops.sandbox.exit_code"] === "0" && String(span.attributes["agentops.sandbox.command"]).includes("echo"))).toBe(true);
        const stored = [...db._state.docs.values()].find((v) => (v.metadata as { sandbox_output?: unknown } | undefined)?.sandbox_output);
        expect(stored).toBeDefined();
      }
    } finally {
      provider.server.close();
      delete process.env.GPT_OSS_API_KEY;
      delete process.env.GPT_OSS_BASE_URL;
    }
  });

  it("exposes run_command to a tool-capable model for an execution request", async () => {
    const behavior: { current: StubBehavior } = { current: { kind: "tool_call_then_ok", toolName: "run_command", arguments: JSON.stringify({ command: "echo selected" }), finalContent: "not used" } };
    const provider = await startProviderStub(behavior);
    process.env.GPT_OSS_API_KEY = "sk-test-provider-123456789";
    process.env.GPT_OSS_BASE_URL = `http://127.0.0.1:${provider.port}/v1`;
    try {
      const req = new NextRequest("http://localhost:3000/api/ai", { method: "POST", headers: { Authorization: "Bearer aaa.bbb.ccc", "Content-Type": "application/json" }, body: JSON.stringify({ action: "chat", mode: "agent", message: "Run a command in your sandbox that prints selected", request_id: "sandbox-model-call-1" }) });
      const response = await POST(req);
      const body = await response.json();
      expect(body.sandbox_output).toMatchObject({ stdout: "selected\n", exitCode: 0 });
      expect(provider.calls.some((call) => Array.isArray(call.body?.tools) && call.body.tools.some((tool: { function?: { name?: string } }) => tool.function?.name === "run_command"))).toBe(true);
    } finally {
      provider.server.close();
      delete process.env.GPT_OSS_API_KEY;
      delete process.env.GPT_OSS_BASE_URL;
    }
  });

  it("runs a literal command even when no model is configured", async () => {
    delete process.env.GPT_OSS_API_KEY;
    delete process.env.GPT_OSS_BASE_URL;
    delete process.env.GROQ_API_KEY;
    const { resetAccountsForTests } = await import("../src/lib/ai/accounts");
    resetAccountsForTests();
    const req = new NextRequest("http://localhost:3000/api/ai", { method: "POST", headers: { Authorization: "Bearer aaa.bbb.ccc", "Content-Type": "application/json" }, body: JSON.stringify({ action: "chat", mode: "agent", message: 'Run this in your sandbox: echo "test"', request_id: "sandbox-no-model-1" }) });
    const response = await POST(req);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.sandbox_output).toMatchObject({ stdout: "test\n", exitCode: 0 });
  });

  it("never fabricates output when execution is unavailable, and offers Agent mode for other commands", async () => {
    const behavior: { current: StubBehavior } = { current: { kind: "ok", content: "fake output" } };
    const provider = await startProviderStub(behavior);
    process.env.GPT_OSS_API_KEY = "sk-test-provider-123456789";
    process.env.GPT_OSS_BASE_URL = `http://127.0.0.1:${provider.port}/v1`;
    const call = async (message: string, id: string) => {
      const req = new NextRequest("http://localhost:3000/api/ai", { method: "POST", headers: { Authorization: "Bearer aaa.bbb.ccc", "Content-Type": "application/json" }, body: JSON.stringify({ action: "chat", mode: "general", stream: true, message, request_id: id }) });
      return (await POST(req)).json();
    };
    try {
      state.configured = false;
      const unavailable = await call('Run this in your sandbox: echo "test"', "sandbox-missing-key");
      expect(unavailable.reply).toMatch(/execution is unavailable/i);
      expect(unavailable.reply).toContain("/terminal");
      expect(unavailable.sandbox_output).toBeUndefined();
      expect(unavailable.reply).not.toContain("fake output");
      const handoff = await call("Run this command in your sandbox: sleep 60", "sandbox-handoff-1");
      expect(handoff.sandbox_agent_command).toBe("sleep 60");
      expect(handoff.sandbox_output).toBeUndefined();
    } finally {
      provider.server.close();
      delete process.env.GPT_OSS_API_KEY;
      delete process.env.GPT_OSS_BASE_URL;
    }
  });
});

async function resetOrGet(id: string) {
  const { getServerAgentOps } = await import("../src/lib/agentops/server");
  return getServerAgentOps().getExecution(id);
}
