// =============================================================================
// QORVYNA AI — Provider Latency Telemetry & Latency Circuit Breaker.
//
// Tracks real sliding-window latency (P50 / P95 / average), error rate, and
// temporary degradation state per (provider, model) pair from actual runtime
// provider calls. Never fabricates latency numbers when zero calls have run.
// =============================================================================

export type ProviderLatencySummary = {
  provider: string;
  model: string;
  samples: number;
  failures: number;
  errorRate: number;
  p50Ms: number | null;
  p95Ms: number | null;
  avgMs: number | null;
  degradedUntil: number;
  degraded: boolean;
  lastObservedAt: number | null;
};

type Bucket = {
  provider: string;
  model: string;
  latencies: number[];
  outcomes: boolean[];
  consecutiveSlowOrFailed: number;
  degradedUntil: number;
  lastObservedAt: number | null;
};

const MAX_WINDOW = 100;
const DEGRADE_STREAK_THRESHOLD = 4;
const DEGRADE_COOLDOWN_MS = 30_000;
const DEFAULT_SLOW_CALL_MS = 25_000;

const buckets = new Map<string, Bucket>();

function keyOf(provider: string, model: string): string {
  return `${provider}::${model}`;
}

function percentile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((q / 100) * sorted.length) - 1));
  return Math.round(sorted[idx]);
}

export function recordProviderCall(
  provider: string,
  model: string,
  latencyMs: number,
  ok: boolean,
  slowThresholdMs = DEFAULT_SLOW_CALL_MS,
  now = Date.now(),
): void {
  const k = keyOf(provider, model);
  let b = buckets.get(k);
  if (!b) {
    b = {
      provider,
      model,
      latencies: [],
      outcomes: [],
      consecutiveSlowOrFailed: 0,
      degradedUntil: 0,
      lastObservedAt: null,
    };
    buckets.set(k, b);
  }
  const cleanLatency = Math.max(0, Math.round(latencyMs));
  b.latencies.push(cleanLatency);
  if (b.latencies.length > MAX_WINDOW) b.latencies.shift();
  b.outcomes.push(ok);
  if (b.outcomes.length > MAX_WINDOW) b.outcomes.shift();
  b.lastObservedAt = now;

  if (!ok || cleanLatency > slowThresholdMs) {
    b.consecutiveSlowOrFailed += 1;
    if (b.consecutiveSlowOrFailed >= DEGRADE_STREAK_THRESHOLD) {
      b.degradedUntil = now + DEGRADE_COOLDOWN_MS;
    }
  } else {
    b.consecutiveSlowOrFailed = 0;
    if (b.degradedUntil <= now) b.degradedUntil = 0;
  }
}

export function providerLatencyStats(now = Date.now()): ProviderLatencySummary[] {
  const out: ProviderLatencySummary[] = [];
  for (const b of buckets.values()) {
    const sorted = [...b.latencies].sort((x, y) => x - y);
    const samples = b.outcomes.length;
    const failures = b.outcomes.filter((x) => !x).length;
    const sum = sorted.reduce((acc, v) => acc + v, 0);
    out.push({
      provider: b.provider,
      model: b.model,
      samples,
      failures,
      errorRate: samples > 0 ? failures / samples : 0,
      p50Ms: percentile(sorted, 50),
      p95Ms: percentile(sorted, 95),
      avgMs: sorted.length ? Math.round(sum / sorted.length) : null,
      degradedUntil: b.degradedUntil,
      degraded: b.degradedUntil > now,
      lastObservedAt: b.lastObservedAt,
    });
  }
  return out;
}

export function isProviderDegraded(provider: string, model: string, now = Date.now()): boolean {
  const b = buckets.get(keyOf(provider, model));
  return Boolean(b && b.degradedUntil > now);
}

/**
 * Re-orders candidate targets so non-degraded targets lead while preserving
 * relative priority among healthy targets. Never removes a target.
 */
export function orderTargetsByLatencyHealth<T extends { provider: string; model: string }>(
  targets: readonly T[],
  now = Date.now(),
): T[] {
  if (targets.length <= 1) return [...targets];
  const healthy: T[] = [];
  const degraded: T[] = [];
  for (const t of targets) {
    if (isProviderDegraded(t.provider, t.model, now)) degraded.push(t);
    else healthy.push(t);
  }
  return [...healthy, ...degraded];
}

export function resetProviderLatencyForTests(): void {
  buckets.clear();
}
