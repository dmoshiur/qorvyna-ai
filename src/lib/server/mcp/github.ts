import "server-only";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { type Db } from "@/lib/firebase/admin";
import { safeAgentPath } from "@/lib/ai/agent";
import { githubTokenForServer } from "@/lib/server/github";

const ENDPOINT = "https://api.githubcopilot.com/mcp/";
const MAX_BYTES = 1_000_000;
const MAX_TEXT = 16_000;
const part = z.string().min(1).max(100).regex(/^[A-Za-z0-9_.-]+$/).refine((s) => s !== "." && s !== "..");
export const githubMcpFileSchema = z.object({
  owner: part, repo: part,
  path: z.string().min(1).max(180).refine((p) => safeAgentPath(p) === p),
  ref: z.string().max(200).regex(/^(?:refs\/(?:heads|tags)\/)?[A-Za-z0-9_./-]+$/).refine((v) => !v.includes("..") && !v.includes("//")).optional(),
}).strict();
export type GithubMcpFileInput = z.infer<typeof githubMcpFileSchema>;

/** Prevent arbitrary hosts, redirect following and unlimited upstream bodies. */
export async function githubMcpFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  if (String(url) !== ENDPOINT) throw new Error("MCP_DESTINATION_DENIED");
  const outer = init?.signal;
  const signal = outer ? AbortSignal.any([outer, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
  const response = await fetch(ENDPOINT, { ...init, signal, redirect: "error", cache: "no-store" });
  if (!response.body) return response;
  const reader = response.body.getReader(); let total = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) { controller.close(); return; }
        total += next.value.byteLength;
        if (total > MAX_BYTES) { await reader.cancel().catch(() => {}); controller.error(new Error("MCP_RESPONSE_TOO_LARGE")); return; }
        controller.enqueue(next.value);
      } catch (error) { controller.error(error); }
    },
    async cancel() { await reader.cancel().catch(() => {}); },
  });
  return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
}

/** Minors require an approved guardian record for this personal connector.
 * Missing/invalid DOB is denied rather than guessing an age. */
export async function assertGithubMcpConsent(db: Db, uid: string, now = new Date()): Promise<void> {
  const [profile, consent] = await Promise.all([db.collection("profiles").doc(uid).get(), db.collection("guardian_consents").doc(uid).get()]);
  const dob = profile.data()?.date_of_birth;
  if (typeof dob !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dob)) throw new Error("MCP_AGE_REQUIRED");
  const birth = new Date(`${dob}T00:00:00Z`);
  if (!Number.isFinite(birth.getTime()) || birth.toISOString().slice(0, 10) !== dob || birth > now) throw new Error("MCP_AGE_REQUIRED");
  let age = now.getUTCFullYear() - birth.getUTCFullYear();
  if (now.getUTCMonth() < birth.getUTCMonth() || (now.getUTCMonth() === birth.getUTCMonth() && now.getUTCDate() < birth.getUTCDate())) age--;
  if (age < 18 && (consent.data()?.status !== "approved" || consent.data()?.consent_method !== "guardian")) throw new Error("MCP_GUARDIAN_APPROVAL_REQUIRED");
}

/** One approved read of a fixed official MCP server. No discovered tool can
 * become callable: only this named read-only operation is permitted. */
export async function readGithubMcpFile(db: Db, uid: string, raw: unknown): Promise<{ text: string; truncated: boolean; trust: "untrusted_external_content" }> {
  if (process.env.QORVYNA_GITHUB_MCP_ENABLED !== "true") throw new Error("MCP_GITHUB_NOT_ENABLED");
  const input = githubMcpFileSchema.parse(raw);
  await assertGithubMcpConsent(db, uid);
  const token = await githubTokenForServer(uid);
  const signal = AbortSignal.timeout(15_000);
  const client = new Client({ name: "qorvyna-github-read", version: "1.0.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT), { requestInit: { headers: { Authorization: `Bearer ${token}` } }, fetch: githubMcpFetch,
    reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 } });
  try {
    await client.connect(transport, { signal, timeout: 14_000 });
    const result = await client.callTool({ name: "get_file_contents", arguments: input }, undefined, { signal, timeout: 14_000 });
    if (result.isError || !Array.isArray(result.content) || result.content.length === 0 || result.content.some((item) => item.type !== "text")) throw new Error("MCP_REMOTE_RESULT_INVALID");
    const text = result.content.map((item) => item.type === "text" ? item.text : "").join("\n");
    return { text: text.slice(0, MAX_TEXT), truncated: text.length > MAX_TEXT, trust: "untrusted_external_content" };
  } finally {
    // Don't await remote session termination; close local transport immediately.
    await client.close().catch(() => {});
  }
}
