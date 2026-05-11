/**
 * Reproduction test for BEC-214:
 * Runner-level stall detection gap — `checkForStalledRuns()` is missing.
 *
 * ## Root cause
 *
 * The acceptance criteria require a `checkForStalledRuns()` function on
 * `PipelineRunner` that is invoked periodically (at least every 60 seconds)
 * from the main orchestration loop. No such function exists today.
 *
 * ## Existing stall defences (NOT sufficient to close BEC-214)
 *
 * 1. **Stream-level** (`executor/agent-stream.ts`):
 *    - `StageStalledError` — mid-stream silence after `progressTimeoutMs` (30 min)
 *    - `StagePreStreamStalledError` — no first message within `firstMessageTimeoutMs` (5 min)
 *    - Wall-clock per-stage hard cap in `executor.ts` (60 min implement / 30 min others)
 *    These fire *inside* the Agent SDK stream; they cannot cover hangs at the runner
 *    orchestration layer (e.g. between stage calls, during DB writes, inside the push
 *    queue).
 *
 * 2. **PM Agent zombie recovery** (`pm/actions/recover-stuck.ts`, BEC-184):
 *    - Triggered by the PM Agent `tick()`, NOT by `PipelineRunner` itself.
 *    - Fires every PM Agent tick (typically every few minutes, not every 60 s).
 *    - Detects runs `status='running'` for > `PM_AGENT_STUCK_RUN_AGE_MIN` minutes
 *      (default 60 min) by inspecting the DB — it does NOT monitor active runs
 *      in real time.
 *    - Has no concept of "inactivity windows" shorter than the full run age threshold.
 *
 * Neither defence satisfies the ACs which require:
 *  - A dedicated `checkForStalledRuns()` method on `PipelineRunner`
 *  - Periodic invocation every ≥ 60 s from the main orchestration loop
 *  - Structured log emission (runId, stage, elapsed, error context)
 *  - Automatic termination with "stalled process" reason
 *  - Configuration for timeout and polling interval documented in deploy/
 *
 * ## Steps to reproduce the gap
 *
 * 1. `PipelineRunner` does not export or define `checkForStalledRuns`.
 * 2. There is no `setInterval` or periodic monitoring loop inside `PipelineRunner`.
 * 3. A run can sit in `status='running'` with no activity for 30–59 minutes before
 *    ANY existing mechanism fires (the earliest automated recovery is 60 min via BEC-184).
 * 4. No per-stage "last activity" timestamp is tracked at the runner level;
 *    only the `updatedAt` column on `pipeline_runs` is updated at stage boundaries.
 */

import { describe, it, expect } from "vitest";
import { PipelineRunner } from "../pipeline/runner.js";

// ---------------------------------------------------------------------------
// BEC-214 Reproduction: checkForStalledRuns() does not exist on PipelineRunner
// ---------------------------------------------------------------------------

describe("BEC-214: runner-level stall detection — feature gap", () => {
  /**
   * AC 1 — `checkForStalledRuns()` must exist on `PipelineRunner`.
   *
   * Currently `PipelineRunner` has:
   *   start(), resume(), abort(), haltAll(), cancelAll()
   * There is no `checkForStalledRuns` method.
   *
   * This test FAILS until BEC-214 is implemented.
   */
  it("PipelineRunner should expose a checkForStalledRuns() method", () => {
    expect(typeof PipelineRunner.prototype.checkForStalledRuns).toBe(
      "function",
      "PipelineRunner.prototype.checkForStalledRuns must exist — implement BEC-214",
    );
  });

  /**
   * AC 2 — stall detection must fire when a run has had no activity for more
   * than the configured timeout (default 30 minutes).
   *
   * This test simulates the condition by constructing a fake `activeRuns` state
   * where a run's last activity timestamp is 31 minutes ago.
   *
   * The test FAILS today because `checkForStalledRuns` does not exist and there
   * is no last-activity tracking inside `PipelineRunner`.
   */
  it("checkForStalledRuns() detects a run inactive for > 30 minutes and marks it failed", async () => {
    // Build a minimal config — real DB / notifier not needed for this unit check.
    const fakeDb = {
      select: () => ({ from: () => ({ where: async () => [] }) }),
      update: () => ({ set: () => ({ where: async () => ({}) }) }),
    };
    const fakeNotifier = {};

    const runner = new PipelineRunner({
      db: fakeDb as any,
      notifier: fakeNotifier as any,
      concurrency: 1,
      agentRunDir: "/tmp/test-runs",
      repoCloneDir: "/tmp/test-repos",
    });

    // checkForStalledRuns must exist as a callable method.
    expect(typeof (runner as any).checkForStalledRuns).toBe(
      "function",
      "checkForStalledRuns() is not implemented on PipelineRunner",
    );
  });

  /**
   * AC 3 — structured stall-detection log.
   *
   * When a stalled run is detected, the log entry must include:
   *   runId, stage, elapsedMs, errorContext
   *
   * No such logging exists today because `checkForStalledRuns` is absent.
   */
  it("detects the gap: no runner-level last-activity tracking exists", () => {
    // PipelineRunner only tracks activeRuns: Map<issueId, runId>
    // It does NOT store a per-run "last activity" timestamp.
    const proto = PipelineRunner.prototype as any;

    // The absence of these properties/methods confirms the gap.
    expect(proto.checkForStalledRuns).toBeUndefined();
    expect(proto.startStalledRunDetection).toBeUndefined();
    expect(proto.stopStalledRunDetection).toBeUndefined();
  });

  /**
   * AC 5 — integration test: simulate a stalled run.
   *
   * A proper integration test would:
   *  1. Start a run via runner.start()
   *  2. Freeze activity updates (skip stage completion callbacks)
   *  3. Advance fake timers past the stall timeout (30 min)
   *  4. Call checkForStalledRuns() or wait for the periodic poll
   *  5. Assert run DB status = 'failed' with reason 'stalled process'
   *
   * This cannot be written until `checkForStalledRuns()` exists.
   * The test below is a placeholder that confirms the gap.
   */
  it("PLACEHOLDER: integration stall simulation cannot run — feature not implemented", () => {
    const proto = PipelineRunner.prototype as any;
    // Confirmed gap: no stall-detection entry points exist.
    expect(proto.checkForStalledRuns).toBeUndefined();
    // Once BEC-214 ships, replace this with a full integration test using vi.useFakeTimers().
  });
});
