/**
 * Deep-review loop convergence detection (BEC-211).
 *
 * Detects when the review loop is cycling — i.e., consecutive passes modify
 * the same set of files without making net progress — and provides a
 * structured exit reason so the runner can break early and emit diagnostics.
 *
 * Configuration: see `maxReviewTurns` in PipelineConfig (default: 15).
 *
 * ## What counts as convergence?
 *
 * Four criteria are evaluated in priority order each pass:
 *
 * 1. **no-findings** — current pass produced zero findings (ideal convergence;
 *    the agent fixed everything).
 * 2. **max-turns** — accumulated pass count reached `maxReviewTurns` (safety
 *    cap, prevents token over-run regardless of other settings).
 * 3. **file-oscillation** — the last two passes modified the exact same sorted
 *    set of files, indicating the agent is cycling (add-then-remove or
 *    refactor-then-revert), not making forward progress.
 * 4. **count-plateau** — findings count did not decrease vs the previous pass
 *    (existing guard, retained for backward compatibility).
 *
 * ## Diagnostic output
 *
 * When the runner exits the loop via convergence, it logs:
 * - `convergence.reason` — which criterion fired
 * - `convergence.iteration` — the 1-based pass number at exit
 * - `convergence.detail` — human-readable explanation including conflicting
 *   file names and findings counts for easy post-incident analysis
 *
 * ## Configuration reference (MAX_REVIEW_TURNS)
 *
 * ```yaml
 * pipelines:
 *   my-pipeline:
 *     maxReviewTurns: 15   # default; caps deep-review iterations
 * ```
 *
 * - **`maxReviewTurns`** (integer ≥ 1, default 15) — hard cap on the number of
 *   deep-review loop iterations regardless of `deepReviewPasses` or
 *   `maxDeepReviewPasses`. Each iteration runs one review-providers call, one
 *   implement stage, and one review stage (~3 agent stages per iteration).
 *   Setting this lower (e.g. 5) saves tokens on well-behaved pipelines;
 *   raising it (up to the schema max) allows more passes for complex changes.
 *   The observer threshold (`LOOP_TURN_THRESHOLD = 50`) is based on *total*
 *   pipeline turns; with ~25 base turns, keeping `maxReviewTurns ≤ 15` keeps
 *   total turns well under the alert threshold even on busy pipelines.
 */

/** A snapshot of one deep-review loop pass. */
export interface PassHistory {
  /** 1-based pass number within the deep-review block. */
  passNumber: number;
  /** Files the implement stage reported as changed this pass
   *  (from HandoffArtifact.filesChanged). */
  filesChanged: string[];
  /** Number of review findings produced in this pass. */
  findingsCount: number;
}

/** The reason the deep-review loop was stopped. */
export type ConvergenceReason =
  | "no-findings"      // ideal: zero findings left
  | "count-plateau"    // findings count did not decrease
  | "file-oscillation" // same file set in consecutive passes
  | "max-turns";       // accumulated pass count hit maxReviewTurns

/** Result returned by detectConvergence when the loop should stop. */
export interface ConvergenceResult {
  /** Whether the loop should stop (always true when returned). */
  converged: boolean;
  /** Why convergence was detected. */
  reason: ConvergenceReason;
  /** The 1-based pass number at which convergence was detected. */
  iteration: number;
  /**
   * Human-readable diagnostic detail for structured logging.
   * Includes conflicting file names and findings counts so operators can
   * diagnose oscillation patterns from the log output alone.
   */
  detail: string;
}

/**
 * Evaluates convergence criteria for the deep-review loop.
 *
 * Call this after appending the current pass to `history`. Returns a
 * ConvergenceResult describing why the loop should stop, or `null` if
 * no criterion is met and the loop should continue.
 *
 * @param history   All passes executed so far (including the current one).
 * @param currentPass  Current 1-based pass number.
 * @param maxReviewTurns  Hard cap on total iterations (from PipelineConfig.maxReviewTurns).
 * @param currentTurns  Number of iterations accumulated so far (== drPass).
 */
export function detectConvergence(
  history: PassHistory[],
  currentPass: number,
  maxReviewTurns: number,
  currentTurns: number,
): ConvergenceResult | null {
  if (history.length === 0) return null;
  const current = history[history.length - 1];

  // 1. No findings — ideal convergence
  if (current.findingsCount === 0) {
    return {
      converged: true,
      reason: "no-findings",
      iteration: currentPass,
      detail: `pass ${currentPass}: zero findings — loop converged cleanly`,
    };
  }

  // 2. Max turns exceeded (independent of passLimit; safety net)
  if (currentTurns >= maxReviewTurns) {
    return {
      converged: true,
      reason: "max-turns",
      iteration: currentPass,
      detail:
        `pass ${currentPass}: accumulated review turns (${currentTurns}) reached ` +
        `maxReviewTurns (${maxReviewTurns}) — stopping to prevent token over-run`,
    };
  }

  // Need at least two passes for the remaining checks
  if (history.length < 2) return null;
  const previous = history[history.length - 2];

  // 3. File-level oscillation: same sorted file set in consecutive passes
  //    indicates the agent is cycling (add-then-remove, refactor-then-revert).
  //    Only fires when both passes actually changed files (non-empty set).
  const currentFiles = [...current.filesChanged].sort();
  const previousFiles = [...previous.filesChanged].sort();
  if (
    currentFiles.length > 0 &&
    currentFiles.length === previousFiles.length &&
    currentFiles.every((f, i) => f === previousFiles[i])
  ) {
    return {
      converged: true,
      reason: "file-oscillation",
      iteration: currentPass,
      detail:
        `pass ${currentPass}: same files as pass ${previous.passNumber} ` +
        `(${currentFiles.join(", ")}) — agent is cycling with no net progress; ` +
        `findings: pass ${previous.passNumber}=${previous.findingsCount}, ` +
        `pass ${currentPass}=${current.findingsCount}`,
    };
  }

  // 4. Findings count did not decrease (existing guard, retained)
  if (current.findingsCount >= previous.findingsCount) {
    return {
      converged: true,
      reason: "count-plateau",
      iteration: currentPass,
      detail:
        `pass ${currentPass}: findings count (${current.findingsCount}) did not decrease ` +
        `from pass ${previous.passNumber} (${previous.findingsCount}) — stopping to prevent loop`,
    };
  }

  return null;
}
