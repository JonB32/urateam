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
