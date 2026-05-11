/**
 * Convergence validator for the deep-review loop (BEC-208).
 *
 * Prevents the deep-review loop from cycling indefinitely by detecting two
 * failure modes:
 *
 * 1. **Repeated issues** — the same unresolved issues appear in
 *    `consecutiveThreshold` (default: 3) consecutive turns without meaningful
 *    progress. Sub-case diagnosis:
 *    - "non-responsive-implementation": implementation diff did not change
 *      between turns (the agent is ignoring feedback).
 *    - "misaligned-review-criteria": implementation changed but the same
 *      issues were re-raised (review criteria may be ambiguous or too strict).
 *
 * 2. **Turn limit exceeded** — more than `maxTurns` (default: 12) iterations
 *    have completed without convergence. Surfaces all remaining unresolved
 *    issues and suggests whether the problem is on the implementation side or
 *    the review side.
 *
 * Each "turn" = one deep-review loop iteration:
 *   run review providers → re-run implement stage → re-run review stage.
 *
 * Usage:
 * ```ts
 * import { checkConvergence, type TurnRecord } from "../pipeline/convergenceValidator.js";
 *
 * const history: TurnRecord[] = [];
 *
 * for (let turn = 1; turn <= passLimit; turn++) {
 *   // ... run review providers + implement + review ...
 *   const record: TurnRecord = { turn, findings: [...], implDiffHash };
 *   history.push(record);
 *
 *   const result = checkConvergence(history, { maxTurns: config.maxReviewTurns });
 *   if (result.shouldStop) {
 *     log.warn({ reason: result.reason, message: result.message }, "deep review: stopping");
 *     break;
 *   }
 * }
 * ```
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Minimal shape of a finding needed for convergence detection. */
export interface FindingFingerprint {
  file: string;
  line: number;
  category: string;
  description: string;
}

/**
 * Record for a single deep-review turn.
 * Collect one of these per loop iteration and pass the accumulated history to
 * `checkConvergence`.
 */
export interface TurnRecord {
  /** 1-based turn number. */
  turn: number;
  /** Findings produced by the review providers in this turn. */
  findings: FindingFingerprint[];
  /**
   * A short hash (or any stable fingerprint) of the implementation diff after
   * the implement stage ran in this turn. Use `computeImplDiffHash` to derive
   * this from `git diff HEAD`.
   *
   * Equal hashes across consecutive turns indicate the implementation did not
   * change, which distinguishes "non-responsive implementation" from
   * "misaligned review criteria".
   */
  implDiffHash: string;
}

/**
 * Diagnosis of why the loop stalled when `reason === "repeated-issues"`.
 *
 * - `"non-responsive-implementation"`: the implementation diff did not change
 *   across the consecutive turns — the agent appears to be ignoring feedback.
 * - `"misaligned-review-criteria"`: the implementation changed but the same
 *   issues were re-raised — the review criteria may be ambiguous or too strict.
 */
export type ConvergenceDiagnosis =
  | "non-responsive-implementation"
  | "misaligned-review-criteria";

/** Result returned by `checkConvergence`. */
export interface ConvergenceResult {
  /** Whether the loop should stop. */
  shouldStop: boolean;
  /**
   * Why the loop is stopping (null when shouldStop is false):
   * - `"turn-limit"`: `maxTurns` iterations completed without convergence.
   * - `"repeated-issues"`: same issues reappeared in `consecutiveThreshold` consecutive turns.
   */
  reason: "turn-limit" | "repeated-issues" | null;
  /**
   * Stable fingerprint strings of the issues that are still unresolved.
   * Empty when `shouldStop` is false.
   */
  unresolvedIssues: string[];
  /**
   * Diagnosis only populated when `reason === "repeated-issues"`.
   * Null otherwise.
   */
  diagnosis: ConvergenceDiagnosis | null;
  /**
   * Human-readable message summarising the convergence decision.
   * Null when `shouldStop` is false.
   */
  message: string | null;
}

/** Configuration for `checkConvergence`. */
export interface ConvergenceConfig {
  /**
   * Maximum number of deep-review turns allowed before hard-stopping the loop.
   * Default: 12.
   */
  maxTurns?: number;
  /**
   * Number of consecutive turns with the same unresolved issues before
   * aborting. Default: 3.
   */
  consecutiveThreshold?: number;
}

// ---------------------------------------------------------------------------
// Exported constants (used by runner.ts and tests)
// ---------------------------------------------------------------------------

export const CONVERGENCE_DEFAULTS = {
  /** Default maximum deep-review turns. Matches `maxReviewTurns` schema default. */
  MAX_TURNS: 12,
  /** Default consecutive-turn threshold for repeated-issue detection. */
  CONSECUTIVE_THRESHOLD: 3,
} as const;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Produce a stable fingerprint string for a single finding.
 * Two findings are considered "the same" if they share file + category +
 * the first 120 chars of description (trimmed). Line number is intentionally
 * excluded: minor reformats can shift lines without resolving the underlying issue.
 */
function fingerprintFinding(f: FindingFingerprint): string {
  const descSnippet = f.description.trim().slice(0, 120);
  return `${f.file}\x00${f.category}\x00${descSnippet}`;
}

/** Build a Set of finding fingerprints for a single turn record. */
function fingerprintSet(record: TurnRecord): Set<string> {
  return new Set(record.findings.map(fingerprintFinding));
}

/**
 * Return the fingerprints that appear in ALL provided turn records
 * (i.e. issues that were unresolved across every one of those turns).
 */
function intersectFingerprints(records: TurnRecord[]): string[] {
  if (records.length === 0) return [];
  const sets = records.map(fingerprintSet);
  const [first, ...rest] = sets;
  const result: string[] = [];
  for (const fp of first) {
    if (rest.every((s) => s.has(fp))) {
      result.push(fp);
    }
  }
  return result;
}

/**
 * Return true when ALL provided records share the same `implDiffHash`,
 * meaning the implementation did not change across those turns.
 */
function allDiffsIdentical(records: TurnRecord[]): boolean {
  if (records.length < 2) return false;
  const firstHash = records[0].implDiffHash;
  return records.every((r) => r.implDiffHash === firstHash);
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Assess whether the deep-review loop should stop due to lack of convergence.
 *
 * Call this **after** each turn, passing the full accumulated history (including
 * the current turn's record). The function is pure — it reads `history` and
 * returns a decision; it does not mutate anything.
 *
 * @param history - All turn records collected so far (most-recent last).
 * @param config  - Optional thresholds (maxTurns, consecutiveThreshold).
 * @returns ConvergenceResult indicating whether to stop and why.
 */
export function checkConvergence(
  history: TurnRecord[],
  config: ConvergenceConfig = {},
): ConvergenceResult {
  const maxTurns =
    config.maxTurns ?? CONVERGENCE_DEFAULTS.MAX_TURNS;
  const consecutiveThreshold =
    config.consecutiveThreshold ?? CONVERGENCE_DEFAULTS.CONSECUTIVE_THRESHOLD;

  // ── Turn limit ───────────────────────────────────────────────────────────
  if (history.length >= maxTurns) {
    const recentRecords = history.slice(-consecutiveThreshold);
    const unresolvedIssues = intersectFingerprints(recentRecords);

    return {
      shouldStop: true,
      reason: "turn-limit",
      unresolvedIssues,
      diagnosis: null,
      message:
        `Deep-review loop reached the maximum turn limit (${maxTurns} turns). ` +
        `${unresolvedIssues.length} issue(s) remain unresolved. ` +
        `Suggestions: (1) increase maxReviewTurns to allow more iterations, ` +
        `(2) check whether review criteria are actionable and unambiguous, ` +
        `or (3) resolve remaining issues manually after the PR is created as draft.`,
    };
  }

  // ── Repeated-issue detection ─────────────────────────────────────────────
  if (history.length >= consecutiveThreshold) {
    const recentRecords = history.slice(-consecutiveThreshold);
    const repeatedIssues = intersectFingerprints(recentRecords);

    if (repeatedIssues.length > 0) {
      const noDiffChange = allDiffsIdentical(recentRecords);
      const diagnosis: ConvergenceDiagnosis = noDiffChange
        ? "non-responsive-implementation"
        : "misaligned-review-criteria";

      const diagnosisText = noDiffChange
        ? "The implementation diff did not change between turns — the agent may not be incorporating the feedback."
        : "The implementation changed between turns but the same issues were re-raised — review criteria may be too strict or ambiguous.";

      return {
        shouldStop: true,
        reason: "repeated-issues",
        unresolvedIssues: repeatedIssues,
        diagnosis,
        message:
          `Deep-review loop detected ${repeatedIssues.length} repeated issue(s) ` +
          `in ${consecutiveThreshold} consecutive turns. ` +
          diagnosisText,
      };
    }
  }

  // ── Not yet converged, but not stalled ───────────────────────────────────
  return {
    shouldStop: false,
    reason: null,
    unresolvedIssues: [],
    diagnosis: null,
    message: null,
  };
}
