// AgentOps execution finalization (review P0-1).
//
// The chat/agent runtime must close every execution it opens so records become
// terminal ("completed" / "failed") and are counted by the Live Monitor and the
// economics dashboards. Without finalization an execution stays "running"
// forever and the flagship dashboard records nothing.
import { describe, expect, it } from "vitest";
import { QORVYNA_MODEL_ID } from "@/lib/ai/model";
import { AgentOpsEngine } from "@/lib/agentops";
import { InMemoryAgentOpsStorage } from "@/lib/agentops/storage";
import { agentOpsEnd, agentOpsStart, agentOpsHandle, resetServerAgentOpsForTests } from "@/lib/agentops/server";

describe("AgentOps execution finalization", () => {
  it("marks an execution completed only after the terminal event", async () => {
    const storage = new InMemoryAgentOpsStorage();
    const engine = resetServerAgentOpsForTests(storage);

    const execId = await engine.start({
      userId: "user_1",
      conversationId: "conv_1",
      mode: "chat",
      modelPool: [QORVYNA_MODEL_ID],
    });

    // Before finalization the record is non-terminal.
    const open = await engine.getExecution(execId);
    expect(open?.status).toBe("running");
    expect(open?.endedAt ?? null).toBeNull();

    // Finalize via the server helper (the path the chat route now uses).
    await agentOpsEnd({ executionId: execId, outcome: "success" });

    const done = await engine.getExecution(execId);
    expect(done?.status).toBe("completed");
    expect(done?.endedAt).not.toBeNull();
    expect(done?.totalDurationMs ?? 0).toBeGreaterThan(0);
  });

  it("agentOpsEnd is a no-op (does not throw) for an unknown execution", async () => {
    resetServerAgentOpsForTests(new InMemoryAgentOpsStorage());
    await expect(agentOpsEnd({ executionId: "exec_missing", outcome: "provider_failure" })).resolves.toBeUndefined();
  });

  it("the start+handle+end sequence produces a terminal record in storage", async () => {
    const storage = new InMemoryAgentOpsStorage();
    const engine = resetServerAgentOpsForTests(storage);

    const execId = await agentOpsStart({
      executionId: "exec_test_1",
      userId: "user_1",
      conversationId: "conv_1",
      mode: "agent",
      modelPool: [QORVYNA_MODEL_ID],
    });
    await agentOpsHandle({
      type: "token.usage",
      executionId: execId,
      model: QORVYNA_MODEL_ID,
      requestType: "chat",
      usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
      latencyMs: 100,
      status: "ok",
      at: Date.now(),
    });
    await agentOpsEnd({ executionId: execId, outcome: "success" });

    const rows = await storage.listExecutions({ userId: "user_1" });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("completed");
    expect(rows[0].metrics.totalTokens).toBe(8);
  });
});
