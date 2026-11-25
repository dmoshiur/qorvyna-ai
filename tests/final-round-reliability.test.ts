import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { completeWithModel, providerLatencyBudget } from "../src/lib/ai/executor";
import { streamWithFallback, completeWithFallback } from "../src/lib/ai/orchestrator/run";
import { coolDown, resetScheduler } from "../src/lib/ai/orchestrator/scheduler";
import { retryAfterAt } from "../src/lib/ai/provider-error";
import type { AIRouteTarget } from "../src/lib/ai/config";
import type { AIProvider, AIProviderRequest } from "../src/lib/ai/groq";
import { CLOUDFLARE_MODEL_ID } from "../src/lib/ai/models/registry";

const messages = [{ role: "user" as const, content: "hello" }];
const waitForAbort = (signal?: AbortSignal) => new Promise<never>((_, reject) => {
  if (signal?.aborted) return reject(new DOMException("aborted", "AbortError"));
  signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
});
const route = (provider: "Cloudflare" | "Groq", client: AIProvider): AIRouteTarget => ({ provider, model: provider === "Cloudflare" ? CLOUDFLARE_MODEL_ID : "openai/gpt-oss-120b", client });
const fallback = (): AIProvider => ({ healthCheck: async () => true, chat: async () => ({ content: "fallback", model: "openai/gpt-oss-120b", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } }), async *streamChat() { yield "fallback"; } });

beforeEach(() => { vi.useFakeTimers(); vi.stubEnv("QORVYNA_CLOUDFLARE_LATENCY_BUDGET_MS", "1000"); resetScheduler(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("provider latency and safe fallback", () => {
  it("bounds configuration and uses independent provider budgets", () => {
    expect(providerLatencyBudget("Cloudflare", {})).toBe(20_000);
    expect(providerLatencyBudget("Groq", { QORVYNA_GROQ_LATENCY_BUDGET_MS: "999" })).toBe(60_000);
    expect(providerLatencyBudget("Cloudflare", { QORVYNA_CLOUDFLARE_LATENCY_BUDGET_MS: "25000" })).toBe(25_000);
  });
  it("times out a non-streaming call and cancels the transport", async () => {
    const client: AIProvider = { healthCheck: async () => true, chat: (req) => waitForAbort(req.signal) };
    const result = completeWithModel([route("Cloudflare", client)], { messages }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(1001);
    expect(await result).toMatchObject({ type: "timeout" });
  });
  it("bounds an uncooperative non-streaming provider that ignores abort", async () => {
    const client: AIProvider = { healthCheck: async () => true, chat: () => new Promise(() => {}) };
    const result = completeWithModel([route("Cloudflare", client)], { messages }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(1001);
    expect(await result).toMatchObject({ type: "timeout" });
  });
  it("falls back even if an uncooperative stream ignores abort", async () => {
    const client: AIProvider = { ...fallback(), async *streamChat() { await new Promise(() => {}); yield "never"; } };
    const output: string[] = [];
    const task = (async () => { for await (const item of streamWithFallback([route("Cloudflare", client), route("Groq", fallback())], { messages })) output.push(item.delta); })();
    await vi.advanceTimersByTimeAsync(1001);
    await task;
    expect(output).toEqual(["fallback"]);
  });
  it("returns a timeout, without fallback, for an uncooperative stream after visible output", async () => {
    const client: AIProvider = { ...fallback(), async *streamChat() { yield "partial"; await new Promise(() => {}); } };
    const output: string[] = []; const switched = vi.fn();
    const task = (async () => { for await (const item of streamWithFallback([route("Cloudflare", client), route("Groq", fallback())], { messages }, { onFallback: switched })) output.push(item.delta); })().catch((e) => e);
    await vi.advanceTimersByTimeAsync(60_001);
    expect(await task).toMatchObject({ type: "timeout" });
    expect(output).toEqual(["partial"]); expect(switched).not.toHaveBeenCalled();
  });
  it("falls back when no visible stream output arrives", async () => {
    const client: AIProvider = { ...fallback(), async *streamChat(req: AIProviderRequest) { await waitForAbort(req.signal); yield "never"; } };
    const output: string[] = [];
    const switches: string[] = [];
    const task = (async () => { for await (const item of streamWithFallback([route("Cloudflare", client), route("Groq", fallback())], { messages }, { onFallback: () => switches.push("fallback") })) output.push(item.delta); })();
    await vi.advanceTimersByTimeAsync(1001);
    await task;
    expect(output).toEqual(["fallback"]);
    expect(switches).toEqual(["fallback"]);
  });
  it("never switches after visible text has been emitted", async () => {
    const client: AIProvider = { ...fallback(), async *streamChat(req: AIProviderRequest) { yield "partial"; await waitForAbort(req.signal); } };
    const output: string[] = [];
    const switched = vi.fn();
    const task = (async () => { for await (const item of streamWithFallback([route("Cloudflare", client), route("Groq", fallback())], { messages }, { onFallback: switched })) output.push(item.delta); })().catch((e) => e);
    await vi.advanceTimersByTimeAsync(60_001);
    expect(await task).toMatchObject({ type: "timeout" });
    expect(output).toEqual(["partial"]);
    expect(switched).not.toHaveBeenCalled();
  });
  it("does not fall back after user cancellation", async () => {
    const controller = new AbortController();
    const client: AIProvider = { ...fallback(), async *streamChat(req: AIProviderRequest) { await waitForAbort(req.signal); yield "never"; } };
    const switched = vi.fn();
    const task = (async () => { for await (const _ of streamWithFallback([route("Cloudflare", client), route("Groq", fallback())], { messages, signal: controller.signal }, { onFallback: switched })) { /* consume */ } })().catch((e) => e);
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    expect(await task).toBeInstanceOf(Error);
    expect(switched).not.toHaveBeenCalled();
  });
  it("does not bypass a real provider cooldown when no candidates remain", async () => {
    coolDown("gpt-oss-120b", 30_000);
    const complete = vi.fn();
    const result = await completeWithFallback([route("Groq", fallback())], () => ({ messages }), { complete });
    expect(result.completed).toBeNull();
    expect(complete).not.toHaveBeenCalled();
  });
  it("parses provider Retry-After seconds and HTTP dates without guessing", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(retryAfterAt("12", now)).toBe(now + 12_000);
    expect(retryAfterAt("Thu, 01 Jan 2026 00:01:00 GMT", now)).toBe(now + 60_000);
    expect(retryAfterAt(null, now)).toBeNull();
  });
});
