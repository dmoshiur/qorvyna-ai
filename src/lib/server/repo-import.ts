import "server-only";

// =============================================================================
// Governed "import this repository" flow (Issue 6).
//
// The server clones a GitHub repository into a temporary directory, checks it
// against hard size/file limits, materialises the files into a QORVYNA project
// workspace, and removes every temporary artefact afterwards. It is the single
// implementation used by:
//   • the "Import from GitHub repo" entry point in Workspace → Projects,
//   • the `import_repo` Agent tool,
//   • the "Import this repo as a new project" action on a blocked card.
//
// Rules:
//   • PUBLIC repos clone anonymously — no GitHub connection required.
//   • PRIVATE repos use the user's already-connected, encrypted GitHub token,
//     resolved server-side only. The token never reaches the model, the client
//     or any log; it is passed to git through an environment variable, not argv.
//   • A repo over the size/file limits is refused before anything is written —
//     there is never a partial import.
//   • The temporary clone directory is always deleted.
// =============================================================================

import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import type { Db } from "@/lib/firebase/admin";
import type { SessionUser } from "@/lib/firebase/session";
import { RpcError } from "@/lib/server/errors";
import { applyProjectFiles, ensureProject } from "@/lib/server/projects";
import { githubTokenForServer } from "@/lib/server/github";
import { PROJECT_LIMITS, isTextPath, withLanguage, type ProjectFile } from "@/lib/projects/paths";
import { parseRepoUrl, type ParsedRepoUrl } from "@/lib/repo-url";
import { safeAgentPath } from "@/lib/ai/agent";

/** Hard ceiling for a single import (bytes on disk after clone). */
const MAX_IMPORT_BYTES = 100 * 1024 * 1024;
/** Repo-level file-count guard. */
const MAX_IMPORT_FILES = 2_000;
/** How long a single clone may run before it is killed and cleaned up. */
const CLONE_TIMEOUT_MS = 120_000;

export type ImportRepoResult = {
  projectId: string;
  title: string;
  fileCount: number;
  bytes: number;
  elapsedMs: number;
  repo: { owner: string; name: string; htmlUrl: string };
  /** Whether a GitHub token was used (private import). */
  private: boolean;
};

type Access = { token: string | null };

/**
 * Decide whether the clone needs the user's token. With a connected GitHub
 * account the token is used (it works for public and private repos). Without
 * one, a public repo is probed anonymously; a private (or unknown) repo yields
 * GITHUB_NOT_CONNECTED so the UI can show the Connect GitHub panel.
 */
async function resolveGithubAccess(uid: string, parsed: ParsedRepoUrl): Promise<Access> {
  const token = await githubTokenForServer(uid).catch(() => null);
  if (token) return { token };

  try {
    const response = await fetch(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "QORVYNA-AI",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
      redirect: "error",
    });
    // Free the body so the connection is not held open.
    await response.body?.cancel().catch(() => {});
    if (response.status === 200) return { token: null };
    if (response.status === 404) {
      throw new RpcError(
        "GITHUB_NOT_CONNECTED",
        409,
        "This repository is private or requires GitHub access. Connect GitHub to import it.",
      );
    }
    throw new RpcError("REPO_UNAVAILABLE", 502, "The repository could not be checked right now. Try again.");
  } catch (error) {
    if (error instanceof RpcError) throw error;
    throw new RpcError("REPO_UNAVAILABLE", 502, "The repository could not be reached. Try again.");
  }
}

/** Clone the repository into a fresh temp directory. Always cleans up on failure. */
async function cloneRepo(parsed: ParsedRepoUrl, token: string | null): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "qorvyna-repo-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  // Pass the token through git config env vars, never through argv — argv can
  // appear in process listings and error logs.
  if (token) {
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = "http.extraheader";
    env.GIT_CONFIG_VALUE_0 = `Authorization: Bearer ${token}`;
  }
  try {
    await new Promise<void>((resolve, reject) => {
      execFile(
        "git",
        ["clone", "--depth", "1", "--no-tags", "--single-branch", "--quiet", parsed.cloneUrl, dir],
        { env, timeout: CLONE_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
        (error, _stdout, stderr) => {
          if (error) {
            const detail = String(stderr ?? error.message).slice(0, 200);
            reject(new RpcError("REPO_CLONE_FAILED", 502, `The repository could not be cloned. ${detail}`));
            return;
          }
          resolve();
        },
      );
    });
  } catch (error) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return dir;
}

type CollectedFile = { path: string; abs: string };

/** Walk the clone, enforcing the hard limits. Throws before any file is read. */
async function collectFiles(root: string): Promise<{ files: CollectedFile[]; bytes: number }> {
  const files: CollectedFile[] = [];
  let bytes = 0;
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      let size = 0;
      try {
        size = (await stat(abs)).size;
      } catch {
        continue;
      }
      bytes += size;
      if (bytes > MAX_IMPORT_BYTES) throw new RpcError("REPO_TOO_LARGE", 400, "This repository is larger than the 100 MB import limit.");
      files.push({ path: relative(root, abs).split(sep).join("/"), abs });
      if (files.length > MAX_IMPORT_FILES) throw new RpcError("REPO_TOO_MANY_FILES", 400, "This repository has more than 2,000 files and cannot be imported.");
    }
  };
  await walk(root);
  return { files, bytes };
}

function isBinary(path: string): boolean {
  return !isTextPath(path);
}

/**
 * Import a GitHub repository into a project workspace. Creates a new project
 * when `targetProjectId` is absent (optionally bound to a conversation); writes
 * the files into an existing project when it is supplied.
 */
export async function importRepoToProject(
  d: Db,
  user: SessionUser,
  input: { repoUrl: string; targetProjectId?: string | null; title?: string; conversationId?: string | null },
): Promise<ImportRepoResult> {
  const started = Date.now();
  const parsed = parseRepoUrl(input.repoUrl ?? "");
  if (!parsed) {
    throw new RpcError("REPO_URL_INVALID", 400, "Enter a valid GitHub repository URL (https://github.com/owner/repo).");
  }

  const access = await resolveGithubAccess(user.uid, parsed);
  const dir = await cloneRepo(parsed, access.token);

  try {
    const { files: collected } = await collectFiles(dir);
    if (collected.length === 0) {
      throw new RpcError("REPO_EMPTY", 400, "This repository has no importable files.");
    }
    if (collected.length > PROJECT_LIMITS.maxFilesPerProject) {
      throw new RpcError(
        "REPO_TOO_MANY_FILES",
        400,
        `This repository has ${collected.length} files; a QORVYNA project workspace holds at most ${PROJECT_LIMITS.maxFilesPerProject}. Import a smaller repository or select a subset.`,
      );
    }

    const projectFiles: ProjectFile[] = [];
    let bytes = 0;
    for (const file of collected) {
      // Normalise through the same path guard the file editor uses.
      const safe = safeAgentPath(file.path);
      if (!safe) continue;
      try {
        if (isBinary(safe)) {
          const buffer = await readFile(file.abs);
          if (buffer.byteLength > PROJECT_LIMITS.maxImageBytes) continue;
          bytes += buffer.byteLength;
          projectFiles.push({ path: safe, content: buffer.toString("base64"), language: withLanguage({ path: safe, content: "", encoding: "base64" }).language, encoding: "base64" });
        } else {
          const text = await readFile(file.abs, "utf8");
          const encoded = Buffer.byteLength(text, "utf8");
          if (encoded > PROJECT_LIMITS.maxTextBytes) continue;
          bytes += encoded;
          projectFiles.push({ path: safe, content: text, language: withLanguage({ path: safe, content: text, encoding: "utf8" }).language, encoding: "utf8" });
        }
      } catch {
        // An unreadable file is skipped rather than failing the whole import.
        continue;
      }
    }

    if (projectFiles.length === 0) {
      throw new RpcError("REPO_EMPTY", 400, "This repository has no files QORVYNA can store in a project.");
    }

    const title = (input.title?.trim() || `${parsed.repo} — imported from GitHub`).slice(0, 80);
    let project: { id: string };
    if (input.targetProjectId) {
      project = { id: input.targetProjectId };
    } else {
      const created = await ensureProject(d, user, {
        conversation_id: input.conversationId ?? null,
        title,
      });
      project = { id: created.id };
    }

    await applyProjectFiles(d, user, {
      project_id: project.id,
      files: projectFiles,
      source: "import",
      ...(input.targetProjectId ? {} : { title }),
    });

    return {
      projectId: project.id,
      title,
      fileCount: projectFiles.length,
      bytes,
      elapsedMs: Date.now() - started,
      repo: { owner: parsed.owner, name: parsed.repo, htmlUrl: parsed.htmlUrl },
      private: Boolean(access.token),
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
