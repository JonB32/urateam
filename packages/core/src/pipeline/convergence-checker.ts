/**
 * convergence-checker.ts — Deep-review loop convergence detection.
 *
 * BEC-213: The deep-review loop was hitting 33+ turns without converging
 * because convergence was checked by count only (findingsCount >= previousCount).
 * Two cycles with the same number of DIFFERENT findings would incorrectly be
 * treated as converged, and a cycle where findings count happened to stay level
 * would also stop early — even if a different set of issues remained.
 *
 * This module provides content-based convergence detection plus a hard
 * MAX_REVIEW_TURNS cap to bound the total number of review+implement cycles.
 *
 * ## Convergence algorithm
 *
 * After each implement stage the orchestrator calls `isConverged(current, previous)`.
 * The loop terminates when ANY of these conditions hold:
 *
 *   (a) `current` is empty — no findings remain to fix.
 *   (b) `current` matches `previous` by content (same fingerprints) — the
 *       implement stage did not address the outstanding findings, so further
 *       iterations cannot help.
 *   (c) The iteration counter reaches `maxReviewTurns` (config parameter,
 *       default `MAX_REVIEW_TURNS = 15`). When this fires, a detailed
 *       misalignment report is logged to aid diagnosis.
 *
 * ## Configuration
 *
 *   `maxReviewTurns` in `PipelineConfig` — cap on total review+implement cycles
 *   across BOTH the review-fix loop and deep-review loop.  Defaults to 15.
 *   Must be significantly lower than 33 (the BEC-213 incident value).
 */

import type { ReviewFinding } from "../types.js";

/**
 * Maximum total review+implement cycles (combined across the review-fix loop
 * and deep-review loop) before the pipeline force-terminates the loops.
 *
 * Default: 15. Significantly lower than the 33-turn BEC-213 incident run.
 * Operators may override via `PipelineConfig.maxReviewTurns`.
 */
export const MAX_REVIEW_TURNS = 15;

/**
 * Separator used between fields when building a ReviewFinding fingerprint.
 * A null byte is chosen because it cannot appear in any of the string fields
 * produced by the review agent, eliminating any possibility of collisions.
 */
const FINGERPRINT_SEPARATOR = "\x00";

/**
 * Produces a stable fingerprint for a ReviewFinding based on its identity
 * fields. Two findings are considered the same issue when they share the same
 * file, line, category, and description — regardless of field ordering.
 */
export function fingerprintFinding(f: ReviewFinding): string {
  return [f.file, f.line, f.category, f.description].join(FINGERPRINT_SEPARATOR);
}

/**
 * Returns `true` when the review loop has converged and no further implement
 * iterations can make progress.
 *
 * Converged conditions:
 *   - `current` is empty (no findings left to fix), OR
 *   - `current` and `previous` contain the same findings by content (the
 *     implement stage did not address any outstanding issue)
 *
 * Does NOT converge when only the count matches but content differs — this
 * was the BEC-213 bug where two cycles with the same number of different
 * findings were incorrectly treated as converged.
 *
 * @param current  Findings from the most recent review cycle.
 * @param previous Findings from the previous review cycle (empty on first pass).
 */
export function isConverged(
  current: ReviewFinding[],
  previous: ReviewFinding[],
): boolean {
  if (current.length === 0) return true;
  if (current.length !== previous.length) return false;
  const prevSet = new Set(previous.map(fingerprintFinding));
  return current.every((f) => prevSet.has(fingerprintFinding(f)));
}

/** A single review+implement cycle record used for misalignment diagnostics. */
export interface CycleRecord {
  /** 1-based cycle index. */
  pass: number;
  /** Findings produced by the review stage in this cycle. */
  findings: ReviewFinding[];
  /**
   * Abbreviated git diff (e.g. `--stat` output) from the implement stage
   * in this cycle. Only populated by callers that have access to git diffs;
   * may be undefined when the diff is unavailable. When present, helps
   * identify which changes were (or weren't) made in response to the
   * previous cycle's findings.
   */
  diff?: string;
}

/**
 * Builds a human-readable misalignment report when `maxReviewTurns` is exceeded.
 *
 * Logs findings from each cycle alongside the implement-stage diff so operators
 * can identify which findings recurred without being addressed and which diff
 * changes failed to satisfy the review stage — the two most common causes of
 * a stalled review loop.
 */
export function buildMisalignmentReport(cycles: CycleRecord[]): string {
  const lines: string[] = [
    `maxReviewTurns exceeded — ${cycles.length} cycle(s) recorded. Misalignment analysis:`,
    `(Each cycle: review findings vs. implement diff. Look for findings that recur unchanged`,
    `or diffs that don't address the prior cycle's blocking findings.)`,
  ];

  for (const cycle of cycles) {
    lines.push(`\n=== Pass ${cycle.pass} ===`);
    lines.push(`Findings (${cycle.findings.length}):`);
    if (cycle.findings.length === 0) {
      lines.push("  (none)");
    } else {
      for (const f of cycle.findings) {
        lines.push(
          `  [${f.severity}] ${f.file}:${f.line} (${f.category}): ${f.description}`,
        );
      }
    }
    if (cycle.diff) {
      const diffLines = cycle.diff.split("\n").slice(0, 40);
      lines.push(`\nImplement diff (first 40 lines):`);
      lines.push(diffLines.join("\n"));
    }
  }

  return lines.join("\n");
}
