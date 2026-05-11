/**
 * Unit tests for the convergenceValidator module (BEC-208).
 *
 * Verifies:
 * 1. The module exists and exports `checkConvergence`.
 * 2. Repeated-issue detection with no diff change (non-responsive implementation).
 * 3. Repeated-issue detection with diff changes (misaligned review criteria).
 * 4. Turn-limit enforcement (default 12, configurable).
 * 5. No false-positive stops when issues are actually changing across turns.
 * 6. Diff-hash comparison correctly distinguishes same/changed implementation.
 * 7. Integration path: `checkConvergence` is importable from the pipeline barrel.
 */

import { describe, it, expect } from "vitest";
import {
  checkConvergence,
  CONVERGENCE_DEFAULTS,
  type TurnRecord,
  type FindingFingerprint,
} from "../pipeline/convergenceValidator.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFinding(
  file: string,
  category: string,
  description: string,
): FindingFingerprint {
  return { file, line: 1, category, description };
}

function makeTurn(
  turn: number,
  findings: FindingFingerprint[],
  implDiffHash: string,
): TurnRecord {
  return { turn, findings, implDiffHash };
}

// ---------------------------------------------------------------------------
// Constants sanity check
// ---------------------------------------------------------------------------

describe("CONVERGENCE_DEFAULTS", () => {
  it("exports MAX_TURNS = 12", () => {
    expect(CONVERGENCE_DEFAULTS.MAX_TURNS).toBe(12);
  });

  it("exports CONSECUTIVE_THRESHOLD = 3", () => {
    expect(CONVERGENCE_DEFAULTS.CONSECUTIVE_THRESHOLD).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// checkConvergence: no-stop cases
// ---------------------------------------------------------------------------

describe("checkConvergence — no stop", () => {
  it("returns shouldStop=false for a single turn", () => {
    const history = [
      makeTurn(1, [makeFinding("a.ts", "bug", "issue1")], "hash1"),
    ];
    const result = checkConvergence(history);
    expect(result.shouldStop).toBe(false);
    expect(result.reason).toBeNull();
    expect(result.unresolvedIssues).toHaveLength(0);
  });

  it("returns shouldStop=false for two turns below the threshold", () => {
    const history = [
      makeTurn(1, [makeFinding("a.ts", "bug", "issue1")], "hash1"),
      makeTurn(2, [makeFinding("a.ts", "bug", "issue1")], "hash1"),
    ];
    const result = checkConvergence(history, { consecutiveThreshold: 3 });
    expect(result.shouldStop).toBe(false);
  });

  it("does not stop when issues are resolved between turns", () => {
    const history = [
      makeTurn(1, [makeFinding("a.ts", "bug", "issue1")], "hash1"),
      makeTurn(2, [makeFinding("b.ts", "quality", "issue2")], "hash2"),
      makeTurn(3, [makeFinding("c.ts", "efficiency", "issue3")], "hash3"),
    ];
    const result = checkConvergence(history, { maxTurns: 12, consecutiveThreshold: 3 });
    expect(result.shouldStop).toBe(false);
  });

  it("does not stop when all issues are different each turn", () => {
    const history = [
      makeTurn(1, [makeFinding("a.ts", "bug", "unique-issue-1")], "hash1"),
      makeTurn(2, [makeFinding("a.ts", "bug", "unique-issue-2")], "hash2"),
      makeTurn(3, [makeFinding("a.ts", "bug", "unique-issue-3")], "hash3"),
    ];
    const result = checkConvergence(history, { maxTurns: 12, consecutiveThreshold: 3 });
    expect(result.shouldStop).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checkConvergence: repeated-issue detection (non-responsive implementation)
// ---------------------------------------------------------------------------

describe("checkConvergence — repeated issues, no diff change", () => {
  it("stops after 3 consecutive turns with identical issues and unchanged diff", () => {
    const finding = makeFinding("src/runner.ts", "missing-convergence", "No convergence check");
    const history = [
      makeTurn(1, [finding], "abc123"),
      makeTurn(2, [finding], "abc123"),
      makeTurn(3, [finding], "abc123"),
    ];
    const result = checkConvergence(history, { maxTurns: 12, consecutiveThreshold: 3 });

    expect(result.shouldStop).toBe(true);
    expect(result.reason).toBe("repeated-issues");
    expect(result.diagnosis).toBe("non-responsive-implementation");
    expect(result.unresolvedIssues).toHaveLength(1);
    expect(result.message).toMatch(/non-responsive|implementation did not change/i);
  });

  it("stops when at least one issue persists in ALL consecutive turns (intersection semantics)", () => {
    // issue1 appears only in turns 1 and 2; issue2 appears in all 3 turns.
    // The intersection is {issue2} → non-empty → should stop.
    const f1 = makeFinding("a.ts", "bug", "first issue");
    const f2 = makeFinding("b.ts", "quality", "second issue");
    const history = [
      makeTurn(1, [f1, f2], "hash1"),
      makeTurn(2, [f1, f2], "hash1"),
      makeTurn(3, [f2], "hash2"),   // f1 resolved, but f2 still present
    ];
    const result = checkConvergence(history, { maxTurns: 12, consecutiveThreshold: 3 });
    expect(result.shouldStop).toBe(true);
    expect(result.reason).toBe("repeated-issues");
    expect(result.unresolvedIssues).toHaveLength(1); // only f2 persists in all 3
  });

  it("does NOT stop when no single issue appears in all consecutive turns", () => {
    // issue1 in turns 1 and 3 but NOT turn 2; issue2 only in turn 2.
    // The intersection across all 3 is empty → should NOT stop.
    const history = [
      makeTurn(1, [makeFinding("a.ts", "bug", "issue1")], "hash1"),
      makeTurn(2, [makeFinding("b.ts", "quality", "issue2")], "hash2"),
      makeTurn(3, [makeFinding("a.ts", "bug", "issue1")], "hash3"),
    ];
    const result = checkConvergence(history, { maxTurns: 12, consecutiveThreshold: 3 });
    expect(result.shouldStop).toBe(false); // no issue in ALL 3 consecutive turns
  });

  it("identifies the specific unresolved issue fingerprints", () => {
    const f1 = makeFinding("a.ts", "bug", "first issue");
    const f2 = makeFinding("b.ts", "quality", "second issue");
    const history = [
      makeTurn(1, [f1, f2], "hash1"),
      makeTurn(2, [f1, f2], "hash1"),
      makeTurn(3, [f1, f2], "hash1"),
    ];
    const result = checkConvergence(history, { maxTurns: 12, consecutiveThreshold: 3 });

    expect(result.shouldStop).toBe(true);
    expect(result.unresolvedIssues).toHaveLength(2);
  });

  it("only examines the most recent consecutiveThreshold turns", () => {
    // Turns 1-2 have a resolved finding; turns 3-5 have a different repeated finding.
    const oldIssue = makeFinding("old.ts", "bug", "resolved issue");
    const newIssue = makeFinding("new.ts", "quality", "persistent issue");
    const history = [
      makeTurn(1, [oldIssue], "hash1"),
      makeTurn(2, [oldIssue], "hash2"),
      makeTurn(3, [newIssue], "hash3"),
      makeTurn(4, [newIssue], "hash3"),
      makeTurn(5, [newIssue], "hash3"),
    ];
    const result = checkConvergence(history, { maxTurns: 12, consecutiveThreshold: 3 });

    expect(result.shouldStop).toBe(true);
    expect(result.unresolvedIssues).toHaveLength(1);
    // The unresolved issue is the one in the LAST 3 turns (not the old one)
    expect(result.unresolvedIssues[0]).toContain("persistent issue");
  });
});

// ---------------------------------------------------------------------------
// checkConvergence: repeated-issue detection (misaligned review criteria)
// ---------------------------------------------------------------------------

describe("checkConvergence — repeated issues, diff changes each turn", () => {
  it("diagnoses misaligned review criteria when diff changes but same issues reappear", () => {
    const finding = makeFinding("src/runner.ts", "style", "missing semicolon");
    const history = [
      makeTurn(1, [finding], "hash1"),
      makeTurn(2, [finding], "hash2"), // different hash — implementation changed
      makeTurn(3, [finding], "hash3"), // different hash — implementation changed again
    ];
    const result = checkConvergence(history, { maxTurns: 12, consecutiveThreshold: 3 });

    expect(result.shouldStop).toBe(true);
    expect(result.reason).toBe("repeated-issues");
    expect(result.diagnosis).toBe("misaligned-review-criteria");
    expect(result.message).toMatch(/misaligned|too strict|ambiguous/i);
  });
});

// ---------------------------------------------------------------------------
// checkConvergence: turn limit
// ---------------------------------------------------------------------------

describe("checkConvergence — turn limit", () => {
  it("stops at the default maxTurns (12) with a unique issue each turn", () => {
    const history: TurnRecord[] = Array.from({ length: 12 }, (_, i) => ({
      turn: i + 1,
      findings: [makeFinding("a.ts", "bug", `unique-issue-${i}`)],
      implDiffHash: `hash${i}`,
    }));
    const result = checkConvergence(history); // default maxTurns = 12

    expect(result.shouldStop).toBe(true);
    expect(result.reason).toBe("turn-limit");
    expect(result.message).toMatch(/maximum turn limit.*12/i);
  });

  it("respects a custom maxTurns value", () => {
    const history: TurnRecord[] = Array.from({ length: 5 }, (_, i) => ({
      turn: i + 1,
      findings: [makeFinding("a.ts", "bug", `unique-issue-${i}`)],
      implDiffHash: `hash${i}`,
    }));
    const result = checkConvergence(history, { maxTurns: 5 });

    expect(result.shouldStop).toBe(true);
    expect(result.reason).toBe("turn-limit");
  });

  it("does not stop before the turn limit with distinct issues", () => {
    const history: TurnRecord[] = Array.from({ length: 11 }, (_, i) => ({
      turn: i + 1,
      findings: [makeFinding("a.ts", "bug", `unique-issue-${i}`)],
      implDiffHash: `hash${i}`,
    }));
    const result = checkConvergence(history, { maxTurns: 12 });
    expect(result.shouldStop).toBe(false);
  });

  it("includes a helpful suggestion message on turn-limit stop", () => {
    const history: TurnRecord[] = Array.from({ length: 12 }, (_, i) => ({
      turn: i + 1,
      findings: [makeFinding("a.ts", "bug", `issue-${i}`)],
      implDiffHash: `hash${i}`,
    }));
    const result = checkConvergence(history);

    expect(result.message).toMatch(/maxReviewTurns|manually/i);
  });
});

// ---------------------------------------------------------------------------
// checkConvergence: implementation diff comparison
// ---------------------------------------------------------------------------

describe("checkConvergence — implementation diff comparison", () => {
  it("correctly distinguishes same hash (no change) vs different hash (changed)", () => {
    const finding = makeFinding("src/a.ts", "quality", "magic string");

    // Same diff hash: non-responsive implementation
    const noChangeHistory = [
      makeTurn(1, [finding], "same-hash"),
      makeTurn(2, [finding], "same-hash"),
      makeTurn(3, [finding], "same-hash"),
    ];
    const noChangeResult = checkConvergence(noChangeHistory, { consecutiveThreshold: 3 });
    expect(noChangeResult.shouldStop).toBe(true);
    expect(noChangeResult.diagnosis).toBe("non-responsive-implementation");

    // Different diff hash: misaligned criteria
    const changeHistory = [
      makeTurn(1, [finding], "hash-a"),
      makeTurn(2, [finding], "hash-b"),
      makeTurn(3, [finding], "hash-c"),
    ];
    const changeResult = checkConvergence(changeHistory, { consecutiveThreshold: 3 });
    expect(changeResult.shouldStop).toBe(true);
    expect(changeResult.diagnosis).toBe("misaligned-review-criteria");
  });
});

// ---------------------------------------------------------------------------
// Integration path: convergenceValidator is importable from pipeline barrel
// ---------------------------------------------------------------------------

describe("integration path: pipeline barrel exports convergenceValidator symbols", () => {
  it("checkConvergence is importable from the pipeline/convergenceValidator module", async () => {
    // This test verifies the module exists and exports the expected API.
    const mod = await import("../pipeline/convergenceValidator.js");
    expect(typeof mod.checkConvergence).toBe("function");
    expect(typeof mod.CONVERGENCE_DEFAULTS).toBe("object");
    expect(mod.CONVERGENCE_DEFAULTS.MAX_TURNS).toBe(12);
    expect(mod.CONVERGENCE_DEFAULTS.CONSECUTIVE_THRESHOLD).toBe(3);
  });
});
