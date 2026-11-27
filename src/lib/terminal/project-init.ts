// =============================================================================
// QORVYNA AI — qsh project-init / root resolution.
//
// Project init has ONE source of truth: the project workspace's stored root.
// This module is the single place that turns a project state into the root the
// terminal (and the rest of the product) operates on.
//
// Invariants:
//   • The project's actual root is always accepted. `/docs` and `/web` are
//     optional conventions, never hard requirements.
//   • A rejection (path traversal, escaping the root, unresolvable project)
//     must name the EXACT offending segment and point at `help` for the
//     project layout — never a vague "not accepted".
// =============================================================================

import { projectRootFor } from "@/lib/projects/paths";

/** Hint appended to every actionable project-init / path error. */
export const PROJECT_INIT_HINT = "Run 'help' for the project layout.";

/**
 * Resolve the virtual root qsh exposes inside the governed workspace.
 *
 * This mirrors the stored workspace root (`projects/<id>/files`) exposed to
 * the terminal as `/workspace/projects/<id>`. It is intentionally the same
 * layout the build pipeline, preview, deploy and publish use — never a
 * hardcoded `/docs` or `/web` allowlist.
 */
export function resolveTerminalProjectRoot(state: { projectId: string }): string {
  const id = state.projectId;
  if (!id || id.includes("/") || id.includes("\\") || id.includes("..")) {
    throw new Error(
      `PROJECT_INIT_ERROR: expected the project root, got '${id || "(empty project id)"}'. ${PROJECT_INIT_HINT}`,
    );
  }
  return `/workspace/projects/${id}`;
}

/** The stored (Firestore) root for a project, shared with the build pipeline. */
export function storedProjectRoot(state: { projectId: string }): string {
  return projectRootFor(state.projectId);
}

/**
 * Format an actionable project-init error that names the exact offending
 * segment, e.g.:
 *   PROJECT_INIT_ERROR: expected the project root, got 'owner'. Run 'help' for the project layout.
 */
export function projectInitError(offending?: string | null): string {
  if (offending) {
    return `PROJECT_INIT_ERROR: expected the project root, got '${offending}'. ${PROJECT_INIT_HINT}`;
  }
  return `PROJECT_INIT_ERROR: the project root could not be resolved. ${PROJECT_INIT_HINT}`;
}

/** Format an actionable path-escape rejection naming the exact offending segment. */
export function pathEscapeError(input: string): string {
  return `PATH_ESCAPE_BLOCKED: expected a path inside the project root, got '${offendingSegmentOfPath(input)}'. ${PROJECT_INIT_HINT}`;
}

/** Extract the first offending path segment, or a descriptive placeholder. */
export function offendingSegmentOfPath(input: string): string {
  const cleaned = input.trim().replace(/\\/g, "/");
  if (cleaned.startsWith("/")) return "(absolute path)";
  const pieces = cleaned.split("/");
  const bad = pieces.find(
    (piece) => !piece || piece === "." || piece === ".." || piece === ".git",
  );
  if (bad) return bad;
  return cleaned || "(empty path)";
}

/** Best-effort extraction of a quoted offending segment from a thrown error. */
export function offendingSegmentFromError(message: string): string | null {
  const quoted = message.match(/'([^']+)'/);
  return quoted ? quoted[1] : null;
}
