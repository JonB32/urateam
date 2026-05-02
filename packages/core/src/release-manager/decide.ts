import type { CollectedState, DecisionResult, ReleaseManagerTriggers } from "./types.js";
import {
  evalMergedPRsSince,
  evalTimeSinceLastHours,
  evalCiGreenForMinutes,
  evalRequireSlackApproval,
} from "./triggers.js";

/**
 * Pure decision: given current state and configured triggers, return
 * { kind: "fire" } iff EVERY set trigger passes, else { kind: "skip" }
 * with the first failing trigger's reason.
 *
 * Triggers are evaluated in the documented order (cheapest first):
 *   1. mergedPRsSince  (DB count, in-memory)
 *   2. timeSinceLastHours  (single timestamp compare)
 *   3. ciGreenForMinutes  (already-fetched into state)
 *   4. requireSlackApproval  (already-fetched into state)
 */
export function decide(
  state: CollectedState,
  triggers: ReleaseManagerTriggers,
  now: Date = new Date(),
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

  if (triggers.requireSlackApproval === true) {
    const r = evalRequireSlackApproval(true, state.hasFreshApproval);
    // Spec §5: when this is the ONLY failing trigger, the decision kind is
    // "awaiting-approval" (not "skip") so the scheduler posts a "Release
    // ready: /release approve to fire" prompt instead of a cooldown skip.
    if (!r.pass) return { kind: "awaiting-approval", reason: r.reason };
  }

  return { kind: "fire", reason: "all triggers passed" };
}
