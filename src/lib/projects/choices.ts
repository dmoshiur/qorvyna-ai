// Pure helpers behind the project picker (Issue 6).
//
// Kept free of React/server imports so the picker's de-duplication and row
// formatting can be unit-tested and reused without a component.

/** A project offered by the picker: real name, type and update time. */
export type ProjectChoice = {
  id: string;
  title: string;
  stack: string;
  updated_at: string;
  file_count: number;
};

/**
 * De-duplicate by id and keep the most recently updated of any duplicates, so
 * the picker never offers the same project twice.
 */
export function dedupeProjectChoices(list: ProjectChoice[]): ProjectChoice[] {
  const byId = new Map<string, ProjectChoice>();
  for (const item of list) {
    const prev = byId.get(item.id);
    if (!prev || String(item.updated_at) > String(prev.updated_at)) byId.set(item.id, item);
  }
  return [...byId.values()];
}

/** Compact relative update time for a picker row, or "" when not a date. */
export function formatProjectUpdated(value: string): string {
  const then = new Date(value).getTime();
  if (!Number.isFinite(then)) return "";
  const sec = Math.round((Date.now() - then) / 1000);
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day} day${day === 1 ? "" : "s"} ago`;
  return new Date(value).toLocaleDateString();
}
