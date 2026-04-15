import { matchesAnyPattern } from "../util/glob.js";
import type { PolicyViolation } from "./types.js";

export function evaluatePathBlocklist(
  changedFiles: string[],
  patterns: string[],
): PolicyViolation[] {
  if (patterns.length === 0) return [];
  const violations: PolicyViolation[] = [];
  for (const file of changedFiles) {
    for (const pattern of patterns) {
      if (matchesAnyPattern(file, [pattern])) {
        violations.push({
          gate: "path",
          detail: `${file} matches ${pattern}`,
          severity: "blocking",
          payload: { path: file, pattern },
        });
      }
    }
  }
  return violations;
}
