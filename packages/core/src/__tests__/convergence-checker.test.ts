/**
 * Tests for packages/core/src/pipeline/convergence-checker.ts (BEC-213).
 *
 * Covers:
 *   - fingerprintFinding: stable identity key for a ReviewFinding
 *   - isConverged: content-based convergence detection
 *   - buildMisalignmentReport: diagnostic output for stalled loops
 *   - MAX_REVIEW_TURNS constant value (≤ 15 per ACs)
 *
 * The tests exercise both the pure utility functions AND the scenarios that
 * caused the BEC-213 incident: cycles with the same number of different
 * findings that the old count-based check would have incorrectly treated as
 * converged.
 */
import { describe, it, expect } from "vitest";
import {
  fingerprintFinding,
  isConverged,
  buildMisalignmentReport,
  MAX_REVIEW_TURNS,
  type CycleRecord,
} from "../pipeline/convergence-checker.js";
import type { ReviewFinding } from "../types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const makeF = (
  file: string,
  line: number,
  category: string,
  description: string,
  severity: "blocking" | "warning" | "suggestion" = "blocking",
): ReviewFinding => ({ file, line, category, description, severity, fix: "fix it" });

const nullCheck = makeF("src/api.ts", 12, "null-deref", "Missing null check");
const unusedImport = makeF("src/api.ts", 3, "unused-import", "Unused import");
const offByOne = makeF("src/util.ts", 55, "off-by-one", "Off-by-one in slice");
const typeAnnotation = makeF("src/model.ts", 7, "missing-type", "Missing type annotation");

// ---------------------------------------------------------------------------
// MAX_REVIEW_TURNS
// ---------------------------------------------------------------------------

describe("MAX_REVIEW_TURNS", () => {
  it("is ≤ 15 (AC requirement: must be significantly lower than 33)", () => {
    expect(MAX_REVIEW_TURNS).toBeLessThanOrEqual(15);
  });

  it("is > 0 (pipelines still need at least one cycle)", () => {
    expect(MAX_REVIEW_TURNS).toBeGreaterThan(0);
  });

  it("is 15 (the default value documented in BEC-213)", () => {
    expect(MAX_REVIEW_TURNS).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// fingerprintFinding
// ---------------------------------------------------------------------------

describe("fingerprintFinding", () => {
  it("returns a non-empty string", () => {
    expect(fingerprintFinding(nullCheck).length).toBeGreaterThan(0);
  });

  it("produces the same fingerprint for identical findings", () => {
    const copy = { ...nullCheck };
    expect(fingerprintFinding(copy)).toBe(fingerprintFinding(nullCheck));
  });

  it("produces different fingerprints for different files", () => {
    const different = makeF("src/other.ts", 12, "null-deref", "Missing null check");
    expect(fingerprintFinding(different)).not.toBe(fingerprintFinding(nullCheck));
  });

  it("produces different fingerprints for different lines", () => {
    const different = makeF("src/api.ts", 99, "null-deref", "Missing null check");
    expect(fingerprintFinding(different)).not.toBe(fingerprintFinding(nullCheck));
  });

  it("produces different fingerprints for different categories", () => {
    const different = makeF("src/api.ts", 12, "type-error", "Missing null check");
    expect(fingerprintFinding(different)).not.toBe(fingerprintFinding(nullCheck));
  });

  it("produces different fingerprints for different descriptions", () => {
    const different = makeF("src/api.ts", 12, "null-deref", "Different description");
    expect(fingerprintFinding(different)).not.toBe(fingerprintFinding(nullCheck));
  });

  it("ignores severity — same issue at different severity is the same identity", () => {
    const warning = { ...nullCheck, severity: "warning" as const };
    const blocking = { ...nullCheck, severity: "blocking" as const };
    // Fingerprint is based on location+category+description, not severity.
    expect(fingerprintFinding(warning)).toBe(fingerprintFinding(blocking));
  });
});

// ---------------------------------------------------------------------------
// isConverged — condition (a): empty findings
// ---------------------------------------------------------------------------

describe("isConverged — condition (a): empty findings", () => {
  it("returns true when current is empty (no findings left)", () => {
    expect(isConverged([], [])).toBe(true);
    expect(isConverged([], [nullCheck])).toBe(true);
    expect(isConverged([], [nullCheck, unusedImport])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isConverged — condition (b): same content as previous cycle
// ---------------------------------------------------------------------------

describe("isConverged — condition (b): content-based identity", () => {
  it("returns true when current findings exactly match previous by content", () => {
    const current = [nullCheck, unusedImport];
    const previous = [nullCheck, unusedImport];
    expect(isConverged(current, previous)).toBe(true);
  });

  it("returns true even when findings appear in different order", () => {
    const current = [unusedImport, nullCheck];
    const previous = [nullCheck, unusedImport];
    expect(isConverged(current, previous)).toBe(true);
  });

  it("returns true for single identical finding", () => {
    expect(isConverged([nullCheck], [nullCheck])).toBe(true);
  });

  // BEC-213 bug reproduction: the OLD count-only check would treat two
  // cycles with the same COUNT but different findings as converged.
  it("returns FALSE for same count but different findings (was BEC-213 bug)", () => {
    // cycle 1: 2 findings — null-deref + unused-import
    const cycle1 = [nullCheck, unusedImport];
    // cycle 2: 2 findings — different issues entirely
    const cycle2 = [offByOne, typeAnnotation];

    // Old code: cycle2.length (2) >= cycle1.length (2) → break (WRONG)
    expect(cycle2.length >= cycle1.length).toBe(true); // demonstrates the old bug

    // New code: content-based → not converged
    expect(isConverged(cycle2, cycle1)).toBe(false);
  });

  it("returns false when current has more findings than previous", () => {
    expect(isConverged([nullCheck, unusedImport], [nullCheck])).toBe(false);
  });

  it("returns false when current has fewer findings than previous", () => {
    expect(isConverged([nullCheck], [nullCheck, unusedImport])).toBe(false);
  });

  it("returns false when findings partially overlap", () => {
    const current = [nullCheck, offByOne];
    const previous = [nullCheck, unusedImport];
    expect(isConverged(current, previous)).toBe(false);
  });

  it("returns false when previous is empty but current is not", () => {
    // First pass: previousDrFindings starts as []; new findings found → not converged
    expect(isConverged([nullCheck], [])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isConverged — convergent sequences across multiple cycles
// ---------------------------------------------------------------------------

describe("isConverged — multi-cycle convergence scenarios", () => {
  it("detects convergence when cycle repeats (implement made no progress)", () => {
    // Simulate: cycle 1 → [A, B], cycle 2 → [A, B] (implement didn't fix them)
    const findings = [nullCheck, unusedImport];
    let previous: ReviewFinding[] = [];
    let converged = false;

    for (let pass = 1; pass <= 5; pass++) {
      if (isConverged(findings, previous)) {
        converged = true;
        break;
      }
      previous = findings;
    }

    // Should converge on pass 2 (pass 1: previous=[], not converged; pass 2: previous=findings → converged)
    expect(converged).toBe(true);
  });

  it("detects convergence when findings resolve to empty", () => {
    const findingsByPass = [
      [nullCheck, unusedImport],
      [nullCheck], // partial progress
      [],          // fully resolved
    ];
    let previous: ReviewFinding[] = [];
    let convergedAt = -1;

    for (let i = 0; i < findingsByPass.length; i++) {
      if (isConverged(findingsByPass[i], previous)) {
        convergedAt = i;
        break;
      }
      previous = findingsByPass[i];
    }

    expect(convergedAt).toBe(2); // converges at pass 3 (empty findings)
  });

  it("does NOT falsely converge when findings are genuinely decreasing", () => {
    // Simulate a healthy loop: each pass fixes one issue
    const findingsByPass = [
      [nullCheck, unusedImport, offByOne],
      [unusedImport, offByOne], // null check fixed
      [offByOne],               // unused import fixed
      [],                       // all fixed
    ];
    let previous: ReviewFinding[] = [];
    let earlyConverge = false;

    for (let i = 0; i < findingsByPass.length - 1; i++) {
      if (isConverged(findingsByPass[i], previous)) {
        earlyConverge = true;
        break;
      }
      previous = findingsByPass[i];
    }

    // None of the intermediate passes should falsely converge
    expect(earlyConverge).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildMisalignmentReport
// ---------------------------------------------------------------------------

describe("buildMisalignmentReport", () => {
  const cycles: CycleRecord[] = [
    { pass: 1, findings: [nullCheck, unusedImport] },
    { pass: 2, findings: [nullCheck, unusedImport] }, // same findings — stalled
  ];

  it("includes the cycle count in the header", () => {
    const report = buildMisalignmentReport(cycles);
    expect(report).toContain("2 cycle");
  });

  it("includes pass numbers for each cycle", () => {
    const report = buildMisalignmentReport(cycles);
    expect(report).toContain("Pass 1");
    expect(report).toContain("Pass 2");
  });

  it("includes finding file and line", () => {
    const report = buildMisalignmentReport(cycles);
    expect(report).toContain("src/api.ts:12");
  });

  it("includes finding severity and category", () => {
    const report = buildMisalignmentReport(cycles);
    expect(report).toContain("[blocking]");
    expect(report).toContain("null-deref");
  });

  it("includes diff lines when provided", () => {
    const withDiff: CycleRecord[] = [
      { pass: 1, findings: [nullCheck], diff: "diff --git a/src/api.ts b/src/api.ts\n+const x = foo ?? 0;" },
    ];
    const report = buildMisalignmentReport(withDiff);
    expect(report).toContain("diff --git");
    expect(report).toContain("const x = foo");
  });

  it("handles empty findings gracefully", () => {
    const report = buildMisalignmentReport([{ pass: 1, findings: [] }]);
    expect(report).toContain("(none)");
  });

  it("returns a non-empty string for empty cycles array", () => {
    const report = buildMisalignmentReport([]);
    expect(report.length).toBeGreaterThan(0);
  });

  it("truncates diffs longer than 40 lines", () => {
    const longDiff = Array.from({ length: 100 }, (_, i) => `+line ${i}`).join("\n");
    const report = buildMisalignmentReport([{ pass: 1, findings: [], diff: longDiff }]);
    // 40 lines × ~10 chars = truncated; the original 100 lines should not appear
    const reportLines = report.split("\n");
    // Diff section should have at most 40 content lines (plus header line)
    const diffSectionStart = reportLines.findIndex((l) => l.includes("Implement diff"));
    if (diffSectionStart >= 0) {
      const diffLines = reportLines.slice(diffSectionStart + 1);
      expect(diffLines.length).toBeLessThanOrEqual(41); // 40 diff lines + possible empty
    }
  });
});

// ---------------------------------------------------------------------------
// Integration-level: enforce iteration limits
// ---------------------------------------------------------------------------

describe("iteration limit enforcement (condition c: maxReviewTurns)", () => {
  it("a loop that checks reviewTurns >= MAX_REVIEW_TURNS terminates before 33 iterations", () => {
    // Simulate the deep-review loop driver logic that runner.ts uses.
    // This verifies that the guard works correctly end-to-end.
    let reviewTurns = 0;
    let terminated = false;

    // Findings never change — implement never fixes them
    const persistentFindings = [nullCheck, unusedImport];
    let previousDrFindings: ReviewFinding[] = [];

    for (let drPass = 1; drPass <= 100; drPass++) {
      // Condition (c): hard cap
      if (reviewTurns >= MAX_REVIEW_TURNS) {
        terminated = true;
        break;
      }

      // Condition (a): no findings
      if (persistentFindings.length === 0) break;

      // Condition (b): same as previous
      if (isConverged(persistentFindings, previousDrFindings)) break;

      previousDrFindings = persistentFindings;

      // Simulate implement + review (no progress)
      reviewTurns++;
    }

    expect(terminated || reviewTurns <= MAX_REVIEW_TURNS).toBe(true);
    expect(reviewTurns).toBeLessThanOrEqual(MAX_REVIEW_TURNS);

    // Crucially: this is well below the 33-turn incident
    expect(reviewTurns).toBeLessThan(33);
  });

  it("content-based convergence terminates stagnant loops before the cap", () => {
    // Findings stay the same every cycle → isConverged fires on cycle 2
    const persistentFindings = [nullCheck];
    let previousDrFindings: ReviewFinding[] = [];
    let reviewTurns = 0;
    let converged = false;

    for (let drPass = 1; drPass <= MAX_REVIEW_TURNS + 10; drPass++) {
      if (reviewTurns >= MAX_REVIEW_TURNS) break;
      if (isConverged(persistentFindings, previousDrFindings)) {
        converged = true;
        break;
      }
      previousDrFindings = persistentFindings;
      reviewTurns++;
    }

    // Content-based convergence stops after 1 turn (cycle 2: same findings → converged)
    expect(converged).toBe(true);
    expect(reviewTurns).toBe(1); // only 1 turn before content-convergence fires
  });
});
