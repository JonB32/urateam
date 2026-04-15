import type { PolicyViolation } from "./types.js";

export function evaluateCostGate(
  tokensUsed: number,
  limit: number | undefined,
  stage: string,
): PolicyViolation | null {
  if (limit === undefined || tokensUsed <= limit) return null;
  return {
    gate: "cost",
    detail: `token usage ${tokensUsed} exceeds per-issue limit ${limit} after ${stage}`,
    severity: "blocking",
    payload: { tokensUsed, limit, stage },
  };
}
