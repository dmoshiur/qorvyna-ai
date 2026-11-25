// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const confirm = vi.hoisted(() => vi.fn(async () => true));
const rpc = vi.hoisted(() => vi.fn());
vi.mock("@/components/dialogs", () => ({ useDialogs: () => ({ confirm, element: null }) }));
vi.mock("@/lib/client/api", () => ({ rpc }));
import { GithubMcpReader } from "@/components/github-mcp-reader";
let container: HTMLDivElement; let root: ReturnType<typeof createRoot>;
const change = (el: HTMLInputElement, value: string) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value); el.dispatchEvent(new Event("input", { bubbles: true })); };
beforeEach(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container); confirm.mockReset(); confirm.mockResolvedValue(true); rpc.mockReset(); rpc.mockImplementation(async (action: string) => action === "tool_approval_request" ? { id: "approval" } : action === "tool_execute" ? { ok: true, data: { text: "<script>not executable</script>", truncated: false } } : {}); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
describe("GitHub MCP reader", () => {
  it("requires confirmation, records argument-bound approval, and renders output as text", async () => {
    await act(async () => root.render(<GithubMcpReader />));
    const inputs = container.querySelectorAll("input");
    await act(async () => { change(inputs[0], "owner"); change(inputs[1], "repo"); change(inputs[2], "file.txt"); });
    const button = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Review and read"))!;
    confirm.mockResolvedValueOnce(false);
    await act(async () => button.click()); expect(rpc).not.toHaveBeenCalled();
    await act(async () => button.click());
    const args = { owner: "owner", repo: "repo", path: "file.txt" };
    expect(rpc).toHaveBeenNthCalledWith(1, "tool_approval_request", { tool_id: "mcp.github.read_file", args });
    expect(rpc).toHaveBeenNthCalledWith(2, "tool_approval_decide", { approval_id: "approval", approve: true });
    expect(rpc).toHaveBeenNthCalledWith(3, "tool_execute", { tool_id: "mcp.github.read_file", args, approval_id: "approval" });
    expect(container.textContent).toContain("<script>not executable</script>"); expect(container.querySelector("script")).toBeNull();
  });
});
