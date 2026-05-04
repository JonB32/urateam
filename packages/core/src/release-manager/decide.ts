import type { CollectedState, DecisionResult } from "./types.js";
import type { ReleaseManagerTriggers } from "./types.js";
import {
  evalMergedPRsSince,
  evalTimeSinceLastHours,
  evalCiGreenForMinutes,
  evalRequireSlackApproval,
  evalQaCheck,
} from "./triggers.js";

export interface DecideQaState {
  /** Whether the configured QA workflow file exists at state.headSha. Computed by scheduler. */
  workflowFileExists: boolean;
  /** When qaRun is for current SHA AND complete: the GitHub conclusion. Null otherwise. */
  runConclusion: string | null;
}

/**
 * Pure decision function. Evaluates triggers in this order:
 *   1. mergedPRsSince
 *   2. timeSinceLastHours
 *   3. ciGreenForMinutes
 *   4. qaCheck (BEC-136 — at slot 4 before requireSlackApproval)
 *   5. requireSlackApproval (last; the "awaiting-approval" terminal kind)
 *
 * QA check is at slot 4 because: if the workflow's failing/missing, that's a
 * regular skip — we don't want it bumping into the awaiting-approval branch.
 * The whole approval flow only triggers when QA has already passed.
 *
 * The optional `qaState` parameter carries IO-derived QA inputs (workflow
 * file existence + run conclusion) that the scheduler computes via Octokit
 * before calling decide(). Null when qaCheck isn't configured.
 */
export function decide(
  state: CollectedState,
  triggers: ReleaseManagerTriggers,
  now: Date = new Date(),
  qaState?: DecideQaState,
): DecisionResult {
  if (triggers.mergedPRsSince !== undefined) {
    const r = evalMergedPRsSince(state.mergedCommitsSinceLastTag, triggers.mergedPRsSince);
    if (!r.pass) return { kind: "skip", reason: r.reason };
  }

  if (triggers.timeSinceLastHours !== undefined) {
    const r = evalTimeSinceLastHours(state.lastTagAt, triggers.timeSinceLastHours, now);
    if (!r.pass) return { kind: "skip", reason: r.reason };
  }

  if (triggers.ciGreenForMinutes !== undefined) {
    const r = evalCiGreenForMinutes(state.ciStatus, state.ciGreenSince, triggers.ciGreenForMinutes, now);
    if (!r.pass) return { kind: "skip", reason: r.reason };
  }

  // BEC-136: QA check at slot 4 (before requireSlackApproval).
  if (triggers.qaCheck !== undefined) {
    const qa = qaState ?? { workflowFileExists: false, runConclusion: null };
    const r = evalQaCheck({
      qaConfig: triggers.qaCheck,
      headSha: state.headSha,
      workflowFileExists: qa.workflowFileExists,
      qaRun: state.qaRun,
      runConclusion: qa.runConclusion,
      now,
    });
    if (!r.pass) return { kind: "skip", reason: r.reason, qaActionNeeded: r };
  }

  if (triggers.requireSlackApproval === true) {
    const r = evalRequireSlackApproval(true, state.hasFreshApproval);
    // Spec §5: when this is the ONLY failing trigger, the decision kind is
    // "awaiting-approval" (not "skip") so the scheduler posts a "Release
    // ready: /release approve to fire" prompt instead of a cooldown skip.
    if (!r.pass) return { kind: "awaiting-approval", reason: r.reason };
  }

  return { kind: "fire", reason: "all triggers passed" };
}
