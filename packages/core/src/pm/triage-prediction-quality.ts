/**
 * Triage prediction quality (Tier 6b foundation for Tier 6e).
 *
 * Pure function. No I/O, no DB writes. Compares triage's `affectedFiles`
 * prediction against the actual diff at run-completion time.
 *
 * Caller is responsible for providing consistent path shapes — this
 * function does string equality only. The output shape is the contract
 * Tier 6e will consume to write `pm.triage_quality_score` audit events.
 */

export interface PredictionQualityResult {
  /** True iff `predicted` was supplied (i.e., triage v2 ran). */
  hasV2Prediction: boolean;
  /** Number of unique predicted paths. */
  predicted: number;
  /** Number of unique actual paths. */
  actual: number;
  /** Number of paths in both sets. */
  intersection: number;
  /** Predicted but not actually touched — sorted alphabetically. */
  missed: string[];
  /** Touched but not predicted — sorted alphabetically. */
  unexpected: string[];
}

export function computeAffectedFilesPredictionQuality(
  predicted: string[] | undefined,
  actualDiff: string[],
): PredictionQualityResult {
  const hasV2Prediction = Array.isArray(predicted);

  const predictedSet = new Set(predicted ?? []);
  const actualSet = new Set(actualDiff);

  const intersection = new Set<string>();
  for (const p of predictedSet) {
    if (actualSet.has(p)) intersection.add(p);
  }

  const missed: string[] = [];
  for (const p of predictedSet) {
    if (!actualSet.has(p)) missed.push(p);
  }
  missed.sort();

  const unexpected: string[] = [];
  for (const a of actualSet) {
    if (!predictedSet.has(a)) unexpected.push(a);
  }
  unexpected.sort();

  return {
    hasV2Prediction,
    predicted: predictedSet.size,
    actual: actualSet.size,
    intersection: intersection.size,
    missed,
    unexpected,
  };
}

/**
 * Parse the `**Affected Files:**` section written by `appendTriageSectionsToDescription`
 * from a Linear issue description.
 *
 * Returns `undefined` when no section is found (v1 triage path, no prediction).
 * Returns an empty array when the section exists but has no list items (v2 triage,
 * zero predicted files).
 */
export function parseAffectedFilesFromDescription(description: string): string[] | undefined {
  // Match the **Affected Files:** section. Ends at: blank line, next **header**, or end.
  const match = /\*\*Affected Files:\*\*\s*\n([\s\S]*?)(?:\n\n|\n\*\*|$)/.exec(description);
  if (!match) return undefined;

  const block = match[1] ?? "";
  const paths = block
    .split("\n")
    .map((line) => line.replace(/^-\s*/, "").trim())
    .filter((line) => line.length > 0);

  return paths;
}
