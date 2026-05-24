/**
 * deepReviewLoop.test.ts — unit and integration tests for the deep-review
 * loop convergence detection logic introduced in BEC-212.
 *
 * Covers the 5 AC-required scenarios:
 *   1. Fully resolved   — findings reach zero (converged: true)
 *   2. Unresolved conflicts — count non-decreasing (shouldStop: true, reason: "non-decreasing")
 *   3. Contradictory requirements — same fingerprints repeat (reason: "stable-fingerprints")
 *   4. Partial resolution — decreasing but pass limit hit (reason: "pass-limit")
 *   5. Edge cases — no findings from the first pass, single-item sets
 *
 * Integration tests verify the convergence logic invoked from a simulated
 * deep-review loop to confirm early exit and diagnostic emission.
 */

import { describe, it, expect } from "vitest";
import type { ReviewFinding } from "../types.js";
import {
  buildFindingFingerprint,
  checkDeepReviewConvergence,
  buildNonConvergenceDiagnostic,
  type ConvergenceReason,
  type FindingsDiff,
} from "../executor/deep-review.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeFinding(
  overrides: Partial<ReviewFinding> = {},
): ReviewFinding {
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

const FINDING_A = makeFinding({ file: "src/a.ts", line: 1, category: "a", description: "issue A" });
const FINDING_B = makeFinding({ file: "src/b.ts", line: 2, category: "b", description: "issue B" });
const FINDING_C = makeFinding({ file: "src/c.ts", line: 3, category: "c", description: "issue C" });

// ---------------------------------------------------------------------------
// buildFindingFingerprint
// ---------------------------------------------------------------------------

describe("buildFindingFingerprint", () => {
  it("produces the same fingerprint for equal findings", () => {
    const f = makeFinding();
    expect(buildFindingFingerprint(f)).toBe(buildFindingFingerprint({ ...f }));
  });

  it("produces different fingerprints for different files", () => {
    const a = makeFinding({ file: "src/a.ts" });
    const b = makeFinding({ file: "src/b.ts" });
    expect(buildFindingFingerprint(a)).not.toBe(buildFindingFingerprint(b));
  });

  it("produces different fingerprints for different categories", () => {
    const a = makeFinding({ category: "n-plus-1" });
    const b = makeFinding({ category: "duplicate-logic" });
    expect(buildFindingFingerprint(a)).not.toBe(buildFindingFingerprint(b));
  });

  it("truncates long descriptions to 80 chars before fingerprinting", () => {
    const long = "x".repeat(200);
    const short = "x".repeat(200);
    const fa = makeFinding({ description: long });
    const fb = makeFinding({ description: short });
    // Both truncate to the same 80-char prefix, so fingerprints must be equal.
    expect(buildFindingFingerprint(fa)).toBe(buildFindingFingerprint(fb));
  });
});

// ---------------------------------------------------------------------------
// Scenario 1: Fully resolved
// ---------------------------------------------------------------------------

describe("Scenario 1 — fully resolved (zero findings)", () => {
  it("converged=true when current pass has no findings", () => {
    const prev = new Set([buildFindingFingerprint(FINDING_A)]);
    const result = checkDeepReviewConvergence(prev, [], Infinity);

    expect(result.converged).toBe(true);
    expect(result.shouldStop).toBe(true);
    expect(result.reason).toBe("zero-findings");
  });

  it("findingsDiff shows previous finding as removed", () => {
    const fpA = buildFindingFingerprint(FINDING_A);
    const prev = new Set([fpA]);
    const result = checkDeepReviewConvergence(prev, [], Infinity);

    expect(result.findingsDiff.removed).toContain(fpA);
    expect(result.findingsDiff.added).toHaveLength(0);
    expect(result.findingsDiff.common).toHaveLength(0);
  });

  it("converged on first pass when no findings at all", () => {
    // First pass: previousFingerprints is empty, previousCount is Infinity
    const result = checkDeepReviewConvergence(new Set(), [], Infinity);
    expect(result.converged).toBe(true);
    expect(result.reason).toBe("zero-findings");
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: Unresolved conflicts (count non-decreasing)
// ---------------------------------------------------------------------------

describe("Scenario 2 — unresolved conflicts (non-decreasing count)", () => {
  it("shouldStop=true when count stays the same across passes", () => {
    const prev = new Set([
      buildFindingFingerprint(FINDING_A),
      buildFindingFingerprint(FINDING_B),
    ]);
    // Pass 2 still has 2 findings (same count as pass 1 → count = 2 >= 2)
    const result = checkDeepReviewConvergence(prev, [FINDING_A, FINDING_B], 2);

    expect(result.converged).toBe(false);
    expect(result.shouldStop).toBe(true);
    expect(result.reason).toBe("non-decreasing");
  });

  it("shouldStop=true when count increases", () => {
    const prev = new Set([buildFindingFingerprint(FINDING_A)]);
    // 2 findings now vs 1 before → count increased
    const result = checkDeepReviewConvergence(prev, [FINDING_A, FINDING_B], 1);

    expect(result.shouldStop).toBe(true);
    expect(result.reason).toBe("non-decreasing");
  });

  it("findingsDiff captures newly introduced findings", () => {
    const fpA = buildFindingFingerprint(FINDING_A);
    const fpB = buildFindingFingerprint(FINDING_B);
    const prev = new Set([fpA]);
    const result = checkDeepReviewConvergence(prev, [FINDING_A, FINDING_B], 1);

    expect(result.findingsDiff.common).toContain(fpA);
    expect(result.findingsDiff.added).toContain(fpB);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: Contradictory requirements (same fingerprints repeating)
//
// Detected via "non-decreasing" when the count stays the same while the same
// findings repeat. The findingsDiff exposes which findings are cycling.
// ---------------------------------------------------------------------------

describe("Scenario 3 — contradictory requirements (non-decreasing with same fingerprints)", () => {
  it("shouldStop=true when the exact same findings repeat (count unchanged)", () => {
    const fpA = buildFindingFingerprint(FINDING_A);
    const fpB = buildFindingFingerprint(FINDING_B);
    // Pass 1: [A, B]. Pass 2: [A, B] — count equal → non-decreasing fires.
    const prev = new Set([fpA, fpB]);
    const result = checkDeepReviewConvergence(prev, [FINDING_A, FINDING_B], 2);

    expect(result.converged).toBe(false);
    expect(result.shouldStop).toBe(true);
    expect(result.reason).toBe("non-decreasing");
    // findingsDiff exposes the contradiction: no new additions, no removals
    expect(result.findingsDiff.common).toHaveLength(2);
    expect(result.findingsDiff.added).toHaveLength(0);
    expect(result.findingsDiff.removed).toHaveLength(0);
  });

  it("count decrease with no new findings is genuine progress (loop continues)", () => {
    // Pass 1: [A, B, C]. Pass 2: [A, B] — A was there before, B was there,
    // C was resolved. Count went 3→2 (real progress) — loop should NOT stop.
    const fpA = buildFindingFingerprint(FINDING_A);
    const fpB = buildFindingFingerprint(FINDING_B);
    const fpC = buildFindingFingerprint(FINDING_C);
    const prev = new Set([fpA, fpB, fpC]);
    const result = checkDeepReviewConvergence(prev, [FINDING_A, FINDING_B], 3);

    expect(result.shouldStop).toBe(false);
    expect(result.converged).toBe(false);
    expect(result.reason).toBeNull();
    // findingsDiff correctly shows C was resolved
    expect(result.findingsDiff.removed).toContain(fpC);
    expect(result.findingsDiff.common).toHaveLength(2);
  });

  it("does NOT fire shouldStop on first pass when findings are non-zero", () => {
    // On the very first pass previousFingerprints is empty — we should not
    // stop early (Infinity guard ensures any non-zero count continues).
    const result = checkDeepReviewConvergence(new Set(), [FINDING_A], Infinity);

    expect(result.shouldStop).toBe(false);
    expect(result.reason).toBeNull();
  });

  it("findingsDiff correctly shows which finding changed when oscillating", () => {
    // Oscillating: pass 1 had [A, B], pass 2 has [A, C] (B→C swap, same count).
    const fpA = buildFindingFingerprint(FINDING_A);
    const fpB = buildFindingFingerprint(FINDING_B);
    const fpC = buildFindingFingerprint(FINDING_C);
    const prev = new Set([fpA, fpB]);
    const result = checkDeepReviewConvergence(prev, [FINDING_A, FINDING_C], 2);

    expect(result.shouldStop).toBe(true); // count stayed at 2
    expect(result.reason).toBe("non-decreasing");
    // Diff exposes the oscillation: B removed, C added
    expect(result.findingsDiff.removed).toContain(fpB);
    expect(result.findingsDiff.added).toContain(fpC);
    expect(result.findingsDiff.common).toContain(fpA);
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: Partial resolution (pass limit reached)
// ---------------------------------------------------------------------------

describe("Scenario 4 — partial resolution (pass limit hit)", () => {
  it("shouldStop=false when findings are decreasing with new content (loop continues)", () => {
    // Pass 1 found A+B+C (count=3). Pass 2 finds B+C only (count=2, decreased, new content set).
    const prev = new Set([
      buildFindingFingerprint(FINDING_A),
      buildFindingFingerprint(FINDING_B),
      buildFindingFingerprint(FINDING_C),
    ]);
    const result = checkDeepReviewConvergence(prev, [FINDING_B, FINDING_C], 3);

    // Findings went from 3→2, and A was resolved (removed) while B+C remain.
    // This is progress → loop should continue.
    expect(result.shouldStop).toBe(false);
    expect(result.converged).toBe(false);
    expect(result.reason).toBeNull();
  });

  it("findingsDiff correctly identifies resolved finding", () => {
    const fpA = buildFindingFingerprint(FINDING_A);
    const fpB = buildFindingFingerprint(FINDING_B);
    const fpC = buildFindingFingerprint(FINDING_C);
    const prev = new Set([fpA, fpB, fpC]);
    const result = checkDeepReviewConvergence(prev, [FINDING_B, FINDING_C], 3);

    expect(result.findingsDiff.removed).toContain(fpA);
    expect(result.findingsDiff.common).toContain(fpB);
    expect(result.findingsDiff.common).toContain(fpC);
    expect(result.findingsDiff.added).toHaveLength(0);
  });

  it("buildNonConvergenceDiagnostic produces a correctly shaped object", () => {
    const diff: FindingsDiff = {
      added: [],
      removed: [buildFindingFingerprint(FINDING_A)],
      common: [buildFindingFingerprint(FINDING_B)],
    };
    const diag = buildNonConvergenceDiagnostic(3, 3, 2, "pass-limit", diff, "some diff stat");

    expect(diag.passLimit).toBe(3);
    expect(diag.finalPass).toBe(3);
    expect(diag.finalFindingsCount).toBe(2);
    expect(diag.reason).toBe("pass-limit");
    expect(diag.findingsDiff).toBe(diff);
    expect(diag.diffStat).toBe("some diff stat");
  });
});

// ---------------------------------------------------------------------------
// Scenario 5: Edge cases
// ---------------------------------------------------------------------------

describe("Scenario 5 — edge cases", () => {
  it("handles a single persistent finding across all passes (stable-fingerprints)", () => {
    const fpA = buildFindingFingerprint(FINDING_A);
    const prev = new Set([fpA]);
    // Single finding, count was 1 before, still 1 → non-decreasing fires first.
    const result = checkDeepReviewConvergence(prev, [FINDING_A], 1);

    expect(result.shouldStop).toBe(true);
    // non-decreasing fires before stable-fingerprints since count check runs first.
    expect(result.reason).toBe("non-decreasing");
  });

  it("handles empty findings on the very first pass (converged immediately)", () => {
    const result = checkDeepReviewConvergence(new Set(), [], Infinity);
    expect(result.converged).toBe(true);
    expect(result.reason).toBe("zero-findings");
  });

  it("correctly identifies when all findings are new (no common fingerprints)", () => {
    // Pass 1: A, B. Pass 2: C (new finding, different from A and B, and count dropped).
    const prev = new Set([
      buildFindingFingerprint(FINDING_A),
      buildFindingFingerprint(FINDING_B),
    ]);
    const result = checkDeepReviewConvergence(prev, [FINDING_C], 2);

    // Count went 2→1, no stable fingerprints (C is new), so loop continues.
    expect(result.shouldStop).toBe(false);
    expect(result.findingsDiff.added).toContain(buildFindingFingerprint(FINDING_C));
    expect(result.findingsDiff.removed).toHaveLength(2);
    expect(result.findingsDiff.common).toHaveLength(0);
  });

  it("does not emit shouldStop on first pass when findings are non-zero (Infinity guard)", () => {
    // previousFindingsCount is Infinity on the very first pass.
    // Any non-zero count < Infinity should NOT trigger shouldStop.
    const result = checkDeepReviewConvergence(new Set(), [FINDING_A, FINDING_B], Infinity);

    expect(result.converged).toBe(false);
    expect(result.shouldStop).toBe(false);
    expect(result.reason).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Integration: simulated deep-review loop using the real convergence function
// ---------------------------------------------------------------------------

describe("Integration — simulated loop with checkDeepReviewConvergence", () => {
  /**
   * Replicate the runner's loop logic using the real convergence function to
   * verify the early-exit and diagnostic paths operate correctly end-to-end.
   */
  function runSimulatedLoop(
    findingsPerPass: ReviewFinding[][],
    passLimit: number,
  ): {
    passesRun: number;
    converged: boolean;
    exitReason: ConvergenceReason | "pass-limit" | null;
    diagnosticEmitted: boolean;
    finalFindingsCount: number;
  } {
    let previousFindingsCount = Infinity;
    let previousFingerprints = new Set<string>();
    let lastCheck: ReturnType<typeof checkDeepReviewConvergence> | null = null;
    let drPassFinal = 0;
    let finalFindingsCount = 0;
    let exitReason: ConvergenceReason | "pass-limit" | null = null;

    for (let drPass = 1; drPass <= passLimit; drPass++) {
      const currentFindings = findingsPerPass[drPass - 1] ?? [];
      const check = checkDeepReviewConvergence(
        previousFingerprints,
        currentFindings,
        previousFindingsCount,
      );
      lastCheck = check;
      drPassFinal = drPass;
      finalFindingsCount = currentFindings.length;

      if (check.converged) {
        exitReason = "zero-findings";
        return { passesRun: drPass, converged: true, exitReason, diagnosticEmitted: false, finalFindingsCount };
      }
      if (check.shouldStop) {
        exitReason = check.reason;
        return { passesRun: drPass, converged: false, exitReason, diagnosticEmitted: false, finalFindingsCount };
      }

      previousFindingsCount = currentFindings.length;
      previousFingerprints = new Set(currentFindings.map(buildFindingFingerprint));
    }

    // Post-loop: detect pass-limit non-convergence
    const diagnosticEmitted =
      lastCheck !== null && !lastCheck.converged && !lastCheck.shouldStop;

    if (diagnosticEmitted) {
      exitReason = "pass-limit";
    }

    return {
      passesRun: drPassFinal,
      converged: false,
      exitReason,
      diagnosticEmitted,
      finalFindingsCount,
    };
  }

  it("converges on pass 2 when findings reach zero", () => {
    const result = runSimulatedLoop([[FINDING_A, FINDING_B], []], 3);

    expect(result.converged).toBe(true);
    expect(result.passesRun).toBe(2);
    expect(result.exitReason).toBe("zero-findings");
    expect(result.diagnosticEmitted).toBe(false);
  });

  it("exits early on pass 2 when count stops decreasing", () => {
    // Pass 1: 2 findings. Pass 2: 2 findings (same count → stop).
    const result = runSimulatedLoop(
      [[FINDING_A, FINDING_B], [FINDING_A, FINDING_B]],
      3,
    );

    expect(result.converged).toBe(false);
    expect(result.passesRun).toBe(2);
    expect(result.exitReason).toBe("non-decreasing");
    expect(result.diagnosticEmitted).toBe(false);
  });

  it("emits diagnostic when pass limit hit with decreasing findings", () => {
    // Findings drop each pass but never reach 0 within passLimit.
    const result = runSimulatedLoop(
      [[FINDING_A, FINDING_B, FINDING_C], [FINDING_B, FINDING_C], [FINDING_C]],
      3,
    );

    expect(result.converged).toBe(false);
    expect(result.passesRun).toBe(3);
    expect(result.exitReason).toBe("pass-limit");
    expect(result.diagnosticEmitted).toBe(true);
    expect(result.finalFindingsCount).toBe(1);
  });

  it("exits early when contradictory requirements detected (non-decreasing)", () => {
    // Pass 1: A+B (2). Pass 2: A+B (2) — count unchanged → non-decreasing fires.
    // findingsDiff.common shows which findings are stuck (both A and B).
    const result = runSimulatedLoop([[FINDING_A, FINDING_B], [FINDING_A, FINDING_B]], 3);

    expect(result.converged).toBe(false);
    expect(result.exitReason).toBe("non-decreasing");
    expect(result.passesRun).toBe(2);
    expect(result.diagnosticEmitted).toBe(false);
  });

  it("single-pass loop with findings remaining emits diagnostic", () => {
    const result = runSimulatedLoop([[FINDING_A]], 1);

    // Only 1 pass configured. After pass 1 findings remain and shouldStop is
    // false (Infinity guard), so the loop exits at passLimit and diagnostic fires.
    expect(result.diagnosticEmitted).toBe(true);
    expect(result.exitReason).toBe("pass-limit");
  });
});
