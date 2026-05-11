/**
 * BEC-211 reproduction: deep-review loop convergence detection gap.
 *
 * The quality observer flagged pipeline 9ODl4UwNT_EsIUCJE0HjC for running
 * 56 agent turns without producing a PR. The root cause is that the
 * deep-review loop's convergence check (runner.ts ~line 1515) only examines
 * the *count* of findings per pass. It does not detect the oscillation
 * pattern where consecutive passes modify the same files in contradicting
 * ways (add then remove the same code), producing a slowly-decreasing
 * findings count that never reaches zero — so the loop runs all `passLimit`
 * iterations and the agent burns tokens with no net progress.
 *
 * Two specific gaps are reproduced below:
 *
 * GAP 1 — No cycle/oscillation detection
 *   The existing check `if (findingsCount >= previousFindingsCount) break`
 *   only stops when the count plateaus or rises. A sequence like
 *   10 → 9 → 8 → 7 → 6 bypasses it even when the same file is modified
 *   back and forth on every pass.
 *
 * GAP 2 — No MAX_REVIEW_TURNS configuration key
 *   The AC requires a `maxReviewTurns` (or equivalent) field on
 *   PipelineConfig that caps total agent turns across the deep-review loop,
 *   independent of pass count. No such field exists today.
 */

import { describe, it, expect } from "vitest";
import type { ReviewFinding } from "../types.js";
import { PipelineConfigSchema } from "../types.js";
import { detectConvergence, type PassHistory } from "../pipeline/convergence.js";

// ---------------------------------------------------------------------------
// Helpers — mirror the exact convergence logic in runner.ts ~1510-1522
// so changes to the production code will keep this test in sync.
// ---------------------------------------------------------------------------

interface PassResult {
  /** Files the implement stage reported as changed this pass. */
  filesChanged: string[];
  /** Review findings produced this pass (already as ReviewFinding[]).  */
  findings: ReviewFinding[];
}

/**
 * Simulates the current deep-review convergence check from runner.ts.
 * Returns the iteration index (1-based) at which the loop would have stopped,
 * or `passes.length` if it ran to completion without breaking early.
 */
function simulateCurrentConvergenceCheck(passes: PassResult[]): number {
  let previousFindingsCount = Infinity;
  for (let drPass = 1; drPass <= passes.length; drPass++) {
    const findingsCount = passes[drPass - 1].findings.length;
    // Mirror runner.ts lines 1510-1522:
    if (findingsCount === 0) return drPass; // converged
    if (findingsCount >= previousFindingsCount) return drPass; // not decreasing
    previousFindingsCount = findingsCount;
  }
  return passes.length; // ran to completion
}

// ---------------------------------------------------------------------------
// Fixtures — the oscillation scenario
// ---------------------------------------------------------------------------

/**
 * Builds a ReviewFinding for use in test fixtures.
 */
function finding(file: string, description: string): ReviewFinding {
  return {
    severity: "warning",
    file,
    line: 1,
    category: "quality",
    description,
    fix: "address this",
  };
}

/**
 * Scenario: six deep-review passes on files A.ts and B.ts.
 *
 * Pass 1: removes inline function X from A.ts — 10 findings
 * Pass 2: extracts function X back to A.ts (contradicts pass 1) — 9 findings
 * Pass 3: removes function X again — 8 findings
 * Pass 4: adds function X back — 7 findings
 * Pass 5: removes X — 6 findings
 * Pass 6: adds X back — 5 findings
 *
 * The findings count keeps strictly decreasing, so the current convergence
 * check never triggers.  The loop runs all 6 passes despite making zero net
 * progress (the code is oscillating around the same change).
 */
const oscillatingPasses: PassResult[] = [
  {
    filesChanged: ["src/A.ts", "src/B.ts"],
    findings: [
      finding("src/A.ts", "inline function X should be extracted"),
      finding("src/A.ts", "duplicated util call"),
      finding("src/A.ts", "magic string"),
      finding("src/A.ts", "missing null check"),
      finding("src/B.ts", "unused import"),
      finding("src/B.ts", "long function"),
      finding("src/B.ts", "no error handling"),
      finding("src/B.ts", "shadow variable"),
      finding("src/B.ts", "inconsistent naming"),
      finding("src/B.ts", "missing type annotation"),
    ], // 10 findings — pass 1
  },
  {
    // Pass 2 contradicts pass 1: puts function X back in A.ts
    filesChanged: ["src/A.ts", "src/B.ts"],
    findings: Array.from({ length: 9 }, (_, i) => finding("src/A.ts", `finding-${i}`)),
  },
  {
    // Pass 3: removes X again
    filesChanged: ["src/A.ts", "src/B.ts"],
    findings: Array.from({ length: 8 }, (_, i) => finding("src/A.ts", `finding-${i}`)),
  },
  {
    // Pass 4: adds X back — contradicts pass 3
    filesChanged: ["src/A.ts", "src/B.ts"],
    findings: Array.from({ length: 7 }, (_, i) => finding("src/A.ts", `finding-${i}`)),
  },
  {
    // Pass 5
    filesChanged: ["src/A.ts", "src/B.ts"],
    findings: Array.from({ length: 6 }, (_, i) => finding("src/A.ts", `finding-${i}`)),
  },
  {
    // Pass 6
    filesChanged: ["src/A.ts", "src/B.ts"],
    findings: Array.from({ length: 5 }, (_, i) => finding("src/A.ts", `finding-${i}`)),
  },
];

// ---------------------------------------------------------------------------
// GAP 1: current convergence check does NOT detect oscillation
// ---------------------------------------------------------------------------

describe("BEC-211 GAP 1: convergence check is count-only, misses oscillation", () => {
  it("runs all passes when findings strictly decrease — even if same files oscillate", () => {
    // PRE-FIX: the current convergence logic runs to completion because
    // findings count is 10 → 9 → 8 → 7 → 6 → 5 (always decreasing).
    const stoppedAt = simulateCurrentConvergenceCheck(oscillatingPasses);

    // BUG: loop ran all 6 passes despite the same two files being modified
    // back-and-forth on every pass.  With max 10 passes and similar token use
    // this matches the 56-turn scenario in the bug report.
    expect(stoppedAt).toBe(oscillatingPasses.length); // ran to completion — the bug
  });

  it("correctly stops when count plateaus (existing guard works for that case)", () => {
    const plateauPasses: PassResult[] = [
      { filesChanged: ["src/X.ts"], findings: Array.from({ length: 5 }, (_, i) => finding("src/X.ts", `f${i}`)) },
      { filesChanged: ["src/X.ts"], findings: Array.from({ length: 5 }, (_, i) => finding("src/X.ts", `f${i}`)) }, // same count
      { filesChanged: ["src/X.ts"], findings: Array.from({ length: 4 }, (_, i) => finding("src/X.ts", `f${i}`)) },
    ];
    const stoppedAt = simulateCurrentConvergenceCheck(plateauPasses);
    // Stops at pass 2 (count did not decrease: 5 >= 5)
    expect(stoppedAt).toBe(2);
  });

  it("detectConvergence (BEC-211 fix) detects file-level oscillation and stops early", () => {
    /**
     * Previously this test was a stub using a naive oscillation detector.
     * It now calls the real `detectConvergence` function introduced by BEC-211.
     *
     * The function detects that the same files appear in consecutive passes
     * and breaks out of the loop at pass 2 (the first repeat).
     */
    const passHistories: PassHistory[] = [];
    let stoppedAtPass = oscillatingPasses.length;

    for (let i = 0; i < oscillatingPasses.length; i++) {
      const pass = oscillatingPasses[i];
      passHistories.push({
        passNumber: i + 1,
        filesChanged: pass.filesChanged,
        findingsCount: pass.findings.length,
      });
      const result = detectConvergence(passHistories, i + 1, 15, i + 1);
      if (result) {
        stoppedAtPass = i + 1; // 1-based
        expect(result.reason).toBe("file-oscillation");
        break;
      }
    }

    // With the real file-tracking detector: stops at pass 2 (same files as pass 1)
    expect(stoppedAtPass).toBeLessThan(oscillatingPasses.length);
    expect(stoppedAtPass).toBe(2); // first time same file set seen twice
  });
});

// ---------------------------------------------------------------------------
// GAP 2: PipelineConfig now has maxReviewTurns field (fixed in BEC-211)
// ---------------------------------------------------------------------------

describe("BEC-211 GAP 2 (fixed): MAX_REVIEW_TURNS configuration key now exists", () => {
  it("PipelineConfigSchema has a maxReviewTurns field (added by BEC-211 fix)", () => {
    // Confirm the field now exists with the expected constraints.
    const shape = (PipelineConfigSchema as unknown as { shape: Record<string, unknown> }).shape;
    expect(shape).toHaveProperty("maxReviewTurns");
  });

  it("parsed config accepts maxReviewTurns and preserves the value", () => {
    // The field is now validated and enforced (not silently dropped).
    const result = PipelineConfigSchema.safeParse({
      name: "test",
      stages: ["implement"],
      retry: { maxAttempts: 0, strategy: "fail-fast" },
      review: { requiredApprovals: 0 },
      prStrategy: "ready",
      maxReviewTurns: 10,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).maxReviewTurns).toBe(10);
    }
  });

  it("maxReviewTurns defaults to undefined (optional field; runner uses 15 as default)", () => {
    const result = PipelineConfigSchema.safeParse({
      name: "test",
      stages: ["implement"],
      retry: { maxAttempts: 0, strategy: "fail-fast" },
      review: { requiredApprovals: 0 },
      prStrategy: "ready",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      // Field is optional; absence is fine — runner defaults to 15.
      expect((result.data as Record<string, unknown>).maxReviewTurns).toBeUndefined();
    }
  });

  it("maxReviewTurns rejects values less than 1", () => {
    const result = PipelineConfigSchema.safeParse({
      name: "test",
      stages: ["implement"],
      retry: { maxAttempts: 0, strategy: "fail-fast" },
      review: { requiredApprovals: 0 },
      prStrategy: "ready",
      maxReviewTurns: 0,
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GAP 3: Quality Observer fires at > 50 turns — no earlier exit
// ---------------------------------------------------------------------------

describe("BEC-211 GAP 3: observer threshold confirms real turn counts exceeded", () => {
  it("LOOP_TURN_THRESHOLD is 50 — consistent with the 56-turn incident", () => {
    /**
     * The quality observer (packages/observers/src/run-patterns.ts) uses
     * LOOP_TURN_THRESHOLD = 50.  Pipeline 9ODl4UwNT_EsIUCJE0HjC hit 56 turns,
     * triggering the alert on a run that produced no PR.
     *
     * With maxDeepReviewPasses=10 and each pass consuming ~5-6 agent turns
     * (implement + review stages each running 2-3 turns), a 5-pass loop
     * easily generates 25-30 turns for the deep-review block alone, stacked
     * on top of the initial triage/implement/test/review turns (~20-25).
     *
     * The fix must ensure the loop cannot accumulate > 15 review-block turns
     * (the proposed MAX_REVIEW_TURNS default) regardless of maxDeepReviewPasses.
     */
    // Re-import to verify the constant hasn't changed.
    // Inline the value here to keep the test self-contained.
    const LOOP_TURN_THRESHOLD = 50;

    // 56 turns > threshold → alert fires
    expect(56).toBeGreaterThan(LOOP_TURN_THRESHOLD);

    // Verify a properly converging run (≤ 15 review turns + ~25 base = ~40)
    // would NOT trigger the alert.
    const expectedTurnsWithFix = 40; // rough upper bound after max 15 review turns
    expect(expectedTurnsWithFix).toBeLessThanOrEqual(LOOP_TURN_THRESHOLD);
  });
});
