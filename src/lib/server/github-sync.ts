// =============================================================================
// QORVYNA AI — GitHub App installation inspection, upstream grant revocation,
// branch listing, and conflict-aware 3-way sync preview.
//
// Additive extension over src/lib/server/github.ts — never overwrites local
// project files without explicit revision-checked import, and fails closed on
// binary or unsafe paths.
// =============================================================================

import "server-only";
import { createHash } from "node:crypto";
import { env, isGithubConfigured } from "@/lib/env";
import { safeAgentPath } from "@/lib/ai/agent";
import {
  checkedTarget,
  deleteGithubConnection,
  githubRequest,
  githubTokenForServer,
} from "@/lib/server/github";

export type SyncFileStatus =
  | "identical"
  | "modified_remote"
  | "modified_local"
  | "conflict"
  | "added_remote"
  | "added_local"
  | "deleted_remote";

export type SyncEntry = {
  path: string;
  status: SyncFileStatus;
  localSha256: string | null;
  remoteSha256: string | null;
  baseSha256: string | null;
};

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Pure 3-way sync classifier (local workspace vs optional last-synced base vs remote snapshot). */
export function classifyThreeWaySync(input: {
  local: Array<{ path: string; content: string }>;
  remote: Array<{ path: string; content: string }>;
  base?: Array<{ path: string; content: string }> | null;
}): {
  entries: SyncEntry[];
  hasConflicts: boolean;
  summary: Record<SyncFileStatus, number>;
} {
  const localMap = new Map<string, string>();
  const remoteMap = new Map<string, string>();
  const baseMap = new Map<string, string>();

  for (const f of input.local) {
    const p = safeAgentPath(f.path);
    if (p) localMap.set(p, f.content);
  }
  for (const f of input.remote) {
    const p = safeAgentPath(f.path);
    if (p) remoteMap.set(p, f.content);
  }
  for (const f of input.base ?? []) {
    const p = safeAgentPath(f.path);
    if (p) baseMap.set(p, f.content);
  }

  const allPaths = [...new Set([...localMap.keys(), ...remoteMap.keys(), ...baseMap.keys()])].sort();
  const summary: Record<SyncFileStatus, number> = {
    identical: 0,
    modified_remote: 0,
    modified_local: 0,
    conflict: 0,
    added_remote: 0,
    added_local: 0,
    deleted_remote: 0,
  };
  const entries: SyncEntry[] = [];
  const hasBase = input.base != null && input.base.length > 0;

  for (const path of allPaths) {
    const l = localMap.has(path) ? sha256(localMap.get(path)!) : null;
    const r = remoteMap.has(path) ? sha256(remoteMap.get(path)!) : null;
    const b = baseMap.has(path) ? sha256(baseMap.get(path)!) : null;

    let status: SyncFileStatus;
    if (l && r && l === r) {
      status = "identical";
    } else if (!l && r) {
      status = hasBase && b === r ? "deleted_remote" : "added_remote";
    } else if (l && !r) {
      status = hasBase && b === l ? "deleted_remote" : "added_local";
    } else if (hasBase && b) {
      if (l === b && r !== b) status = "modified_remote";
      else if (r === b && l !== b) status = "modified_local";
      else status = "conflict";
    } else {
      // Without a common ancestor, differing non-empty files are treated conservatively as a conflict.
      status = "conflict";
    }

    summary[status] += 1;
    entries.push({ path, status, localSha256: l, remoteSha256: r, baseSha256: b });
  }

  return {
    entries,
    hasConflicts: summary.conflict > 0,
    summary,
  };
}

export async function listGithubBranches(uid: string, repository: string) {
  checkedTarget(repository, "main");
  const rows = await githubRequest<Array<{ name?: string; commit?: { sha?: string }; protected?: boolean }>>(
    uid,
    `/repos/${repository}/branches?per_page=50`,
  );
  if (!Array.isArray(rows)) throw new Error("GITHUB_RESPONSE_INVALID");
  return rows
    .filter((b) => typeof b.name === "string" && b.name.length > 0 && /^[a-f0-9]{40}$/i.test(b.commit?.sha ?? ""))
    .map((b) => ({
      name: b.name!.slice(0, 180),
      headSha: b.commit!.sha!,
      protected: Boolean(b.protected),
    }));
}

export async function listGithubAppInstallations(uid: string) {
  try {
    const res = await githubRequest<{
      total_count?: number;
      installations?: Array<{ id?: number; app_slug?: string; account?: { login?: string; type?: string }; repository_selection?: string }>;
    }>(uid, "/user/installations?per_page=30");
    const list = Array.isArray(res?.installations) ? res.installations : [];
    return {
      supported: true,
      installations: list
        .filter((i) => typeof i.id === "number")
        .map((i) => ({
          id: i.id!,
          appSlug: String(i.app_slug ?? ""),
          accountLogin: String(i.account?.login ?? ""),
          accountType: String(i.account?.type ?? ""),
          repositorySelection: String(i.repository_selection ?? "selected"),
        })),
    };
  } catch {
    // Classic OAuth tokens without user-to-server GitHub App scope return 403/404; report honestly.
    return { supported: false, installations: [] };
  }
}

/**
 * Revoke the upstream OAuth grant at GitHub (when client credentials exist) and
 * remove the local encrypted token record. Never logs secrets.
 */
export async function revokeGithubGrantAndDisconnect(uid: string): Promise<{
  disconnected: boolean;
  upstreamRevoked: boolean;
}> {
  let upstreamRevoked = false;
  if (isGithubConfigured()) {
    try {
      const token = await githubTokenForServer(uid);
      const basic = Buffer.from(`${env.github.clientId}:${env.github.clientSecret}`, "utf8").toString("base64");
      const res = await fetch(`https://api.github.com/applications/${encodeURIComponent(env.github.clientId)}/token`, {
        method: "DELETE",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Basic ${basic}`,
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({ access_token: token }),
        signal: AbortSignal.timeout(10_000),
      });
      upstreamRevoked = res.status === 204 || res.status === 404;
    } catch {
      upstreamRevoked = false;
    }
  }
  await deleteGithubConnection(uid);
  return { disconnected: true, upstreamRevoked };
}
