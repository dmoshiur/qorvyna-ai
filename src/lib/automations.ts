// =============================================================================
// QORVYNA AI — Automations: shared model (client-safe, no server imports).
//
// An automation = trigger + ordered actions. Actions reference REGISTERED
// tool ids from the unified tool registry; execution always goes through the
// guarded gateway (authorize → validate → audit). Only LOW-risk tools may run
// automatically; anything riskier requires an explicit approval per run.
// =============================================================================

export const AUTOMATION_TRIGGERS = ["schedule", "event", "manual"] as const;
export type AutomationTrigger = (typeof AUTOMATION_TRIGGERS)[number];

export const SCHEDULE_PRESETS = ["hourly", "daily", "weekly"] as const;
export type SchedulePreset = (typeof SCHEDULE_PRESETS)[number];

export const AUTOMATION_STATUSES = ["active", "paused", "disabled"] as const;
export type AutomationStatus = (typeof AUTOMATION_STATUSES)[number];

export type AutomationAction = {
  tool: string; // registry tool id
  args?: Record<string, unknown>;
};

export type Automation = {
  id: string;
  user_id: string;
  name: string;
  description: string;
  trigger: AutomationTrigger;
  schedule: SchedulePreset | null;
  actions: AutomationAction[];
  status: AutomationStatus;
  last_run_at: string | null;
  last_run_ok: boolean | null;
  run_count: number;
  created_at: string;
  updated_at: string;
  time?: string;
  timezone?: string;
  next_run_at?: string | null;
};

export function isAutomationTrigger(value: unknown): value is AutomationTrigger {
  return typeof value === "string" && (AUTOMATION_TRIGGERS as readonly string[]).includes(value);
}
export function isSchedulePreset(value: unknown): value is SchedulePreset {
  return typeof value === "string" && (SCHEDULE_PRESETS as readonly string[]).includes(value);
}
export function isAutomationStatus(value: unknown): value is AutomationStatus {
  return typeof value === "string" && (AUTOMATION_STATUSES as readonly string[]).includes(value);
}

/**
 * Enforce a human-readable automation name (review P2-6): non-empty, within
 * bounds, contains at least one letter, and not a bare machine id such as
 * "fsdhnf:KJA". Names are the primary label on the Automations surface, so a
 * random token must not be persisted as a first-class card.
 */
export function validateAutomationName(raw: string): string {
  const name = raw.trim().replace(/\s+/g, " ");
  if (name.length < 2 || name.length > 80) {
    throw new Error("Automation name must be 2–80 characters.");
  }
  if (!/[A-Za-z]/.test(name)) {
    throw new Error("Automation name must contain at least one letter.");
  }
  // Reject machine-id style names: a short lowercase/digit prefix followed by
  // a colon and a short uppercase or hex suffix (e.g. "fsdhnf:KJA").
  if (/^[a-z0-9]{2,8}:(?:[A-Z0-9]{2,8}|[a-f0-9]{2,8})$/.test(name)) {
    throw new Error("Automation name looks like a machine id — use a readable name.");
  }
  return name;
}

export const MAX_AUTOMATION_ACTIONS = 5;
export const MAX_AUTOMATION_NAME = 80;

/** Validate the action list shape (tool ids are checked against the registry server-side). */
export function validateAutomationActions(actions: unknown): AutomationAction[] {
  if (!Array.isArray(actions) || actions.length === 0) throw new Error("ACTIONS_REQUIRED");
  if (actions.length > MAX_AUTOMATION_ACTIONS) throw new Error("TOO_MANY_ACTIONS");
  return actions.map((a) => {
    if (typeof a !== "object" || a === null) throw new Error("ACTION_INVALID");
    const tool = (a as Record<string, unknown>).tool;
    if (typeof tool !== "string" || !/^[a-z][a-z0-9_.]{2,63}$/.test(tool)) throw new Error("ACTION_TOOL_INVALID");
    const args = (a as Record<string, unknown>).args;
    if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) throw new Error("ACTION_ARGS_INVALID");
    return { tool, args: (args as Record<string, unknown>) ?? {} };
  });
}
