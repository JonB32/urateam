/**
 * run-patterns.ts — Quality Observer pattern detection helpers.
 *
 * BEC-169: completed runs that produced a PR are excluded from the
 * looping-deep-review pattern. Deep-review fanout (multi-model, multi-pass)
 * legitimately produces high turn counts on the way to a successful PR; only
 * runs that did NOT ship are looping in the harmful sense.
 */

/** A row from pipeline_runs joined with SUM(stage_runs.turns). */
export interface RunSummary {
  id: string;
  status: string;
  pr_url: string | null;
  total_turns: number;
}

export interface LoopingFinding {
  runId: string;
  totalTurns: number;
}

/**
 * Minimum turn count that triggers a looping-deep-review alert.
 *
 * BEC-213: reduced from 50 to 15 so that the 33-turn incident run
 * (7HaVmAKKn4gluPgv9T9pm) — and any future run that exceeds the
 * MAX_REVIEW_TURNS pipeline cap — is immediately flagged by the observer.
 */
export const LOOP_TURN_THRESHOLD = 15;

/**
 * Returns a finding for any run with > LOOP_TURN_THRESHOLD turns, EXCEPT
 * runs that completed successfully and produced a PR. Successful PR-creating
 * runs may legitimately exceed the threshold via deep-review fanout.
 */
export function findLoopingDeepReviews(runs: RunSummary[]): LoopingFinding[] {
  return runs
    .filter((run) => run.total_turns > LOOP_TURN_THRESHOLD)
    .filter((run) => !(run.status === "completed" && run.pr_url !== null))
    .map((run) => ({ runId: run.id, totalTurns: run.total_turns }));
}
