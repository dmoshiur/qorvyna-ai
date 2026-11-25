import "server-only";
import { createHash } from "node:crypto";
import { adminDb, nowTs } from "@/lib/firebase/admin";

const ttlMs = 10 * 60 * 1000;
const idFor = (state: string) => createHash("sha256").update(state).digest("hex");

/** State is random and stored only as a digest, never as an OAuth credential. */
export async function createGithubOAuthState(state: string, uid: string): Promise<void> {
  const expiresAt = Date.now() + ttlMs;
  await adminDb().collection("github_oauth_states").doc(idFor(state)).create({
    user_id: uid, status: "pending", expires_at_ms: expiresAt,
    expire_at: new Date(expiresAt), created_at: nowTs(),
  });
}

/** Atomically burn the state before contacting GitHub; failure requires reconnect. */
export async function consumeGithubOAuthState(state: string, uid: string): Promise<boolean> {
  const db = adminDb();
  const ref = db.collection("github_oauth_states").doc(idFor(state));
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.data();
    if (!snap.exists || data?.status !== "pending" || data.user_id !== uid ||
      typeof data.expires_at_ms !== "number" || data.expires_at_ms <= Date.now()) return false;
    tx.update(ref, { status: "used", used_at: nowTs() });
    return true;
  });
}
