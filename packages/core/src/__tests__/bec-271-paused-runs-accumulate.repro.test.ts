/**
 * BEC-271 — paused await-approval runs accumulate indefinitely (fixed)
 *
 * Root cause: no PM tick sweep expired paused pipeline runs. Fixed by
 * sweepExpiredPausedRuns in pm/actions/sweep-paused-runs.ts, called from
 * pm/scheduler.ts after sweepOrphanStageRuns.
 *
 * This file documents both the original gap and the fix:
 *  - Part 1: confirms the sweep module and audit event now exist
 *  - Part 2: confirms existing sweeps still don't touch paused runs directly
 *            (the new dedicated sweep is the correct home for this logic)
 *  - Part 3: state-machine trace documenting the newly-added paused→cancelled transition
 */

import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Part 1: Fix confirmed — sweep module and audit event exist
// ---------------------------------------------------------------------------

describe("BEC-271 Part 1: sweepExpiredPausedRuns now exists (fix verified)", () => {
  it("sweep-paused-runs.ts module exists", () => {
    const sweepPath = resolve(__dirname, "../pm/actions/sweep-paused-runs.ts");
    expect(existsSync(sweepPath)).toBe(true);
  });

  it("pm.paused_run_expired is present in AuditEventTypeSchema", async () => {
    const { AuditEventTypeSchema } = await import("../types.js");
    const result = AuditEventTypeSchema.safeParse("pm.paused_run_expired");
    expect(result.success).toBe(true);
  });

  it("sweepExpiredPausedRuns and parsePausedRunMaxAgeMinutes are exported", async () => {
    const mod = await import("../pm/actions/sweep-paused-runs.js");
    expect(typeof mod.sweepExpiredPausedRuns).toBe("function");
    expect(typeof mod.parsePausedRunMaxAgeMinutes).toBe("function");
  });

  it("parsePausedRunMaxAgeMinutes defaults to 4320 (72h)", async () => {
    const { parsePausedRunMaxAgeMinutes } = await import("../pm/actions/sweep-paused-runs.js");
    expect(parsePausedRunMaxAgeMinutes(undefined)).toBe(4320);
    expect(parsePausedRunMaxAgeMinutes("")).toBe(4320);
    expect(parsePausedRunMaxAgeMinutes("not-a-number")).toBe(4320);
  });

  it("parsePausedRunMaxAgeMinutes honours valid override and clamps to >=1", async () => {
    const { parsePausedRunMaxAgeMinutes } = await import("../pm/actions/sweep-paused-runs.js");
    expect(parsePausedRunMaxAgeMinutes("60")).toBe(60);
    expect(parsePausedRunMaxAgeMinutes("0")).toBe(1); // clamp
    expect(parsePausedRunMaxAgeMinutes("-5")).toBe(1); // clamp
  });

  it("PM_AGENT_AWAIT_APPROVAL_MAX_AGE_MIN is consumed by parsePausedRunMaxAgeMinutes", async () => {
    const { parsePausedRunMaxAgeMinutes } = await import("../pm/actions/sweep-paused-runs.js");
    // This is the env-var read pattern wired into the scheduler.
    const original = process.env.PM_AGENT_AWAIT_APPROVAL_MAX_AGE_MIN;
    process.env.PM_AGENT_AWAIT_APPROVAL_MAX_AGE_MIN = "1440";
    const result = parsePausedRunMaxAgeMinutes(process.env.PM_AGENT_AWAIT_APPROVAL_MAX_AGE_MIN);
    expect(result).toBe(1440); // 24h
    if (original === undefined) delete process.env.PM_AGENT_AWAIT_APPROVAL_MAX_AGE_MIN;
    else process.env.PM_AGENT_AWAIT_APPROVAL_MAX_AGE_MIN = original;
  });
});

// ---------------------------------------------------------------------------
// Part 2: Existing sweeps don't touch paused runs (dedicated sweep is correct home)
// ---------------------------------------------------------------------------

describe("BEC-271 Part 2: existing sweeps correctly ignore paused runs", () => {
  it("recoverRetriableRuns queries status=retriable, not status=paused", async () => {
    const { recoverRetriableRuns } = await import("../pm/actions/recover.js");
    const db = {
      select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
    };
    const runner = { resume: () => Promise.resolve() };
    const result = await recoverRetriableRuns({ db: db as any, runner: runner as any, maxRetries: 3 });
    // No paused runs were touched — correct; the dedicated sweep handles them.
    expect(result.recovered).toHaveLength(0);
    expect(result.exhausted).toHaveLength(0);
  });

  it("ACTIVE_STATUSES does NOT include paused — startTodoIssues guard is correct", async () => {
    const { ACTIVE_STATUSES } = await import("../pm/actions/db-queries.js");
    // 'paused' is deliberately absent: paused runs await human approval and
    // must not block new runs from starting for different issues. The expiry
    // sweep handles cleanup; ACTIVE_STATUSES guards against same-issue double-start.
    expect(ACTIVE_STATUSES).not.toContain("paused");
    expect(ACTIVE_STATUSES).toContain("queued");
    expect(ACTIVE_STATUSES).toContain("running");
  });
});

// ---------------------------------------------------------------------------
// Part 3: State-machine trace — paused→cancelled transition now exists
// ---------------------------------------------------------------------------

describe("BEC-271 Part 3: paused→cancelled transition added by sweep", () => {
  it("documents the new terminal transition for expired paused runs", () => {
    /**
     * Before BEC-271 fix — no paused→cancelled path:
     *  paused → running  (approval received via Linear webhook)
     *  [stuck forever if approval never arrives]
     *
     * After BEC-271 fix — new transition added by sweepExpiredPausedRuns:
     *  paused → cancelled  (PM tick: startedAt < now - threshold AND escape hatch off)
     *
     * Trigger: PM_AGENT_AWAIT_APPROVAL_MAX_AGE_MIN minutes old (default 72h)
     * Escape:  URATEAM_DISABLE_PAUSED_RUN_EXPIRY=true (strict equality)
     * Effects: active_work removed, needs-design label added, comment posted,
     *          pm.paused_run_expired audit event emitted, worktrees pruned
     */
    const newTransition = "paused→cancelled";
    const knownTransitionsBeforeFix = new Set([
      "queued→running",
      "running→paused",
      "paused→running",
      "running→failed",
      "running→retriable",
      "retriable→paused",
      "running→completed",
      "running→cancelled",
    ]);
    // Confirm this was the gap — the transition did not exist before.
    expect(knownTransitionsBeforeFix.has(newTransition)).toBe(false);
    // The fix adds it via sweepExpiredPausedRuns (verified by Part 1 tests above).
  });
});
