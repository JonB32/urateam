/**
 * BEC-213 Reproduction — deep-review loop convergence gaps
 *
 * This file documents three confirmed feature gaps:
 *   1. No convergenceChecker.isConverged(currentFindings, previousFindings)
 *      — the deep-review loop only compares finding counts, not content.
 *   2. No MAX_REVIEW_TURNS config parameter (≤ 15 default per ACs).
 *   3. The review-fix loop has NO convergence check — it can run the same
 *      failing findings cycle repeatedly up to reviewFixIterations (max 5).
 *
 * Evidence from run 7HaVmAKKn4gluPgv9T9pm: 33 agent turns, LOOP_TURN_THRESHOLD
 * currently set to 50, so the run was NOT flagged by the current observer.
 * This confirms the threshold is miscalibrated relative to the 33-turn incident.
 *
 * Steps to reproduce:
 *   cd packages/observers && npx vitest run src/__tests__/bec-213-repro.test.ts
 */
import { describe, it, expect } from "vitest";
import { findLoopingDeepReviews, LOOP_TURN_THRESHOLD } from "../run-patterns.js";

// ---------------------------------------------------------------------------
// GAP 1: No convergenceChecker module exists
// ---------------------------------------------------------------------------
describe("GAP 1 — convergenceChecker.isConverged does not exist", () => {
  it("there is no convergenceChecker module to import", async () => {
    // ACs require: convergenceChecker.isConverged(currentFindings, previousFindings)
    // No such module exists in @urateam/observers or @urateam/core.
    let importFailed = false;
    try {
      // @ts-expect-error — this module should not exist yet
      await import("../convergenceChecker.js");
    } catch {
      importFailed = true;
    }
    expect(importFailed, "convergenceChecker module should not exist yet (feature gap)").toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GAP 2: LOOP_TURN_THRESHOLD (50) is higher than the 33-turn incident run
// ---------------------------------------------------------------------------
describe("GAP 2 — LOOP_TURN_THRESHOLD miscalibrated, 33-turn run not flagged", () => {
  it("LOOP_TURN_THRESHOLD is 50 — run with 33 turns is NOT flagged (should be)", () => {
    // The incident run 7HaVmAKKn4gluPgv9T9pm had 33 total agent turns.
    // ACs require MAX_REVIEW_TURNS default ≤ 15. Current threshold is 50.
    // At 50, a run with 33 turns silently passes through without any alert.
    expect(LOOP_TURN_THRESHOLD).toBe(50);

    const incidentRun = [
      {
        id: "7HaVmAKKn4gluPgv9T9pm",
        status: "failed",   // did NOT produce a PR
        pr_url: null,
        total_turns: 33,   // the actual incident value from the evidence
      },
    ];

    const findings = findLoopingDeepReviews(incidentRun);

    // BUG: 33 < 50, so the run that caused the quality-observer finding
    // is itself NOT detected by the current observer logic.
    // With ACs-compliant MAX_REVIEW_TURNS ≤ 15, this should produce a finding.
    expect(findings).toHaveLength(0); // <-- this PASSES, proving the gap
  });

  it("threshold must be ≤ 15 to catch the 33-turn incident run (AC requirement)", () => {
    // This test documents what the behavior SHOULD be per ACs:
    // MAX_REVIEW_TURNS default ≤ 15 → 33 turns should fire an alert.
    const AC_COMPLIANT_MAX = 15;
    const incidentTurns = 33;
    expect(incidentTurns).toBeGreaterThan(AC_COMPLIANT_MAX);
    // When MAX_REVIEW_TURNS is ≤ 15, the 33-turn run WOULD be flagged.
    // Current code does NOT enforce this — gap confirmed.
  });
});

// ---------------------------------------------------------------------------
// GAP 3: Deep-review convergence check compares counts only, not content
// ---------------------------------------------------------------------------
describe("GAP 3 — count-only convergence check misses content cycles", () => {
  it("documents the crude count-only check in runner.ts:1528", () => {
    // Current code (runner.ts lines 1528-1533):
    //   if (findingsCount >= previousFindingsCount) { break; }
    //
    // This only compares counts. Two cycles with the same number of findings
    // but DIFFERENT content would incorrectly be treated as "converged".
    //
    // Example: cycle 1 finds ["missing type annotation", "unused import"]
    //          cycle 2 finds ["missing null check", "off-by-one error"]
    //          Count: 2 == 2 → current code breaks (treats as not decreasing)
    //          Reality: findings changed → not converged, should continue
    //
    // ACs require: isConverged(currentFindings, previousFindings) that
    // compares finding IDENTITY (e.g. message + file + line), not just count.

    type Finding = { message: string; file: string; severity: string };

    function currentIsConvergedCheck(curr: Finding[], prev: Finding[]): boolean {
      // This is what runner.ts currently does (count comparison only):
      return curr.length >= prev.length;
    }

    const cycle1: Finding[] = [
      { message: "missing type annotation", file: "src/foo.ts", severity: "warning" },
      { message: "unused import", file: "src/bar.ts", severity: "warning" },
    ];

    const cycle2: Finding[] = [
      { message: "missing null check", file: "src/baz.ts", severity: "blocking" },
      { message: "off-by-one error", file: "src/qux.ts", severity: "blocking" },
    ];

    // Current check: 2 >= 2 → true (incorrectly reports "converged")
    const currentSaysConverged = currentIsConvergedCheck(cycle2, cycle1);
    expect(currentSaysConverged).toBe(true); // BUG: same count but different findings

    // What isConverged SHOULD check (per ACs): content equality
    function properIsConverged(curr: Finding[], prev: Finding[]): boolean {
      if (curr.length !== prev.length) return false;
      const prevMessages = new Set(prev.map((f) => `${f.file}:${f.message}`));
      return curr.every((f) => prevMessages.has(`${f.file}:${f.message}`));
    }

    expect(properIsConverged(cycle2, cycle1)).toBe(false); // correct: not converged
    expect(properIsConverged(cycle1, cycle1)).toBe(true);  // correct: converged (same findings)
  });

  it("review-fix loop has NO convergence check — same findings can repeat every cycle", () => {
    // The review-fix loop in runner.ts (lines 1302-1448) stops only when:
    //   - !stillBlocking (no more blocking findings) OR
    //   - rfIteration === reviewFixIterations (max iterations reached)
    //
    // If the implement stage keeps failing to fix a finding (same finding
    // recurs every cycle), the loop runs all reviewFixIterations passes
    // with zero convergence detection. With reviewFixIterations=5 and
    // ralphIterations=5, worst case is 5×6=30 implement runs for a single
    // never-converging bug.
    //
    // ACs require: the loop also terminates when findings match previous cycle.

    // Simulate: blocking finding "missing null check" persists across all cycles
    type ReviewFinding = { severity: string; message: string };
    const persistentBlocking: ReviewFinding[] = [
      { severity: "blocking", message: "missing null check" },
    ];

    const MAX_REVIEW_FIX_ITERATIONS = 5; // config max per types.ts
    let cyclesRun = 0;

    // Simulate review-fix loop with NO convergence check
    let findings = persistentBlocking;
    for (let i = 1; i <= MAX_REVIEW_FIX_ITERATIONS; i++) {
      const stillBlocking = findings.some((f) => f.severity === "blocking");
      if (!stillBlocking) break;

      // implement stage runs but doesn't fix the finding
      cyclesRun++;
      findings = persistentBlocking; // same finding persists
    }

    // All 5 iterations run even though findings never changed — BUG
    expect(cyclesRun).toBe(MAX_REVIEW_FIX_ITERATIONS);
    // With proper convergence check, loop should stop after cycle 2 (finding unchanged)
  });
});
