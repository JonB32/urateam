export interface TriggerResult {
  pass: boolean;
  reason: string;
}

export function evalMergedPRsSince(
  actualCount: number,
  threshold: number,
): TriggerResult {
  if (actualCount >= threshold) {
    return { pass: true, reason: `mergedPRsSince=${threshold} (have ${actualCount})` };
  }
  return { pass: false, reason: `mergedPRsSince not met (${actualCount}/${threshold})` };
}

export function evalTimeSinceLastHours(
  lastTagAt: Date | null,
  thresholdHours: number,
  now: Date = new Date(),
): TriggerResult {
  if (lastTagAt === null) {
    return { pass: true, reason: "no prior tag" };
  }
  const elapsedHours = (now.getTime() - lastTagAt.getTime()) / 3600 / 1000;
  if (elapsedHours >= thresholdHours) {
    return {
      pass: true,
      reason: `timeSinceLastHours=${thresholdHours} (have ${elapsedHours.toFixed(1)}h)`,
    };
  }
  return {
    pass: false,
    reason: `timeSinceLastHours not met (${elapsedHours.toFixed(1)}h/${thresholdHours}h)`,
  };
}

export function evalCiGreenForMinutes(
  ciStatus: "green" | "not-green" | "unavailable",
  greenSince: Date | null,
  thresholdMinutes: number,
  now: Date = new Date(),
): TriggerResult {
  if (ciStatus === "unavailable") {
    return { pass: false, reason: "ci_check_unavailable" };
  }
  if (ciStatus !== "green" || greenSince === null) {
    return { pass: false, reason: "ci_not_green" };
  }
  const elapsedMin = (now.getTime() - greenSince.getTime()) / 60 / 1000;
  if (elapsedMin >= thresholdMinutes) {
    return {
      pass: true,
      reason: `ciGreenForMinutes=${thresholdMinutes} (${elapsedMin.toFixed(0)}m green)`,
    };
  }
  return {
    pass: false,
    reason: `ciGreenForMinutes not met (${elapsedMin.toFixed(0)}m/${thresholdMinutes}m)`,
  };
}

export function evalRequireSlackApproval(
  required: boolean,
  hasFresh: boolean,
): TriggerResult {
  if (!required) return { pass: true, reason: "approval not required" };
  if (hasFresh) return { pass: true, reason: "approval is fresh" };
  return { pass: false, reason: "no_fresh_approval" };
}

import type { QaCheckConfig, QaRunSnapshot, QaTriggerResult } from "../qa/types.js";

export interface EvalQaCheckInput {
  qaConfig: QaCheckConfig;
  headSha: string;
  /** Whether the configured workflow file exists at headSha (per workflowFileExists). */
  workflowFileExists: boolean;
  /** Most recent in-flight run snapshot, or null when nothing tracked. */
  qaRun: QaRunSnapshot | null;
  /** When qaRun is for current SHA AND the run has completed: the GitHub conclusion string. Null otherwise. */
  runConclusion: string | null;
  now?: Date;
}

/**
 * Pure decision: given current state and qaCheck config, return one of 6 result kinds.
 *
 * Ordering inside the function:
 *   1. If workflow file is missing → qa_no_workflow (file gap issue + skip)
 *   2. If no in-flight run OR the run is for a stale SHA → qa_needs_trigger (dispatch)
 *   3. If completed: success → pass:true, else → qa_failed (with conclusion)
 *   4. If still running and elapsed > timeoutMinutes → qa_timed_out
 *   5. Otherwise → qa_running (await next tick)
 */
export function evalQaCheck(input: EvalQaCheckInput): QaTriggerResult {
  const { qaConfig, headSha, workflowFileExists, qaRun, runConclusion, now = new Date() } = input;

  if (!workflowFileExists) {
    return { pass: false, reason: "qa_no_workflow" };
  }

  if (qaRun === null || qaRun.runSha !== headSha) {
    return { pass: false, reason: "qa_needs_trigger" };
  }

  // We have an in-flight run for current SHA.
  if (runConclusion !== null) {
    if (runConclusion === "success") {
      return { pass: true, reason: "qa passed" };
    }
    return { pass: false, reason: "qa_failed", runId: qaRun.runId, conclusion: runConclusion };
  }

  // Still running — check timeout.
  const elapsedMs = now.getTime() - qaRun.triggeredAt.getTime();
  const timeoutMs = qaConfig.timeoutMinutes * 60 * 1000;
  if (elapsedMs > timeoutMs) {
    return { pass: false, reason: "qa_timed_out", runId: qaRun.runId };
  }
  return { pass: false, reason: "qa_running", runId: qaRun.runId };
}
