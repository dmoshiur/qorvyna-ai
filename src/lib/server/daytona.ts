import "server-only";

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { Daytona } from "@daytona/sdk";
import { adminDb, nowTs } from "@/lib/firebase/admin";
import { daytonaConfig, env, isDaytonaConfigured } from "@/lib/env";
import { safeAgentPath } from "@/lib/ai/agent";
import { scrubSecrets } from "@/lib/agentops/governance";
import type { ExecutionGateway } from "@/lib/server/execution-env";

const CONNECTIONS = "daytona_connections";
const SYSTEM_DOC = "daytona_sandbox";

export type DaytonaLanguage = "typescript" | "javascript" | "python";

export type DaytonaStatus = {
  configured: boolean;
  encryptionAvailable: boolean;
  source: "user" | "system" | "env" | "none";
  keyLast4: string | null;
  keyMask: string | null;
  target: string;
  sdk: "@daytona/sdk";
};

export type DaytonaWorkspaceFile = {
  path: string;
  content: string;
};

export type DaytonaRunResult = {
  exitCode: number;
  result: string;
  stdout: string;
  sandboxId: string;
  language: DaytonaLanguage;
  durationMs: number;
};

type DaytonaProcessResultLike = {
  exitCode?: number;
  result?: string;
  artifacts?: { stdout?: string };
};

type DaytonaSandboxLike = {
  id?: string;
  process: {
    codeRun: (
      code: string,
      params?: { argv?: string[]; env?: Record<string, string> },
      timeout?: number,
    ) => Promise<DaytonaProcessResultLike>;
    executeCommand: (
      command: string,
      cwd?: string,
      env?: Record<string, string>,
      timeout?: number,
    ) => Promise<DaytonaProcessResultLike>;
  };
  fs?: {
    uploadFiles?: (files: Array<{ source: Buffer; destination: string }>) => Promise<void>;
  };
  delete?: (timeout?: number) => Promise<void>;
};

type DaytonaClientLike = {
  create: (
    params?: {
      language?: DaytonaLanguage;
      ephemeral?: boolean;
      autoStopInterval?: number;
      envVars?: Record<string, string>;
    },
    options?: { timeout?: number },
  ) => Promise<DaytonaSandboxLike>;
  get?: (idOrName: string) => Promise<DaytonaSandboxLike>;
  delete?: (sandbox: DaytonaSandboxLike, timeout?: number) => Promise<void>;
};

function rawEncryptionSecret(): string {
  return (
    process.env.PROVIDER_SECRET_KEY ||
    env.github?.tokenEncryptionKey ||
    process.env.GITHUB_TOKEN_ENCRYPTION_KEY ||
    process.env.FIREBASE_PRIVATE_KEY ||
    ""
  ).trim();
}

export function canEncryptDaytonaSecret(): boolean {
  const raw = rawEncryptionSecret();
  return raw.length >= 16 && !raw.includes("replace-with");
}

function encryptionKey(): Buffer {
  const raw = rawEncryptionSecret();
  if (!canEncryptDaytonaSecret()) throw new Error("DAYTONA_SECRET_KEY_MISSING");
  return createHash("sha256").update(raw).digest();
}

export function encryptDaytonaKey(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((part) => part.toString("base64url")).join(".");
}

export function decryptDaytonaKey(encoded: string): string {
  const [ivRaw, tagRaw, encryptedRaw] = encoded.split(".");
  if (!ivRaw || !tagRaw || !encryptedRaw) throw new Error("DAYTONA_KEY_INVALID");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivRaw, "base64url"));
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedRaw, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function maskKey(apiKey: string): { last4: string; mask: string } {
  const last4 = apiKey.slice(-4);
  const prefix = apiKey.startsWith("dtn_") ? "dtn_" : `${apiKey.slice(0, 3)}`;
  return { last4, mask: `${prefix}***${last4}` };
}

export function validDaytonaApiKey(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 16 || trimmed.length > 256 || /\s/.test(trimmed)) return false;
  if (/replace-with|your-|example/i.test(trimmed)) return false;
  return true;
}

function validTarget(target: string | undefined): string {
  const cleaned = (target ?? "").trim().slice(0, 48);
  if (!cleaned) return "";
  if (!/^[a-zA-Z0-9._-]+$/.test(cleaned)) throw new Error("DAYTONA_TARGET_INVALID");
  return cleaned;
}

/**
 * Resolve Daytona SDK client across both `@daytona/sdk` 2.x (`daytona.v0`) and
 * 0.x / direct-instance mocks (`daytona.create`).
 */
function openDaytonaSdk(apiKey: string, target?: string): {
  client: DaytonaClientLike;
  close: () => Promise<void>;
} {
  const daytona = new Daytona({
    apiKey,
    ...(target ? { target } : {}),
  });
  const root = daytona as unknown as Record<string, unknown>;
  const client = (Reflect.has(daytona as object, "create") ? root : (daytona.v0 as unknown)) as DaytonaClientLike;
  return {
    client,
    close: async () => {
      if (typeof daytona.close === "function") {
        await daytona.close().catch(() => {});
      }
    },
  };
}

export async function resolveDaytonaCredentials(uid?: string | null): Promise<{
  apiKey: string;
  target: string;
  source: "user" | "system" | "env";
} | null> {
  if (uid && canEncryptDaytonaSecret()) {
    try {
      const snap = await adminDb().collection(CONNECTIONS).doc(uid).get();
      if (snap.exists && snap.data()?.api_key_encrypted) {
        const apiKey = decryptDaytonaKey(String(snap.data()!.api_key_encrypted));
        if (validDaytonaApiKey(apiKey)) {
          return {
            apiKey,
            target: String(snap.data()?.target ?? ""),
            source: "user",
          };
        }
      }
    } catch {
      // Fall through to system / env configuration.
    }
  }

  if (canEncryptDaytonaSecret()) {
    try {
      const sys = await adminDb().collection("system_settings").doc(SYSTEM_DOC).get();
      if (sys.exists && sys.data()?.api_key_encrypted) {
        const apiKey = decryptDaytonaKey(String(sys.data()!.api_key_encrypted));
        if (validDaytonaApiKey(apiKey)) {
          return {
            apiKey,
            target: String(sys.data()?.target ?? ""),
            source: "system",
          };
        }
      }
    } catch {
      // Fall through to env configuration.
    }
  }

  if (isDaytonaConfigured()) {
    const cfg = daytonaConfig();
    return {
      apiKey: cfg.apiKey,
      target: cfg.target,
      source: "env",
    };
  }

  return null;
}

export async function getDaytonaStatus(uid?: string | null): Promise<DaytonaStatus> {
  const resolved = await resolveDaytonaCredentials(uid);
  if (!resolved) {
    return {
      configured: false,
      encryptionAvailable: canEncryptDaytonaSecret(),
      source: "none",
      keyLast4: null,
      keyMask: null,
      target: daytonaConfig().target,
      sdk: "@daytona/sdk",
    };
  }
  const masked = maskKey(resolved.apiKey);
  return {
    configured: true,
    encryptionAvailable: canEncryptDaytonaSecret(),
    source: resolved.source,
    keyLast4: masked.last4,
    keyMask: masked.mask,
    target: resolved.target,
    sdk: "@daytona/sdk",
  };
}

export async function saveDaytonaConnection(
  uid: string,
  input: { apiKey: string; target?: string; scope?: "user" | "system" },
): Promise<DaytonaStatus> {
  const apiKey = input.apiKey.trim();
  if (!validDaytonaApiKey(apiKey)) throw new Error("DAYTONA_KEY_INVALID");
  const target = validTarget(input.target);
  const encrypted = encryptDaytonaKey(apiKey);
  const masked = maskKey(apiKey);

  if (input.scope === "system") {
    await adminDb().collection("system_settings").doc(SYSTEM_DOC).set({
      api_key_encrypted: encrypted,
      key_last4: masked.last4,
      key_mask: masked.mask,
      target,
      updated_by: uid,
      updated_at: nowTs(),
    }, { merge: true });
  } else {
    await adminDb().collection(CONNECTIONS).doc(uid).set({
      user_id: uid,
      api_key_encrypted: encrypted,
      key_last4: masked.last4,
      key_mask: masked.mask,
      target,
      updated_at: nowTs(),
    }, { merge: true });
  }
  return getDaytonaStatus(uid);
}

export async function deleteDaytonaConnection(uid: string): Promise<DaytonaStatus> {
  await adminDb().collection(CONNECTIONS).doc(uid).delete();
  return getDaytonaStatus(uid);
}

function sanitizeOutput(text: string, apiKey: string): string {
  const withoutKey = apiKey ? text.split(apiKey).join("[REDACTED_DAYTONA_KEY]") : text;
  return scrubSecrets(withoutKey);
}

function normalizeWorkspaceFiles(files?: DaytonaWorkspaceFile[]): Array<{ source: Buffer; destination: string }> {
  if (!files?.length) return [];
  const uploads: Array<{ source: Buffer; destination: string }> = [];
  let totalBytes = 0;
  for (const raw of files.slice(0, 40)) {
    const cleanPath = safeAgentPath(raw.path);
    if (!cleanPath) continue;
    const buf = Buffer.from(raw.content ?? "", "utf8");
    if (buf.byteLength > 300_000) continue;
    totalBytes += buf.byteLength;
    if (totalBytes > 700_000) break;
    uploads.push({ source: buf, destination: cleanPath });
  }
  return uploads;
}

export async function runDaytonaCode(
  uid: string,
  input: {
    code: string;
    language?: DaytonaLanguage;
    projectFiles?: DaytonaWorkspaceFile[];
    timeoutSeconds?: number;
  },
): Promise<DaytonaRunResult> {
  const code = input.code ?? "";
  if (!code.trim() || Buffer.byteLength(code, "utf8") > 100_000) {
    throw new Error("DAYTONA_CODE_INVALID");
  }
  const language: DaytonaLanguage =
    input.language === "python" || input.language === "javascript" ? input.language : "typescript";
  const timeoutSeconds = Math.min(Math.max(Math.round(input.timeoutSeconds ?? 30), 1), 60);

  const creds = await resolveDaytonaCredentials(uid);
  if (!creds) throw new Error("DAYTONA_NOT_CONFIGURED");

  const startedAt = Date.now();
  const { client, close } = openDaytonaSdk(creds.apiKey, creds.target);
  let sandbox: DaytonaSandboxLike | null = null;

  try {
    sandbox = await client.create(
      {
        language,
        ephemeral: true,
        autoStopInterval: 15,
      },
      { timeout: 45 },
    );

    const uploads = normalizeWorkspaceFiles(input.projectFiles);
    if (uploads.length > 0 && typeof sandbox.fs?.uploadFiles === "function") {
      await sandbox.fs.uploadFiles(uploads);
    }

    const response = await sandbox.process.codeRun(code, undefined, timeoutSeconds);
    const rawResult = typeof response?.result === "string" ? response.result : "";
    const rawStdout = typeof response?.artifacts?.stdout === "string" ? response.artifacts.stdout : rawResult;

    return {
      exitCode: typeof response?.exitCode === "number" ? response.exitCode : 0,
      result: sanitizeOutput(rawResult, creds.apiKey),
      stdout: sanitizeOutput(rawStdout, creds.apiKey),
      sandboxId: String(sandbox.id ?? "daytona-ephemeral"),
      language,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    if (sandbox) {
      if (typeof client.delete === "function") {
        await client.delete(sandbox, 15).catch(() => {});
      } else if (typeof sandbox.delete === "function") {
        await sandbox.delete(15).catch(() => {});
      }
    }
    await close();
  }
}

export async function runDaytonaCommand(
  uid: string,
  input: {
    command: string;
    cwd?: string;
    projectFiles?: DaytonaWorkspaceFile[];
    timeoutSeconds?: number;
  },
): Promise<DaytonaRunResult> {
  const command = (input.command ?? "").trim();
  if (!command || command.length > 4_000) {
    throw new Error("DAYTONA_COMMAND_INVALID");
  }
  const timeoutSeconds = Math.min(Math.max(Math.round(input.timeoutSeconds ?? 30), 1), 60);
  const creds = await resolveDaytonaCredentials(uid);
  if (!creds) throw new Error("DAYTONA_NOT_CONFIGURED");

  const startedAt = Date.now();
  const { client, close } = openDaytonaSdk(creds.apiKey, creds.target);
  let sandbox: DaytonaSandboxLike | null = null;

  try {
    sandbox = await client.create(
      {
        language: "typescript",
        ephemeral: true,
        autoStopInterval: 15,
      },
      { timeout: 45 },
    );

    const uploads = normalizeWorkspaceFiles(input.projectFiles);
    if (uploads.length > 0 && typeof sandbox.fs?.uploadFiles === "function") {
      await sandbox.fs.uploadFiles(uploads);
    }

    const safeCwd = input.cwd ? safeAgentPath(input.cwd) ?? undefined : undefined;
    const response = await sandbox.process.executeCommand(command, safeCwd, undefined, timeoutSeconds);
    const rawResult = typeof response?.result === "string" ? response.result : "";
    const rawStdout = typeof response?.artifacts?.stdout === "string" ? response.artifacts.stdout : rawResult;

    return {
      exitCode: typeof response?.exitCode === "number" ? response.exitCode : 0,
      result: sanitizeOutput(rawResult, creds.apiKey),
      stdout: sanitizeOutput(rawStdout, creds.apiKey),
      sandboxId: String(sandbox.id ?? "daytona-ephemeral"),
      language: "typescript",
      durationMs: Date.now() - startedAt,
    };
  } finally {
    if (sandbox) {
      if (typeof client.delete === "function") {
        await client.delete(sandbox, 15).catch(() => {});
      } else if (typeof sandbox.delete === "function") {
        await sandbox.delete(15).catch(() => {});
      }
    }
    await close();
  }
}

export class DaytonaExecutionGateway implements ExecutionGateway {
  readonly name = "daytona-cloud";

  async acquire(input: { sessionId: string; projectId: string | null }): Promise<{ handle: string }> {
    const creds = await resolveDaytonaCredentials(null);
    if (!creds) return { handle: `inline:${input.sessionId}` };
    const { client, close } = openDaytonaSdk(creds.apiKey, creds.target);
    try {
      const sandbox = await client.create(
        { language: "typescript", ephemeral: true, autoStopInterval: 15 },
        { timeout: 45 },
      );
      return { handle: sandbox.id ? `daytona:${sandbox.id}` : `inline:${input.sessionId}` };
    } finally {
      await close();
    }
  }

  async release(handle: string): Promise<void> {
    if (!handle.startsWith("daytona:")) return;
    const sandboxId = handle.slice("daytona:".length);
    if (!sandboxId) return;
    const creds = await resolveDaytonaCredentials(null);
    if (!creds) return;
    const { client, close } = openDaytonaSdk(creds.apiKey, creds.target);
    try {
      if (typeof client.get === "function") {
        const sandbox = await client.get(sandboxId).catch(() => null);
        if (sandbox) {
          if (typeof client.delete === "function") {
            await client.delete(sandbox, 15).catch(() => {});
          } else if (typeof sandbox.delete === "function") {
            await sandbox.delete(15).catch(() => {});
          }
        }
      }
    } finally {
      await close();
    }
  }
}
