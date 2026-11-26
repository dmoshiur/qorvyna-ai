// Next-run scheduling (review P0-2): an automation must never advertise a
// next-run timestamp in the past, and a run must advance the next occurrence.
import { describe, expect, it } from "vitest";
import { computeNextRunAt } from "@/lib/automation-schedule";

const dailyAsiaDhaka = {
  trigger: "schedule",
  schedule: "daily",
  time: "07:00",
  timezone: "Asia/Dhaka",
  schedule_weekday: 0,
};

describe("computeNextRunAt", () => {
  it("returns a future occurrence strictly after the given instant", () => {
    const after = Date.UTC(2026, 10, 26, 1, 0, 0); // 2026-11-26 01:00 UTC
    const next = computeNextRunAt(dailyAsiaDhaka, after);
    expect(next).not.toBeNull();
    expect(next!.getTime()).toBeGreaterThan(after);
    // 07:00 Asia/Dhaka on 2026-11-26 is 01:00 UTC the same day, so the next
    // daily occurrence is 2026-11-27 07:00 local.
    expect(next!.toISOString().slice(0, 10)).toBe("2026-11-27");
  });

  it("returns null for manual (non-schedule) automations", () => {
    expect(computeNextRunAt({ trigger: "manual", schedule: null }, Date.now())).toBeNull();
  });

  it("never returns a timestamp before the reference instant", () => {
    const after = Date.UTC(2026, 10, 19, 12, 0, 0); // a reference in the past
    const next = computeNextRunAt(dailyAsiaDhaka, after);
    expect(next).not.toBeNull();
    expect(next!.getTime()).toBeGreaterThan(after);
  });
});
