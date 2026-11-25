import { beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/server/mcp/github", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/mcp/github")>();
  return { ...actual, readGithubMcpFile: vi.fn(async () => ({ text: "untrusted", truncated: false, trust: "untrusted_external_content" })) };
});
import { toolRegistry } from "@/lib/ai/tools/registry";
import { readGithubMcpFile } from "@/lib/server/mcp/github";
const ctx = { db: {}, uid: "owner", email: null, requestId: "test" };
const args = { owner: "octocat", repo: "demo", path: "a.txt" };
beforeAll(async () => { vi.stubEnv("QORVYNA_GITHUB_MCP_ENABLED", "true"); await import("@/lib/ai/tools/index"); });
describe("GitHub MCP gateway registration", () => {
  it("requires one-use approval and is not callable by models", async () => {
    const spec = toolRegistry.get("mcp.github.read_file")!;
    expect(spec).toMatchObject({ approvalRequired: true, modelCallable: false, environment: "external-api" });
    expect(toolRegistry.schemasForModel({ modelCallableOnly: true }).some((item) => item.name === spec.id)).toBe(false);
    const denied = await toolRegistry.call(ctx, spec.id, args, async () => true);
    expect(denied).toMatchObject({ ok: false, error: "APPROVAL_REQUIRED" });
    const noProof = await toolRegistry.call({ ...ctx, approvalId: "fake" }, spec.id, args, async () => true, async () => false);
    expect(noProof).toMatchObject({ ok: false, error: "APPROVAL_INVALID" });
    expect(readGithubMcpFile).not.toHaveBeenCalled();
    const result = await toolRegistry.call({ ...ctx, approvalId: "valid" }, spec.id, args, async () => true, async () => true);
    expect(result).toMatchObject({ ok: true, data: { trust: "untrusted_external_content" } });
  });
});
