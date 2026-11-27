// Pure, client-safe helpers for recognising a GitHub repository URL.
//
// Kept free of server-only imports so the chat UI, the Agent tool and the
// server-side clone all agree on what counts as a repo URL and how it is
// normalised to a clone URL.

export type ParsedRepoUrl = {
  owner: string;
  repo: string;
  /** HTTPS clone URL — the only form the server-side clone accepts. */
  cloneUrl: string;
  htmlUrl: string;
};

// The repo segment may end at a path separator, a query/fragment, or any
// character that naturally ends a URL inside prose (space, comma, quote,
// bracket). Requiring only [/?#] would miss "see https://github.com/o/r now".
const GITHUB_RE = /github\.com[:\/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[/?#]|[\s,;:!?)'"\]]|$)/i;

function cleanSegment(value: string): string | null {
  const cleaned = value.replace(/\.git$/i, "");
  if (!cleaned || cleaned === "." || cleaned === ".." || !/^[A-Za-z0-9_.-]+$/.test(cleaned)) return null;
  return cleaned;
}

/** Parse the first GitHub repository URL in `input`, or return null. */
export function parseRepoUrl(input: string): ParsedRepoUrl | null {
  const match = GITHUB_RE.exec(input ?? "");
  if (!match) return null;
  const owner = cleanSegment(match[1]);
  const repo = cleanSegment(match[2]);
  if (!owner || !repo) return null;
  return {
    owner,
    repo,
    cloneUrl: `https://github.com/${owner}/${repo}.git`,
    htmlUrl: `https://github.com/${owner}/${repo}`,
  };
}

/** Find the first GitHub repository URL anywhere in `text`. */
export function findRepoUrl(text: string): ParsedRepoUrl | null {
  return parseRepoUrl(text ?? "");
}

/** True when the text mentions importing, cloning or copying a repository. */
export function hasRepoImportIntent(text: string): boolean {
  return /(?:import|clone|copy|pull|fetch|bring in|grab|check out)\b/i.test(text ?? "");
}

/** True when the text both names a repo and asks for it to be brought in. */
export function isRepoImportRequest(text: string): boolean {
  return Boolean(findRepoUrl(text)) && hasRepoImportIntent(text);
}
