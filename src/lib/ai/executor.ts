// Controlled execution of ONE request against ONE registered model.
//
// Policy:
//   • Each call has exactly one route. Nothing here switches model; moving a
//     task to another model is an explicit orchestrator decision.
//   • A transient failure (rate limit, network blip, empty reply) is retried
//     once against the SAME model. Timeouts and malformed requests are not.
//   • After that the real provider error is thrown. The caller shows it,
//     keeps the user's message and project context, and offers Retry.
//   • Once visible content has been streamed, the request is never restarted.
//   • A caller-supplied abort (the user pressed Stop) is never retried.

import type { AIMessage, AIProviderRequest, AIProviderResponse } from "@/lib/ai/groq";
import { AIConfigurationError, type AIRouteTarget } from "@/lib/ai/config";
import { isRegisteredModelId } from "@/lib/ai/models/registry";
import { AIProviderError, logProviderFailure, providerErrorFromException } from "@/lib/ai/provider-error";
import { recordProviderCall } from "@/lib/ai/provider-latency";

export type CompletedAIResponse = {
  target: AIRouteTarget;
  response: AIProviderResponse;
};

type RequestOptions = Omit<AIProviderRequest, "model" | "messages"> & {
  messages: AIMessage[];
  requestId?: string;
  /**
   * Long generations (whole project files) are read as a stream and
   * aggregated. A fixed total timeout on a blocking request is the wrong
   * tool for a 16k-token answer: slower providers were cut off at 60–90 s
   * while still producing output. The stream is supervised by first-byte and
   * idle watchdogs instead.
   */
  aggregateStream?: boolean;
  /** Absolute epoch-ms budget for the whole call including the single retry. */
  deadlineAt?: number;
};

// Time to first visible output (or complete non-streamed answer), not a
// claim about measured provider performance. Bound operator configuration.
export function providerLatencyBudget(provider: AIRouteTarget["provider"], env: Record<string, string | undefined> = process.env): number {
  const key = `QORVYNA_${provider.toUpperCase()}_LATENCY_BUDGET_MS`;
  const value = Number(env[key]);
  return Number.isFinite(value) && value >= 1_000 && value <= 180_000 ? Math.floor(value) : provider === "Cloudflare" ? 20_000 : 60_000;
}
const IDLE_TIMEOUT_MS = 60_000;
const MAX_STREAM_MS = 240_000;
const MIN_ATTEMPT_BUDGET_MS = 12_000;

/** Bound the caller even if an adapter ignores AbortSignal. The underlying
 * transport may still run until it honors cancellation; never await cleanup. */
function abortable<T>(operation: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason ?? new DOMException("Aborted", "AbortError")); };
    const cleanup = () => signal.removeEventListener("abort", abort);
    if (signal.aborted) { abort(); Promise.resolve(operation).catch(() => {}); return; }
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(operation).then((result) => { cleanup(); resolve(result); }, (error) => { cleanup(); reject(error); });
  });
}

/** A blocked async generator must not keep the request waiting after abort. */
async function* abortableStream(source: AsyncGenerator<string>, signal: AbortSignal): AsyncGenerator<string> {
  try {
    while (true) {
      const result = await abortable(source.next(), signal);
      if (result.done) return;
      yield result.value;
    }
  } finally {
    // An uncooperative generator can keep return() pending behind next().
    // Cleanup is best effort; its rejection is always handled.
    void source.return(undefined).catch(() => {});
  }
}

function asProviderError(target: AIRouteTarget, error: unknown, requestId?: string): AIProviderError {
  return providerErrorFromException(target.provider, target.model, error, requestId);
}

function canTryAgain(error: AIProviderError): boolean {
  // Repeating a timed-out or malformed request only doubles the wait.
  return error.retryable === true && error.type !== "timeout" && error.type !== "rate_limit";
}

function waitBriefly(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 150));
}

function budgetExhausted(deadlineAt: number | undefined): boolean {
  return typeof deadlineAt === "number" && Date.now() > deadlineAt - MIN_ATTEMPT_BUDGET_MS;
}

/** Read a provider stream to completion under first-byte/idle/total watchdogs. */
async function aggregateStream(target: AIRouteTarget, request: RequestOptions): Promise<AIProviderResponse> {
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort(request.signal?.reason);
  if (request.signal?.aborted) onOuterAbort();
  request.signal?.addEventListener("abort", onOuterAbort, { once: true });
  const started = Date.now();
  const totalMs = Math.max(MIN_ATTEMPT_BUDGET_MS, Math.min(MAX_STREAM_MS, (request.deadlineAt ?? started + MAX_STREAM_MS) - started));
  let watchdogReason = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  const arm = (ms: number, reason: string) => {
    if (timer) clearTimeout(timer);
    const remaining = started + totalMs - Date.now();
    const total = remaining <= ms;
    timer = setTimeout(() => {
      watchdogReason = total ? `no complete answer within ${Math.round(totalMs / 1000)}s` : reason;
      controller.abort();
    }, Math.max(1, Math.min(ms, remaining)));
  };
  let content = "";
  let usage: AIProviderResponse["usage"] = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  const firstByteMs = providerLatencyBudget(target.provider);
  arm(firstByteMs, `no output within ${firstByteMs / 1000}s of sending the request`);
  try {
    const { aggregateStream: _a, deadlineAt: _d, ...providerRequest } = request;
    void _a; void _d;
    for await (const delta of abortableStream(target.client.streamChat!({
      ...providerRequest,
      model: target.model,
      messages: request.messages,
      signal: controller.signal,
      onUsage: (value) => { usage = value; request.onUsage?.(value); },
      onReasoningActivity: (phase) => {
        if (controller.signal.aborted) return;
        if (content) arm(IDLE_TIMEOUT_MS, `model stopped responding for ${IDLE_TIMEOUT_MS / 1000}s while reasoning`);
        request.onReasoningActivity?.(phase);
      },
    }), controller.signal)) {
      content += delta;
      arm(IDLE_TIMEOUT_MS, `stream stalled for ${IDLE_TIMEOUT_MS / 1000}s after ${content.length} characters`);
    }
  } catch (error) {
    if (watchdogReason && !request.signal?.aborted) {
      throw new AIProviderError({ provider: target.provider, model: target.model, type: "timeout", detail: watchdogReason, requestId: request.requestId });
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    request.signal?.removeEventListener("abort", onOuterAbort);
  }
  return { content, model: target.model, usage, finishReason: undefined, toolCalls: [] };
}

/**
 * Last line of defence: one call goes to exactly one route, and only to a
 * model in the registry. Choosing between models (and falling back from one to
 * another) is the orchestrator's job, never an accident of this function.
 */
function soleRoute(targets: AIRouteTarget[], coding: boolean): AIRouteTarget {
  const target = targets[0];
  if (!target) throw new AIConfigurationError(coding);
  if (targets.length !== 1 || !isRegisteredModelId(target.model)) {
    throw new Error(`Refusing to send a request to ${targets.length} route(s) / unregistered model "${target.model}".`);
  }
  return target;
}

/** Completion used by Agent mode, builds and non-streaming chat. */
export async function completeWithModel(
  targets: AIRouteTarget[],
  request: RequestOptions,
): Promise<CompletedAIResponse> {
  const target = soleRoute(targets, true);
  let lastError: AIProviderError | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (budgetExhausted(request.deadlineAt) && lastError) throw lastError;
    const attemptStartedAt = Date.now();
    try {
      const useStream = request.aggregateStream === true && !request.tools?.length && typeof target.client.streamChat === "function";
      let response: AIProviderResponse;
      if (useStream) {
        response = await aggregateStream(target, request);
      } else {
        const { aggregateStream: _a, deadlineAt: _d, ...providerRequest } = request;
        void _a; void _d;
        const controller = new AbortController();
        const outerAbort = () => controller.abort(request.signal?.reason);
        if (request.signal?.aborted) outerAbort();
        request.signal?.addEventListener("abort", outerAbort, { once: true });
        const ms = providerLatencyBudget(target.provider);
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; controller.abort(); }, ms);
        try {
          response = await abortable(target.client.chat({ ...providerRequest, model: target.model, messages: request.messages, signal: controller.signal }), controller.signal);
        } catch (error) {
          if (timedOut && !request.signal?.aborted) throw new AIProviderError({ provider: target.provider, model: target.model, type: "timeout", detail: `no answer within ${ms / 1000}s`, requestId: request.requestId });
          throw error;
        } finally {
          clearTimeout(timer);
          request.signal?.removeEventListener("abort", outerAbort);
        }
      }
      if (!response.content?.trim() && !response.toolCalls?.length) {
        throw new AIProviderError({
          provider: target.provider,
          model: target.model,
          type: "empty_response",
          detail: "provider returned no assistant content",
          requestId: request.requestId,
          retryable: true,
        });
      }
      recordProviderCall(target.provider, target.model, Math.max(1, Date.now() - attemptStartedAt), true);
      return { target, response };
    } catch (error) {
      if (request.signal?.aborted) throw error;
      const typed = asProviderError(target, error, request.requestId);
      recordProviderCall(target.provider, target.model, Math.max(1, Date.now() - attemptStartedAt), false);
      lastError = typed;
      logProviderFailure(typed, request.requestId);
      if (attempt === 0 && canTryAgain(typed)) {
        await waitBriefly();
        continue;
      }
      throw typed;
    }
  }
  throw lastError ?? new AIConfigurationError(true);
}

/**
 * Streaming equivalent. A failure before any output is retried once on the
 * same model. Once content has been yielded the stream is never restarted:
 * the partial output is preserved and the caller receives the real error.
 */
export async function* streamWithModel(
  targets: AIRouteTarget[],
  request: RequestOptions,
  onStart?: (target: AIRouteTarget) => void,
): AsyncGenerator<{ delta: string; target: AIRouteTarget }> {
  const target = soleRoute(targets, false);
  let lastError: AIProviderError | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let yielded = false;
    try {
      onStart?.(target);
      if (!target.client.streamChat) throw new Error("provider does not support streaming");
      const { aggregateStream: _a, deadlineAt: _d, ...providerRequest } = request;
      void _a; void _d;
      const controller = new AbortController();
      const outerAbort = () => controller.abort(request.signal?.reason);
      if (request.signal?.aborted) outerAbort();
      request.signal?.addEventListener("abort", outerAbort, { once: true });
      const firstByteMs = providerLatencyBudget(target.provider);
      let timedOut = false;
      let timer: ReturnType<typeof setTimeout>;
      const arm = (ms: number) => {
        clearTimeout(timer);
        timer = setTimeout(() => { timedOut = true; controller.abort(); }, ms);
      };
      arm(firstByteMs);
      try {
        for await (const delta of abortableStream(target.client.streamChat({ ...providerRequest, model: target.model, messages: request.messages, signal: controller.signal }), controller.signal)) {
          if (!delta) continue;
          yielded = true;
          arm(IDLE_TIMEOUT_MS);
          yield { delta, target };
        }
      } catch (error) {
        if (timedOut && !request.signal?.aborted) throw new AIProviderError({ provider: target.provider, model: target.model, type: "timeout", detail: yielded ? "provider stream stalled" : `no output within ${firstByteMs / 1000}s`, requestId: request.requestId });
        throw error;
      } finally {
        clearTimeout(timer!);
        request.signal?.removeEventListener("abort", outerAbort);
      }
      if (!yielded) {
        throw new AIProviderError({
          provider: target.provider,
          model: target.model,
          type: "empty_response",
          detail: "provider returned no streamed assistant content",
          requestId: request.requestId,
          retryable: true,
        });
      }
      return;
    } catch (error) {
      if (request.signal?.aborted) throw error;
      const typed = asProviderError(target, error, request.requestId);
      lastError = typed;
      logProviderFailure(typed, request.requestId);
      if (yielded) throw typed;
      if (attempt === 0 && canTryAgain(typed)) {
        await waitBriefly();
        continue;
      }
      throw typed;
    }
  }
  throw lastError ?? new AIConfigurationError(false);
}
