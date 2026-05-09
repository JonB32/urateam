/**
 * Pure helper for RALPH iteration computation — extracted to enable unit testing
 * without pulling in the full runner module. (BEC-182)
 */

export function computeEffectiveRalphIterations(
  run: { runType?: string | null },
  configIterations: number | undefined,
  hasDeepReviewLicense: boolean,
): number {
  // BEC-182: skip RALPH for review-feedback runs — RALPH re-evaluates against
  // the original issue ACs but feedback work is bounded to the comments, not
  // the full ACs. RALPH adds turn cost without value here.
  if (run.runType === "review-feedback") return 0;
  if (hasDeepReviewLicense) return configIterations ?? 2;
  return Math.min(configIterations ?? 1, 1);
}
