import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { adminDb, type Db } from "@/lib/firebase/admin";
import { parseResetDuration } from "@/lib/ai/accounts";

// Unknown organizations are deliberately grouped together, never treated as
// separate independent quotas. This is a safety ledger, not billing data.
type State = { requests: number | null; requestsUntil: number; tokens: number | null; tokensUntil: number; cooldownUntil: number; bootstrapId: string; bootstrapUntil: number };
const blank = (): State => ({ requests: null, requestsUntil: 0, tokens: null, tokensUntil: 0, cooldownUntil: 0, bootstrapId: "", bootstrapUntil: 0 });
const finite = (x: unknown) => typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : null;
const integer = (value: string | null) => value !== null && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
const docId = (model: string, orgId?: string) => {
  const cleanOrg = orgId?.trim() && /^[A-Za-z0-9_.-]{3,80}$/.test(orgId.trim()) ? `org:${orgId.trim()}` : "unknown-org";
  return createHash("sha256").update(`groq:${cleanOrg}:${model}`).digest("hex");
};
function read(value: Record<string, unknown> | undefined, now: number): State {
  if (!value) return blank();
  const requestsUntil = finite(value.requests_until) ?? 0, tokensUntil = finite(value.tokens_until) ?? 0;
  return { requests: requestsUntil > now ? finite(value.requests) : null, requestsUntil: requestsUntil > now ? requestsUntil : 0,
    tokens: tokensUntil > now ? finite(value.tokens) : null, tokensUntil: tokensUntil > now ? tokensUntil : 0,
    cooldownUntil: Math.max(0, finite(value.cooldown_until) ?? 0), bootstrapId: typeof value.bootstrap_id === "string" ? value.bootstrap_id : "", bootstrapUntil: finite(value.bootstrap_until) ?? 0 };
}
function write(state: State) {
  return { requests: state.requests, requests_until: state.requestsUntil, tokens: state.tokens, tokens_until: state.tokensUntil,
    cooldown_until: state.cooldownUntil, bootstrap_id: state.bootstrapId, bootstrap_until: state.bootstrapUntil, updated_at: new Date(), expire_at: new Date(Math.max(Date.now(), state.requestsUntil, state.tokensUntil, state.cooldownUntil, state.bootstrapUntil) + 24 * 3_600_000) };
}
export function sharedGroqQuotaEnabled(): boolean {
  if (process.env.QORVYNA_GROQ_SHARED_QUOTA === "false") return false;
  return process.env.NODE_ENV === "production" || process.env.QORVYNA_GROQ_SHARED_QUOTA === "true";
}

/** Atomically reserve capacity from already-observed windows; unknown is not guessed. */
export async function reserveGroqCapacity(d: Db, model: string, estimatedTokens: number, now = Date.now(), organizationId?: string): Promise<{ allowed: boolean; retryAt: number | null; reason: "rate_limit" | "bootstrap" | null; leaseId: string }> {
  const ref = d.collection("provider_quota_windows").doc(docId(model, organizationId));
  const tokens = Math.max(0, Math.ceil(estimatedTokens));
  return d.runTransaction(async (tx) => {
    const snap = await tx.get(ref); const s = read(snap.data(), now);
    const retryAt = Math.max(s.cooldownUntil > now ? s.cooldownUntil : 0,
      s.requests !== null && s.requests < 1 ? s.requestsUntil : 0,
      s.tokens !== null && s.tokens < tokens ? s.tokensUntil : 0);
    if (retryAt > now) return { allowed: false, retryAt, reason: "rate_limit", leaseId: "" };
    // Before any usable headers, permit one in-flight discovery request across
    // the fleet; a lease recovers after process death. This is a concurrency
    // control, not a claim about a provider quota.
    let leaseId = "";
    if (s.requests === null && s.tokens === null) {
      if (s.bootstrapId && s.bootstrapUntil > now) return { allowed: false, retryAt: s.bootstrapUntil, reason: "bootstrap", leaseId: "" };
      leaseId = randomBytes(18).toString("base64url");
      s.bootstrapId = leaseId; s.bootstrapUntil = now + 180_000;
    }
    if (s.requests !== null) s.requests = Math.max(0, s.requests - 1);
    if (s.tokens !== null) s.tokens = Math.max(0, s.tokens - tokens);
    tx.set(ref, write(s), { merge: false });
    return { allowed: true, retryAt: null, reason: null, leaseId };
  });
}

/** Apply only genuine provider observations. Min remaining / max reset is
 * intentionally conservative for out-of-order concurrent responses. */
export async function observeGroqCapacity(d: Db, model: string, headers: Headers, cooldownUntil = 0, now = Date.now(), leaseId = "", organizationId?: string): Promise<void> {
  const requests = integer(headers.get("x-ratelimit-remaining-requests"));
  const tokens = integer(headers.get("x-ratelimit-remaining-tokens"));
  const reqReset = parseResetDuration(headers.get("x-ratelimit-reset-requests"));
  const tokReset = parseResetDuration(headers.get("x-ratelimit-reset-tokens"));
  const headerOrg = organizationId ?? headers.get("x-organization") ?? undefined;
  const ref = d.collection("provider_quota_windows").doc(docId(model, headerOrg));
  await d.runTransaction(async (tx) => {
    const snap = await tx.get(ref); const s = read(snap.data(), now);
    if (leaseId && s.bootstrapId === leaseId) { s.bootstrapId = ""; s.bootstrapUntil = 0; }
    if (requests !== null && reqReset !== null && reqReset > 0 && reqReset <= 7 * 86_400_000) {
      s.requests = s.requests === null ? requests : Math.min(s.requests, requests);
      s.requestsUntil = Math.max(s.requestsUntil, now + reqReset);
    }
    if (tokens !== null && tokReset !== null && tokReset > 0 && tokReset <= 7 * 86_400_000) {
      s.tokens = s.tokens === null ? tokens : Math.min(s.tokens, tokens);
      s.tokensUntil = Math.max(s.tokensUntil, now + tokReset);
    }
    if (Number.isFinite(cooldownUntil) && cooldownUntil > now) s.cooldownUntil = Math.max(s.cooldownUntil, Math.min(cooldownUntil, now + 86_400_000));
    tx.set(ref, write(s), { merge: false });
  });
}
export function groqQuotaDb(): Db { return adminDb(); }

/** Release only the caller's bootstrap lease after a failed transport. */
export async function releaseGroqBootstrap(d: Db, model: string, leaseId: string, now = Date.now()): Promise<void> {
  if (!leaseId) return;
  const ref = d.collection("provider_quota_windows").doc(docId(model));
  await d.runTransaction(async (tx) => {
    const snap = await tx.get(ref); const state = read(snap.data(), now);
    if (state.bootstrapId !== leaseId) return;
    state.bootstrapId = ""; state.bootstrapUntil = 0;
    tx.set(ref, write(state), { merge: false });
  });
}
