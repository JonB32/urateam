/**
 * BEC-212 reproduction record: deep-review loop non-convergence.
 *
 * Pipeline 6q0OpgiRrke_Szkr1MFt0 accumulated 39 total stage turns across
 * implement + review stage_runs over multiple deep-review passes without
 * converging. The quality observer filed GH#257.
 *
 * ROOT CAUSE (confirmed):
 *   1. The convergence check only compared finding COUNTS (findingsCount >=
 *      previousFindingsCount), not the actual finding content (fingerprints).
 *   2. When the loop exhausted all passes without converging, it exited
 *      silently with no "pass limit reached" diagnostic log.
 *   3. No deepReviewLoop.test.ts existed to catch these regressions.
 *
 * FIX (BEC-212):
 *   - `checkDeepReviewConvergence()` in executor/deep-review.ts provides
 *     fingerprint-based convergence detection.
 *   - runner.ts emits a structured `runLog.warn` diagnostic when the pass
 *     limit is reached without convergence.
 *   - deepReviewLoop.test.ts covers all 5 AC-required convergence scenarios.
 *
 * This file verifies the fixed state and serves as the regression anchor.
 */

import { describe, it, expect } from "vitest";
import { existsSync } from "fs";
import { join } from "path";
import type { ReviewFinding } from "../types.js";
import {
  checkDeepReviewConvergence,
  buildFindingFingerprint,
  buildNonConvergenceDiagnostic,
} from "../executor/deep-review.js";

// ---------------------------------------------------------------------------
// Confirm fixes are in place
// ---------------------------------------------------------------------------

describe("BEC-212 fix confirmation: deepReviewLoop.test.ts exists", () => {
  it("deepReviewLoop.test.ts is present in __tests__ directory", () => {
    const expectedPath = join(__dirname, "deepReviewLoop.test.ts");
    expect(existsSync(expectedPath)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Confirm convergence check uses fingerprints (not just counts)
// ---------------------------------------------------------------------------

function makeFinding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    severity: "warning",
    file: "src/foo.ts",
    line: 10,
    category: "duplicate-logic",
    description: "Filter logic duplicates existing utils",
    fix: "Import filterUsers from utils/filter.ts",
    ...overrides,
  };
}

const FINDING_A = makeFinding({ file: "src/a.ts", category: "a", description: "issue A" });
const FINDING_B = makeFinding({ file: "src/b.ts", category: "b", description: "issue B" });

describe("BEC-212 fix: convergence check uses fingerprint comparison", () => {
  it("loop continues when count decreases (genuine progress), even if no new findings", () => {
    // Previously a stable-fingerprints check incorrectly stopped the loop when
    // count dropped but all remaining findings were from the previous pass.
    // The fix: count decrease = genuine progress → loop continues.
    const fpA = buildFindingFingerprint(FINDING_A);
    const fpB = buildFindingFingerprint(FINDING_B);
    const prevFingerprints = new Set([fpA, fpB]);

    // Count drops 2→1, A persists (B was resolved).
    const result = checkDeepReviewConvergence(prevFingerprints, [FINDING_A], 2);

    expect(result.shouldStop).toBe(false);
    expect(result.converged).toBe(false);
    // findingsDiff still records what changed for diagnostics
    expect(result.findingsDiff.removed).toContain(fpB);
    expect(result.findingsDiff.common).toContain(fpA);
  });

  it("non-decreasing stops loop and exposes which findings are cycling via findingsDiff", () => {
    const fpA = buildFindingFingerprint(FINDING_A);
    const fpB = buildFindingFingerprint(FINDING_B);
    const prevFingerprints = new Set([fpA, fpB]);

    // Count stays at 2 (A and B repeat) → non-decreasing fires.
    const result = checkDeepReviewConvergence(prevFingerprints, [FINDING_A, FINDING_B], 2);

    expect(result.shouldStop).toBe(true);
    expect(result.reason).toBe("non-decreasing");
    // findingsDiff exposes the contradictory requirements: all findings in common
    expect(result.findingsDiff.common).toContain(fpA);
    expect(result.findingsDiff.common).toContain(fpB);
    expect(result.findingsDiff.added).toHaveLength(0);
    expect(result.findingsDiff.removed).toHaveLength(0);
  });

  it("loop continues when findings decrease with genuinely new content", () => {
    const fpA = buildFindingFingerprint(FINDING_A);
    const fpB = buildFindingFingerprint(FINDING_B);
    const prevFingerprints = new Set([fpA, fpB]);
    const newFinding = makeFinding({ file: "src/c.ts", category: "c", description: "new issue C" });

    // Count drops 2→1 and the remaining finding is NEW (not A or B).
    const result = checkDeepReviewConvergence(prevFingerprints, [newFinding], 2);

    expect(result.shouldStop).toBe(false);
    expect(result.converged).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Confirm diagnostic is emitted when pass limit hit
// ---------------------------------------------------------------------------

describe("BEC-212 fix: structured diagnostic when pass limit reached", () => {
  it("buildNonConvergenceDiagnostic produces correct structure", () => {
    const diff = {
      added: [],
      removed: [buildFindingFingerprint(FINDING_A)],
      common: [buildFindingFingerprint(FINDING_B)],
    };
    const diag = buildNonConvergenceDiagnostic(3, 3, 1, "pass-limit", diff, "2 files changed");

    expect(diag.passLimit).toBe(3);
    expect(diag.finalPass).toBe(3);
    expect(diag.finalFindingsCount).toBe(1);
    expect(diag.reason).toBe("pass-limit");
    expect(diag.diffStat).toBe("2 files changed");
    expect(diag.findingsDiff.removed).toHaveLength(1);
    expect(diag.findingsDiff.common).toHaveLength(1);
  });

  it("simulated loop emits diagnostic flag when pass limit exhausted with progress", () => {
    // Simulate the runner loop: findings decrease each pass but never reach 0.
    const FINDING_C = makeFinding({ file: "src/c.ts", category: "c", description: "issue C" });
    const findingsPerPass = [
      [FINDING_A, FINDING_B, FINDING_C],
      [FINDING_B, FINDING_C],
      [FINDING_C],
    ];
    const passLimit = 3;
    let previousFindingsCount = Infinity;
    let previousFingerprints = new Set<string>();
    let lastCheck: ReturnType<typeof checkDeepReviewConvergence> | null = null;

    for (let drPass = 1; drPass <= passLimit; drPass++) {
      const currentFindings = findingsPerPass[drPass - 1]!;
      const check = checkDeepReviewConvergence(previousFingerprints, currentFindings, previousFindingsCount);
      lastCheck = check;
      if (check.converged || check.shouldStop) break;
      previousFindingsCount = currentFindings.length;
      previousFingerprints = new Set(currentFindings.map(buildFindingFingerprint));
    }

    // After the loop: detect pass-limit non-convergence (BEC-212 fix).
    const shouldEmitDiagnostic =
      lastCheck !== null && !lastCheck.converged && !lastCheck.shouldStop;

    expect(shouldEmitDiagnostic).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Steps to reproduce the original incident
// ---------------------------------------------------------------------------

/**
 * Steps to reproduce pipeline 6q0OpgiRrke_Szkr1MFt0 accumulating 39 turns:
 *
 * 1. Configure: deepReviewPasses: 3, stages: ["implement", "review"]
 * 2. Run against an issue whose implementation has persistent quality issues
 *    that the agent can partially but not fully resolve each pass.
 * 3. Observe 3 full passes (implement + review each), with findings
 *    decreasing (e.g. 5→4→3) but not reaching zero.
 * 4. Each pass accumulates implement+review stage_runs.turns (~13/pass × 3 = 39).
 * 5. PRE-FIX: loop exits silently, no diagnostic, no fingerprint check.
 *    POST-FIX: runner emits runLog.warn with DeepReviewNonConvergenceDiagnostic
 *    including findingsDiff, diffStat, and convergence failure reason.
 */
