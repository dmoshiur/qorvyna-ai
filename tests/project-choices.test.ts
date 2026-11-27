// =============================================================================
// Issue 6 — project picker helpers: de-duplication and row formatting.
// =============================================================================

import { describe, expect, it } from "vitest";
import { dedupeProjectChoices, formatProjectUpdated, type ProjectChoice } from "@/lib/projects/choices";

function choice(id: string, title: string, updatedAt: string): ProjectChoice {
  return { id, title, stack: "React", updated_at: updatedAt, file_count: 12 };
}

describe("dedupeProjectChoices", () => {
  it("keeps one entry per id and prefers the most recently updated", () => {
    const older = choice("p1", "Old name", "2026-11-01T00:00:00.000Z");
    const newer = choice("p1", "New name", "2026-11-20T00:00:00.000Z");
    const second = choice("p2", "Second", "2026-11-02T00:00:00.000Z");

    const result = dedupeProjectChoices([older, second, newer]);
    expect(result.map((item) => item.id)).toEqual(["p1", "p2"]);
    expect(result[0].title).toBe("New name");
  });

  it("is stable for an already unique list", () => {
    const list = [choice("p1", "A", "2026-11-01T00:00:00.000Z"), choice("p2", "B", "2026-11-02T00:00:00.000Z")];
    expect(dedupeProjectChoices(list)).toEqual(list);
  });
});

describe("formatProjectUpdated", () => {
  it("renders a relative time for recent updates", () => {
    const now = new Date().toISOString();
    expect(formatProjectUpdated(now)).toBe("just now");
  });

  it("renders days in the recent range and a date beyond it", () => {
    const twoDays = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    expect(formatProjectUpdated(twoDays)).toBe("2 days ago");
    const longAgo = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    expect(formatProjectUpdated(longAgo)).toBe(new Date(longAgo).toLocaleDateString());
  });

  it("returns empty for a value that is not a date", () => {
    expect(formatProjectUpdated("")).toBe("");
    expect(formatProjectUpdated("not-a-date")).toBe("");
  });
});
