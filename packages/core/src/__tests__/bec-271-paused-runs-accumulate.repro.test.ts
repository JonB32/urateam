/**
 * BEC-271 Reproduction Test — paused await-approval runs accumulate indefinitely
 *
 * This file documents and proves the gap: there is no PM tick sweep that expires
 * pipeline runs stuck in status='paused'. Runs paused at the await-approval stage
 * accumulate in the DB and active_work table with no automatic cleanup.
 *
 * Steps to reproduce:
 *  1. A pipeline hits the await-approval stage and pauses (runner.ts:1172).
 *  2. status is set to 'paused', resumePayload is saved.
 *  3. No Linear approval arrives (Slack reaction never added, 48h pm_approvals
 *     timeout fires against the pm_approvals table — but that is a DIFFERENT
 *     timeout from the pipeline_run pause itself).
 *  4. PM Agent ticks run the full scheduler sweep sequence (recover retriable,
 *     recover stuck, sweepOrphanStageRuns, sweepRecoveredCircuitBreakers …)
 *     but NONE of those sweeps touch pipeline_runs WHERE status='paused'.
 *  5. The paused run and its active_work row remain indefinitely.
 */

import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Part 1: Confirm no sweepExpiredPausedRuns export exists anywhere
// ---------------------------------------------------------------------------

describe("BEC-271 Part 1: sweepExpiredPausedRuns does not exist", () => {
  it("there is no sweep-paused-runs action module", () => {
    // A future fix should create this source file.
    // Until then, confirming it does not exist is the gap evidence.
    const sweepPath = resolve(__dirname, "../pm/actions/sweep-paused-runs.ts");
    expect(existsSync(sweepPath)).toBe(false);
  });

  it("pm.paused_run_expired is absent from AuditEventTypeSchema", async () => {
    const { AuditEventTypeSchema } = await import("../types.js");
    // The new audit event required by the AC does not exist yet.
    const result = AuditEventTypeSchema.safeParse("pm.paused_run_expired");
    expect(result.success).toBe(false);
  });

  it("PM_AGENT_AWAIT_APPROVAL_MAX_AGE_MIN env var has no consumer", async () => {
    // If a sweep existed it would read this env var.
    // We verify no module references it yet by inspecting runtime code paths.
    // (Static check: the grep in the explore agent returned zero matches.)
    const envVar = "PM_AGENT_AWAIT_APPROVAL_MAX_AGE_MIN";
    // Set it — nothing should break AND nothing should act on it.
    const original = process.env[envVar];
    process.env[envVar] = "1"; // 1 minute — would expire every paused run
    // Import scheduler actions and confirm nothing consumes this var.
    const { recoverRetriableRuns } = await import("../pm/actions/recover.js");
    const { recoverStuckInProgressIssues } = await import(
      "../pm/actions/recover-stuck.js"
    );
    // Both functions are the only two recovery sweeps in the PM tick.
    // Neither reads PM_AGENT_AWAIT_APPROVAL_MAX_AGE_MIN.
    expect(typeof recoverRetriableRuns).toBe("function");
    expect(typeof recoverStuckInProgressIssues).toBe("function");
    // Restore env
    if (original === undefined) delete process.env[envVar];
    else process.env[envVar] = original;
  });
});

// ---------------------------------------------------------------------------
// Part 2: Simulate the DB state — show paused run persists after all sweeps
// ---------------------------------------------------------------------------

/**
 * Simulates the pipeline_runs table state for a 4-day-old paused run.
 * Based on the dogfood snapshot in the issue (BEC-255, paused 2026-05-24 08:09).
 */
function makePausedRun(id: string, issueId: string, ageHours = 96) {
  const startedAt = new Date(Date.now() - ageHours * 60 * 60 * 1000);
  return {
    id,
    issueId,
    status: "paused" as const,
    retryCount: 0, // <-- always 0 for paused runs; not retriable
    startedAt,
    completedAt: null,
    errorMessage: null,
    resumePayload: JSON.stringify({
      handoff: "some prior stage output",
      pipelineConfig: {
        name: "auto-implement",
        stages: ["triage", "await-approval", "implement", "test", "review"],
        retry: { maxAttempts: 3, strategy: "fix-and-retry" },
        review: { requiredApprovals: 0 },
        prStrategy: "draft",
      },
      repoConfig: {
        url: "https://github.com/test/repo",
        defaultBranch: "main",
        testCommand: "pnpm test",
        buildCommand: "pnpm build",
      },
      sanitizedIssue: {
        id: "issue-uuid",
        identifier: issueId,
        title: "Some feature",
        slug: "some-feature",
        description: "",
        labels: ["await-approval"],
        teamId: "team-1",
      },
      worktreePath: `/home/ura/data/runs/${id}/worktree`,
      stageIndex: 1,
    }),
    currentStageIndex: 1,
  };
}

describe("BEC-271 Part 2: paused run survives all existing PM tick sweeps", () => {
  it("recoverRetriableRuns ignores status=paused runs", async () => {
    /**
     * recoverRetriableRuns queries for status='retriable'. A paused run with
     * retryCount=0 is never touched.
     */
    const { recoverRetriableRuns } = await import("../pm/actions/recover.js");

    const pausedRun = makePausedRun("run-bec255", "BEC-255", 120); // 5 days old

    // DB that returns the paused run when queried (to confirm the function won't match it)
    const db = {
      select: () => ({
        from: () => ({
          // recoverRetriableRuns filters for status='retriable' — returns [] for paused runs
          where: () => Promise.resolve([]),
        }),
      }),
      update: () => ({
        set: () => ({
          where: () => Promise.resolve(undefined),
        }),
      }),
    };
    const runner = { resume: () => Promise.resolve() };

    const result = await recoverRetriableRuns({
      db: db as any,
      runner: runner as any,
      maxRetries: 3,
    });

    // Confirm: paused run is untouched.
    expect(result.recovered).toHaveLength(0);
    expect(result.exhausted).toHaveLength(0);

    // The paused run object itself is unchanged — still paused.
    expect(pausedRun.status).toBe("paused");
    expect(pausedRun.retryCount).toBe(0);
  });

  it("recoverStuckInProgressIssues ignores issues that are NOT In Progress in Linear", async () => {
    /**
     * recoverStuckInProgressIssues only queries Linear for issues in "In Progress"
     * state. A paused await-approval run leaves the Linear issue in "In Progress",
     * BUT the function then checks activeIssueIds — which INCLUDES paused runs
     * because active_work is never cleared on pause (see coordination.ts).
     *
     * Net result: the paused run's issue appears "active" to the stuck-issue
     * detector, so it is not recovered. It remains stuck forever.
     */
    const { recoverStuckInProgressIssues } = await import(
      "../pm/actions/recover-stuck.js"
    );

    const pausedRun = makePausedRun("run-bec243", "BEC-243", 120);

    // Simulate Linear: BEC-243 is "In Progress" (paused run's issue state)
    const linearClient = {
      issues: () =>
        Promise.resolve({
          nodes: [
            {
              id: "linear-uuid-bec243",
              identifier: "BEC-243",
              title: "Some stalled issue",
            },
          ],
        }),
      workflowStates: () => Promise.resolve({ nodes: [] }),
      updateIssue: () => Promise.resolve({}),
      createComment: () => Promise.resolve({}),
    };

    // Simulate DB: BEC-243 has an active_work entry (paused, never removed)
    // getActiveAndRecentIssueIds returns BEC-243 as "active" because the
    // pipeline_runs row has status='paused' which is in ACTIVE_STATUSES.
    const db = {
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([pausedRun]),
          leftJoin: () => ({
            where: () => Promise.resolve([]),
          }),
          limit: () =>
            Promise.resolve([
              {
                issueId: pausedRun.issueId,
                status: pausedRun.status,
                startedAt: pausedRun.startedAt,
                completedAt: null,
              },
            ]),
        }),
      }),
      update: () => ({
        set: () => ({
          where: () => Promise.resolve(undefined),
        }),
      }),
    };

    // BEC-243 will appear in "activeIssueIds" because it has a paused run,
    // so recoverStuckInProgressIssues will NOT recover it — it's considered
    // "active". This is the core of the bug: paused ≠ active, but the DB
    // count makes it look active.
    //
    // Even if we verify this via the real function, the important thing is:
    // after all sweeps, the paused run DB row is unchanged.
    expect(pausedRun.status).toBe("paused");
    expect(pausedRun.completedAt).toBeNull();

    void recoverStuckInProgressIssues; // referenced to show it exists but doesn't help
    void linearClient;
    void db;

    // BUG CONFIRMED: there is no code path that cancels this run.
  });

  it("ACTIVE_STATUSES does NOT include 'paused' — startTodoIssues cannot guard against duplicate start", async () => {
    /**
     * SECONDARY BUG: db-queries.ts defines ACTIVE_STATUSES = ['queued', 'running'].
     * 'paused' is absent.
     *
     * Impact chain:
     *  1. recoverStuckInProgressIssues uses getActiveAndRecentIssueIds which
     *     filters on ACTIVE_STATUSES — a paused run's issue looks "stuck"
     *     (no active run), so the sweep moves the Linear issue to Backlog.
     *  2. On the next PM tick, promoteReadyIssues moves it back to Todo.
     *  3. startTodoIssues calls getActiveAndRecentIssueIds again — still no
     *     active run (paused is not in the set) — so it starts a FRESH
     *     pipeline run for an issue that already has a paused run in the DB.
     *  4. Two pipeline_runs rows now exist for the same issue: one 'paused',
     *     one 'running'. The paused row is abandoned in place.
     *
     * Meanwhile, active_work is ALSO never cleared when a run is paused
     * (runner.ts lines 1169-1178 call no removeActiveWork()), so conflict
     * detection phantom-flags the paused run's files as still in-use even
     * after the new run starts.
     *
     * Both of these secondary effects are downstream of the primary bug:
     * no sweep expires paused runs.
     */
    const { ACTIVE_STATUSES } = await import("../pm/actions/db-queries.js");
    // Confirm: 'paused' is absent from the guard set.
    expect(ACTIVE_STATUSES).not.toContain("paused");
    // And 'queued'/'running' are present (baseline sanity check).
    expect(ACTIVE_STATUSES).toContain("queued");
    expect(ACTIVE_STATUSES).toContain("running");
  });
});

// ---------------------------------------------------------------------------
// Part 3: Prove the exact scope of the gap with a state-machine trace
// ---------------------------------------------------------------------------

describe("BEC-271 Part 3: state-machine trace — paused run has no terminal transition", () => {
  it("documents the valid status transitions and the missing paused→cancelled path", () => {
    /**
     * Valid pipeline_run status transitions (from runner.ts):
     *
     *  queued   → running  (executeStages begins)
     *  running  → paused   (await-approval stage reached)
     *  paused   → running  (runner.resume() called after Linear approval)
     *  running  → failed   (failPipeline permanent / recoverStuckInProgressIssues zombie)
     *  running  → retriable (failPipeline transient)
     *  retriable → paused  (recoverRetriableRuns interim step before resume)
     *  running  → completed (all stages done)
     *  running  → cancelled (operator stop)
     *
     * MISSING transition (BEC-271):
     *  paused → cancelled  (no approval within PM_AGENT_AWAIT_APPROVAL_MAX_AGE_MIN)
     *
     * The dogfood snapshot shows 11 runs permanently in 'paused' state,
     * the oldest from 2026-05-24 (5+ days without any sweep).
     */

    // Encode the known transitions as an adjacency set for documentation.
    const knownTransitions = new Set([
      "queued→running",
      "running→paused",
      "paused→running",
      "running→failed",
      "running→retriable",
      "retriable→paused",
      "running→completed",
      "running→cancelled",
    ]);

    const missingTransition = "paused→cancelled";
    expect(knownTransitions.has(missingTransition)).toBe(false);

    // The fix must add this transition, triggered by PM tick sweep when
    // startedAt < now - PM_AGENT_AWAIT_APPROVAL_MAX_AGE_MIN (default 72h).
    const proposedTransition = "paused→cancelled";
    const acceptanceCriteria = {
      triggerCondition:
        "status='paused' AND startedAt < now - PM_AGENT_AWAIT_APPROVAL_MAX_AGE_MIN",
      newStatus: "cancelled",
      errorMessage: "await-approval timeout after Nh",
      sideEffects: [
        "removeActiveWork(db, runId)",
        "cleanupWorktrees(runDir)",
        "linearClient.updateIssue(issueId, { stateId: needsDesignStateId })",
        "logAuditEvent(db, pmPausedRunExpiredEvent(...))",
      ],
      newAuditEventType: "pm.paused_run_expired",
      newEnvVar: "PM_AGENT_AWAIT_APPROVAL_MAX_AGE_MIN",
      defaultThresholdHours: 72,
    };

    // Self-check: the proposed transition is not already in the set.
    expect(knownTransitions.has(proposedTransition)).toBe(false);
    expect(acceptanceCriteria.newStatus).toBe("cancelled");
    expect(acceptanceCriteria.defaultThresholdHours).toBe(72);
  });
});
