// Automation naming discipline (review P2-6): names must be human-readable,
// not bare machine ids like "fsdhnf:KJA".
import { describe, expect, it } from "vitest";
import { validateAutomationName } from "@/lib/automations";

describe("validateAutomationName", () => {
  it("accepts a normal readable name", () => {
    expect(validateAutomationName("Check my devices every morning")).toBe("Check my devices every morning");
    expect(validateAutomationName("  Spaced   out   name  ")).toBe("Spaced out name");
  });

  it("rejects machine-id style names", () => {
    expect(() => validateAutomationName("fsdhnf:KJA")).toThrow(/machine id/i);
    expect(() => validateAutomationName("ab12:34cd")).toThrow(/machine id/i);
  });

  it("rejects names with no letters and out-of-bounds names", () => {
    expect(() => validateAutomationName("12345")).toThrow(/letter/i);
    expect(() => validateAutomationName("a")).toThrow(/2–80/);
    expect(() => validateAutomationName("")).toThrow();
  });
});
