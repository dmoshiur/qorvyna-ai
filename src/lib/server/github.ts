import "server-only";

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { adminDb, nowTs } from "@/lib/firebase/admin";
import { env, isGithubConfigured } from "@/lib/env";
import { safeAgentPath, type AgentFile } from "@/lib/ai/agent";

const API = "https://api.github.com";
const CONNECTIONS = "github_connections";

export type GithubConnection = {
  login: string;
  name: string;
  avatarUrl: string;
  connectedAt: string;
};

function encryptionKey(): Buffer {
  return createHash("sha256").update(env.github.tokenEncryptionKey).digest();
}

export function encryptGithubToken(token: string): string {
  if (!isGithubConfigured()) throw new Error("GITHUB_NOT_CONFIGURED");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((part) => part.toString("base64url")).join(".");
}

export function decryptGithubToken(value: string): string {
  if (!isGithubConfigured()) throw new Error("GITHUB_NOT_CONFIGURED");
  const [ivRaw, tagRaw, encryptedRaw] = value.split(".");
  if (!ivRaw || !tagRaw || !encryptedRaw) throw new Error("GITHUB_TOKEN_INVALID");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivRaw, "base64url"));
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedRaw, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function iso(value: unknown): string {
  const timestamp = value as { toDate?: () => Date } | undefined;
  return timestamp?.toDate?.().toISOString() ?? "";
}

export async function saveGithubConnection(uid: string, token: string, profile: { login: string; name?: string | null; avatar_url?: string | null }) {
  const ref = adminDb().collection(CONNECTIONS).doc(uid);
  const existing = await ref.get();
  const connectedAt = existing.data()?.connected_at ?? nowTs();
  await ref.set({
    user_id: uid,
    access_token_encrypted: encryptGithubToken(token),
    login: profile.login,
    name: profile.name ?? "",
    avatar_url: profile.avatar_url ?? "",
    connected_at: connectedAt,
    updated_at: nowTs(),
  }, { merge: true });
}

export async function getGithubConnection(uid: string): Promise<GithubConnection | null> {
  const doc = await adminDb().collection(CONNECTIONS).doc(uid).get();
  if (!doc.exists) return null;
  const data = doc.data()!;
  return {
    login: String(data.login ?? ""),
    name: String(data.name ?? ""),
    avatarUrl: String(data.avatar_url ?? ""),
    connectedAt: iso(data.connected_at),
  };
}

export async function deleteGithubConnection(uid: string): Promise<void> {
  await adminDb().collection(CONNECTIONS).doc(uid).delete();
}

export async function githubTokenForServer(uid: string): Promise<string> {
  const doc = await adminDb().collection(CONNECTIONS).doc(uid).get();
  if (!doc.exists) throw new Error("GITHUB_NOT_CONNECTED");
  return decryptGithubToken(String(doc.data()?.access_token_encrypted ?? ""));
}

export async function githubRequest<T>(uid: string, path: string, init: RequestInit = {}): Promise<T> {
  const token = await githubTokenForServer(uid);
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "QORVYNA-AI-Agent",
      ...(init.headers ?? {}),
    },
    cache: "no-store",
    redirect: "error",
    signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    // Never log or return provider bodies; they may contain private content.
    await response.body?.cancel().catch(() => {});
    throw new Error(`GITHUB_${response.status}`);
  }
  if (response.status === 204) return undefined as T;
  if (!response.body) throw new Error("GITHUB_RESPONSE_INVALID");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2_000_000) { await reader.cancel().catch(() => {}); throw new Error("GITHUB_RESPONSE_TOO_LARGE"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8")) as T; }
  catch { throw new Error("GITHUB_RESPONSE_INVALID"); }
}

export type GithubRepo = {
  id: number;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  permissions: { push: boolean };
};

export async function listGithubRepos(uid: string): Promise<GithubRepo[]> {
  const repos = await githubRequest<Array<{
    id: number;
    full_name: string;
    private: boolean;
    default_branch: string;
    permissions?: { push?: boolean };
  }>>(uid, "/user/repos?affiliation=owner,collaborator,organization_member&sort=updated&per_page=100");
  return repos
    .filter((repo) => repo.permissions?.push === true)
    .map((repo) => ({
      id: repo.id,
      fullName: repo.full_name,
      private: repo.private,
      defaultBranch: repo.default_branch,
      permissions: { push: repo.permissions?.push === true },
    }));
}

function validRepo(repo: string): boolean {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return false;
  return repo.split("/").every((part) => part !== "." && part !== "..");
}

function validBranch(branch: string): boolean {
  const forbidden = [" ", "\t", "\n", "~", "^", ":", "?", "*", "[", "\\"];
  return branch.length > 0 && branch.length <= 180 && !branch.startsWith("-") &&
    !branch.includes("..") && !branch.includes("@{") &&
    !forbidden.some((character) => branch.includes(character)) &&
    !branch.endsWith(".") && !branch.endsWith("/");
}

export function validatePushFiles(input: unknown): AgentFile[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 40) throw new Error("FILES_INVALID");
  const files: AgentFile[] = [];
  let total = 0;
  const paths = new Set<string>();
  for (const raw of input) {
    if (!raw || typeof raw !== "object") throw new Error("FILES_INVALID");
    const item = raw as Record<string, unknown>;
    const path = typeof item.path === "string" ? safeAgentPath(item.path) : null;
    const content = typeof item.content === "string" ? item.content : null;
    if (!path || content == null || Buffer.byteLength(content, "utf8") > 300_000 || paths.has(path)) throw new Error("FILES_INVALID");
    if (item.encoding != null && item.encoding !== "utf8") throw new Error("FILES_BINARY_UNSUPPORTED");
    paths.add(path);
    // Environment files and obvious private-key material do not belong in a
    // generated commit. This is a guard, not a substitute for secret scanning.
    const filename = path.split("/").at(-1)!.toLowerCase();
    if (/^\.env(?:\.|$)/.test(filename) || /\.(?:pem|p12|pfx|key)$/.test(filename) || /-----BEGIN (?:[A-Z ]*PRIVATE KEY)-----/.test(content)) throw new Error("FILES_SENSITIVE");
    total += Buffer.byteLength(content, "utf8");
    if (total > 700_000) throw new Error("FILES_TOO_LARGE");
    files.push({ path, content, language: typeof item.language === "string" ? item.language.slice(0, 30) : "text" });
  }
  return files;
}

/** Authenticated, bounded snapshot used for an explicit review. */
type ReviewFile = { path: string; before: string | null; after: string; status: "new" | "changed" | "unchanged" };
type ReviewClaims = { reviewId: string; uid: string; repository: string; branch: string; head: string; filesHash: string; expiresAt: number };
const REVIEW_TTL_MS = 10 * 60_000;
const SHA_RE = /^[a-f0-9]{40}$/i;

export function checkedTarget(repository: string, branch: string): void {
  if (!validRepo(repository) || !validBranch(branch)) throw new Error("TARGET_INVALID");
}
function filesHash(files: AgentFile[]): string {
  // Bind the exact submitted file paths and contents, independent of language labels.
  return createHash("sha256").update(JSON.stringify(files.map(({ path, content }) => [path, content]))).digest("hex");
}
function signReview(payload: string): string {
  return createHmac("sha256", env.github.tokenEncryptionKey).update(`github-push-review-v1:${payload}`).digest("base64url");
}
function makeReviewToken(claims: ReviewClaims): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${payload}.${signReview(payload)}`;
}
export function verifyGithubReview(token: string, uid: string, input: { repository: string; branch: string; files: AgentFile[] }, now = Date.now()): ReviewClaims {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra || token.length > 2048 || !isGithubConfigured()) throw new Error("GITHUB_REVIEW_REQUIRED");
  const expected = Buffer.from(signReview(payload));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error("GITHUB_REVIEW_REQUIRED");
  let claims: ReviewClaims;
  try { claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as ReviewClaims; }
  catch { throw new Error("GITHUB_REVIEW_REQUIRED"); }
  if (!/^[A-Za-z0-9_-]{24}$/.test(claims.reviewId ?? "") || claims.uid !== uid || claims.repository !== input.repository || claims.branch !== input.branch ||
      claims.filesHash !== filesHash(input.files) || !SHA_RE.test(claims.head ?? "") ||
      typeof claims.expiresAt !== "number" || claims.expiresAt <= now || claims.expiresAt > now + REVIEW_TTL_MS) {
    throw new Error("GITHUB_REVIEW_REQUIRED");
  }
  return claims;
}

export async function writableRepository(uid: string, repository: string, signal?: AbortSignal): Promise<void> {
  const repo = await githubRequest<{ permissions?: { push?: boolean } }>(uid, `/repos/${repository}`, { signal });
  if (repo.permissions?.push !== true) throw new Error("GITHUB_PUSH_FORBIDDEN");
}
export async function branchHead(uid: string, repository: string, branch: string, signal?: AbortSignal): Promise<string> {
  const encodedBranch = branch.split("/").map(encodeURIComponent).join("/");
  const ref = await githubRequest<{ object?: { sha?: string } }>(uid, `/repos/${repository}/git/ref/heads/${encodedBranch}`, { signal });
  const head = ref.object?.sha ?? "";
  if (!SHA_RE.test(head)) throw new Error("GITHUB_INVALID_HEAD");
  return head;
}

/** Read exact remote files at the selected immutable HEAD; no repo content goes to an AI model. */
export async function previewGithubPush(uid: string, input: { repository: string; branch: string; files: AgentFile[] }): Promise<{ head: string; expiresAt: number; reviewToken: string; files: ReviewFile[] }> {
  const { repository, branch, files } = input;
  checkedTarget(repository, branch);
  const signal = AbortSignal.timeout(25_000);
  await writableRepository(uid, repository, signal);
  const head = await branchHead(uid, repository, branch, signal);
  const commit = await githubRequest<{ tree?: { sha?: string } }>(uid, `/repos/${repository}/git/commits/${head}`, { signal });
  const rootTree = commit.tree?.sha ?? "";
  if (!SHA_RE.test(rootTree)) throw new Error("GITHUB_INVALID_HEAD");
  type TreeEntry = { path?: string; mode?: string; type?: string; sha?: string; size?: number };
  const trees = new Map<string, TreeEntry[]>();
  const readTree = async (sha: string) => {
    if (trees.has(sha)) return trees.get(sha)!;
    const tree = await githubRequest<{ truncated?: boolean; tree?: TreeEntry[] }>(uid, `/repos/${repository}/git/trees/${sha}`, { signal });
    if (tree.truncated || !Array.isArray(tree.tree)) throw new Error("GITHUB_REMOTE_FILE_UNSUPPORTED");
    trees.set(sha, tree.tree);
    return tree.tree;
  };
  let remoteBytes = 0;
  const reviewed: ReviewFile[] = [];
  for (const file of files) {
    let treeSha = rootTree;
    let entry: TreeEntry | undefined;
    const parts = file.path.split("/");
    for (let i = 0; i < parts.length; i += 1) {
      entry = (await readTree(treeSha)).find((item) => item.path === parts[i]);
      if (!entry) break;
      if (i < parts.length - 1) {
        if (entry.type !== "tree" || !entry.sha || !SHA_RE.test(entry.sha)) throw new Error("GITHUB_REMOTE_FILE_UNSUPPORTED");
        treeSha = entry.sha;
      }
    }
    let remote: { encoding?: string; content?: string; size?: number } | null = null;
    if (entry) {
      // GitHub's commit mutation does not preserve executable or symlink mode.
      if (entry.type !== "blob" || entry.mode !== "100644" || !entry.sha || !SHA_RE.test(entry.sha) || typeof entry.size !== "number" || entry.size > 300_000) throw new Error("GITHUB_REMOTE_FILE_UNSUPPORTED");
      remote = await githubRequest(uid, `/repos/${repository}/git/blobs/${entry.sha}`, { signal });
    }
    let before: string | null = null;
    if (remote) {
      if (remote.encoding !== "base64" || typeof remote.content !== "string" ||
          typeof remote.size !== "number" || remote.size < 0 || remote.size > 300_000) throw new Error("GITHUB_REMOTE_FILE_UNSUPPORTED");
      const encoded = remote.content.replace(/\s/g, "");
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error("GITHUB_REMOTE_FILE_UNSUPPORTED");
      const bytes = Buffer.from(encoded, "base64");
      if (bytes.length !== remote.size || bytes.includes(0)) throw new Error("GITHUB_REMOTE_FILE_UNSUPPORTED");
      remoteBytes += bytes.length;
      if (remoteBytes > 700_000) throw new Error("GITHUB_REMOTE_FILES_TOO_LARGE");
      try { before = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
      catch { throw new Error("GITHUB_REMOTE_FILE_UNSUPPORTED"); }
    }
    reviewed.push({ path: file.path, before, after: file.content, status: before === null ? "new" : before === file.content ? "unchanged" : "changed" });
  }
  const expiresAt = Date.now() + REVIEW_TTL_MS;
  const reviewId = randomBytes(18).toString("base64url");
  const claims: ReviewClaims = { reviewId, uid, repository, branch, head, filesHash: filesHash(files), expiresAt };
  // Only the digest and metadata are persisted; TTL cleanup requires a
  // separately configured Firestore TTL policy on expire_at.
  await adminDb().collection("github_push_reviews").doc(reviewId).create({
    user_id: uid, repository, branch, head, files_hash: claims.filesHash,
    status: "pending", expires_at_ms: expiresAt, expire_at: new Date(expiresAt), created_at: nowTs(),
  });
  return { head, expiresAt, reviewToken: makeReviewToken(claims), files: reviewed };
}

/** Atomically consume the reviewed snapshot; do not retry unknown writes. */
async function consumeGithubReview(claims: ReviewClaims): Promise<void> {
  const d = adminDb();
  const ref = d.collection("github_push_reviews").doc(claims.reviewId);
  await d.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.data();
    if (!snap.exists || data?.status !== "pending" || data.user_id !== claims.uid ||
        data.repository !== claims.repository || data.branch !== claims.branch || data.head !== claims.head ||
        data.files_hash !== claims.filesHash || data.expires_at_ms !== claims.expiresAt || claims.expiresAt <= Date.now()) {
      throw new Error("GITHUB_REVIEW_REQUIRED");
    }
    tx.update(ref, { status: "used", used_at: nowTs() });
  });
}

/** Create a single commit only if GitHub's branch still has the reviewed HEAD. */
export async function pushAgentFiles(uid: string, input: {
  repository: string;
  branch: string;
  message: string;
  files: AgentFile[];
  reviewToken: string;
}): Promise<{ commitSha: string; commitUrl: string; branch: string }> {
  const { repository, branch } = input;
  checkedTarget(repository, branch);
  const message = input.message.trim().slice(0, 160);
  if (!message) throw new Error("COMMIT_MESSAGE_REQUIRED");
  const review = verifyGithubReview(input.reviewToken, uid, input);
  await writableRepository(uid, repository);
  if ((await branchHead(uid, repository, branch)) !== review.head) throw new Error("GITHUB_HEAD_CHANGED");
  await consumeGithubReview(review);
  // GraphQL expectedHeadOid is an atomic compare-and-swap, including races
  // after our preflight read. Never retry or silently overwrite a newer ref.
  const result = await githubRequest<{ data?: { createCommitOnBranch?: { commit?: { oid?: string; url?: string } } }; errors?: Array<{ message?: string; type?: string }> }>(uid, "/graphql", {
    method: "POST",
    body: JSON.stringify({
      query: `mutation CreateReviewedCommit($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid url } } }`,
      variables: { input: {
        branch: { repositoryNameWithOwner: repository, branchName: branch },
        expectedHeadOid: review.head,
        message: { headline: message },
        fileChanges: { additions: input.files.map(({ path, content }) => ({ path, contents: Buffer.from(content, "utf8").toString("base64") })) },
      } },
    }),
  });
  if (result.errors?.length) {
    if (result.errors.some((error) => /expected.{0,30}head|head.{0,30}(?:change|match|oid)|stale/i.test(error.message ?? ""))) throw new Error("GITHUB_HEAD_CHANGED");
    throw new Error("GITHUB_COMMIT_REJECTED");
  }
  const commit = result.data?.createCommitOnBranch?.commit;
  if (!commit?.oid || !SHA_RE.test(commit.oid) || !commit.url || !/^https:\/\/github\.com\//.test(commit.url)) throw new Error("GITHUB_COMMIT_UNCONFIRMED");
  return { commitSha: commit.oid, commitUrl: commit.url, branch };
}
