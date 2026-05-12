/**
 * Tier 3 — auto-deep-review thresholds.
 *
 * Promotes the deep-review fanout from opt-in (`config.deepReviewPasses ?? 0`)
 * to default-on for PRs above heuristic thresholds. The decision logic lives
 * here as pure functions; the runner reads `shouldAutoDeepReview(...)` and
 * bumps `deepReviewPasses` to at least 1 when the heuristic fires.
 *
 * Three thresholds — any one trips:
 *   • newFiles ≥ N        — proxy for "non-trivial scope"
 *   • totalLines ≥ N      — measures actual diff size
 *   • newPublicExports ≥ N — surface-area changes (new functions/types)
 *
 * Defaults: { newFiles: 5, totalLines: 200, newPublicExports: 2 } — per the
 * operator brief.
 *
 * Escape hatches:
 *   1. `URATEAM_DISABLE_AUTO_DEEP_REVIEW=true` short-circuits the heuristic.
 *   2. Per-pipeline `autoDeepReviewThresholds: { newFiles: 999999, ... }`
 *      raises the bar so the heuristic effectively never fires.
 *
 * Deep-review findings remain blocking-by-default (Tier 3 design); the
 * existing review-fix loop already escalates blocking findings, so no
 * runner-side blocking-flag mechanism is needed beyond bumping
 * `deepReviewPasses`.
 */

export interface AutoDeepReviewThresholds {
  /** Number of files changed (added + modified + deleted) in the diff. */
  changedFiles: number;
  /** Sum of insertions + deletions across the diff. */
  totalLines: number;
  /** Number of newly-added top-level `export` lines under source paths.  */
  newPublicExports: number;
}

export const DEFAULT_AUTO_DEEP_REVIEW_THRESHOLDS: AutoDeepReviewThresholds = {
  changedFiles: 5,
  totalLines: 200,
  newPublicExports: 2,
};

export interface DiffMetrics {
  /** Number of files changed (added + modified + deleted) in the diff. The
   *  `git diff --stat` "N files changed" line counts all three; the threshold
   *  is named accordingly to avoid the older `newFiles` misnomer the brief
   *  used. */
  changedFiles: number;
  /** Sum of insertions and deletions across the diff. */
  totalLines: number;
  /** Count of newly-added top-level `export` lines under monorepo
   *  `packages/<pkg>/src/` OR repo-root `src/` (for non-monorepo
   *  consumers), excluding `__tests__/`. Counts named exports (`export
   *  function`, `export class`, ...), default exports (`export default
   *  ...`), named re-exports (`export { foo }`), and wildcard re-exports
   *  (`export * from`). */
  newPublicExports: number;
}

const EXPORT_REGEX =
  /^\+export\s+(default\s+)?(async\s+)?(function|class|const|let|interface|type|enum|\{|\*)/;

const PATH_HEADER_REGEX = /^\+\+\+ b\/(.+)$/;

/** Source paths that count toward `newPublicExports`:
 *  - `packages/<pkg>/src/...` — monorepo case
 *  - `src/...` — non-monorepo case (single-package projects)
 *  Both exclude `__tests__/` (tests aren't public surface).
 */
const SOURCE_PATH_MONOREPO = /^packages\/[^/]+\/src\//;
const SOURCE_PATH_SINGLE = /^src\//;

const TESTS_PATH_FRAGMENT = "/__tests__/";

/**
 * Pure parser: scans a unified diff for newly-added `export` declarations
 * under `packages/<pkg>/src/` (excluding `__tests__/`). Used by Tier 3's heuristic
 * to decide whether the diff introduces enough new public surface area to
 * warrant a deep review.
 *
 * Counts only LINES — does not deduplicate by symbol. The heuristic is
 * "approximately how much new public surface is in the diff", not "exact
 * symbol count", so per-line counting is the right level.
 */
export function countNewPublicExports(diff: string): number {
  let currentFile: string | null = null;
  let currentFileInScope = false;
  let count = 0;

  for (const line of diff.split("\n")) {
    const pathMatch = PATH_HEADER_REGEX.exec(line);
    if (pathMatch) {
      currentFile = pathMatch[1]!;
      currentFileInScope =
        (SOURCE_PATH_MONOREPO.test(currentFile) ||
          SOURCE_PATH_SINGLE.test(currentFile)) &&
        !currentFile.includes(TESTS_PATH_FRAGMENT);
      continue;
    }
    if (!currentFile || !currentFileInScope) continue;
    if (EXPORT_REGEX.test(line)) count++;
  }

  return count;
}

/**
 * Decide whether to force an auto-deep-review pass. Honors the env-var
 * escape hatch first; otherwise compares each metric against its threshold
 * (any one tripping is sufficient — these are alternative triggers, not
 * AND-ed conditions).
 */
export function shouldAutoDeepReview(
  metrics: DiffMetrics,
  thresholds: AutoDeepReviewThresholds = DEFAULT_AUTO_DEEP_REVIEW_THRESHOLDS,
): boolean {
  if (process.env.URATEAM_DISABLE_AUTO_DEEP_REVIEW === "true") return false;
  return (
    metrics.changedFiles >= thresholds.changedFiles ||
    metrics.totalLines >= thresholds.totalLines ||
    metrics.newPublicExports >= thresholds.newPublicExports
  );
}
