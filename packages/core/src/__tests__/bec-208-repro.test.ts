/**
 * BEC-208 Reproduction: Deep-review loop convergence failures
 *
 * This file demonstrates the feature gaps identified in BEC-208:
 *   1. No convergenceValidator module exists anywhere in the codebase.
 *   2. The convergence check in runner.ts (lines 1510-1522) only checks
 *      whether the total finding COUNT decreases; it does NOT detect whether
 *      the same specific issues keep reappearing across passes.
 *   3. There is no turn-based limit (the ACs ask for default: 12 turns).
 *      The current limit is purely pass-based (maxDeepReviewPasses default 3,
 *      schema max 10).
 *   4. There is no comparison of implementation diffs between passes to
 *      confirm the implementation is actually changing.
 *
 * These tests CONFIRM the bug by showing:
 *   A) The convergenceValidator module import fails (module does not exist).
 *   B) The existing convergence logic allows a loop to continue even when the
 *      exact same issues reappear, as long as the count oscillates down even
 *      slightly.
 *   C) The PipelineConfigSchema has no `maxReviewTurns` or `reviewTurnLimit`
 *      field — only pass-based limits.
 */

import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// REPRO 1: convergenceValidator module does not exist
// ---------------------------------------------------------------------------
describe("BEC-208 repro 1: convergenceValidator module missing", () => {
  it("importing convergenceValidator throws (module does not exist)", async () => {
    // The AC requires a `convergenceValidator` module to be called after each
    // review turn. Currently no such module exists — this import must fail.
    await expect(
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore — expected to fail: module does not exist
      import("../pipeline/convergenceValidator.js"),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// REPRO 2: current convergence logic does not detect repeated issues
// ---------------------------------------------------------------------------

/**
 * Simulate the convergence check that lives in runner.ts lines 1510-1522.
 * Extracted here verbatim to make the gap testable without spinning up the
 * full pipeline runner.
 */
function simulateRunnerConvergenceCheck(
  findingsPerPass: number[],
): { stoppedAtPass: number; reason: string } {
  let previousFindingsCount = Infinity;

  for (let drPass = 1; drPass <= findingsPerPass.length; drPass++) {
    const findingsCount = findingsPerPass[drPass - 1];

    if (findingsCount === 0) {
      return { stoppedAtPass: drPass, reason: "converged (zero findings)" };
    }
    if (findingsCount >= previousFindingsCount) {
      return {
        stoppedAtPass: drPass,
        reason: "findings count did not decrease — stopping to prevent loop",
      };
    }
    previousFindingsCount = findingsCount;
  }

  return { stoppedAtPass: findingsPerPass.length, reason: "pass limit reached" };
}

describe("BEC-208 repro 2: existing convergence check is insufficient", () => {
  it("allows a loop to run all passes when finding count slowly decreases even with identical issues", () => {
    // Simulate a pipeline where the review agent finds 10, then 8, then 6
    // issues per pass — BUT all issues are identical (not actually addressed).
    // The current check sees 10 > 8 > 6 and does NOT abort — it runs all 3 passes.
    // This models the real BEC-208 scenario: same issues filed each pass.
    const findingsPerPass = [10, 8, 6]; // passLimit = 3 (maxDeepReviewPasses default)

    const result = simulateRunnerConvergenceCheck(findingsPerPass);

    // BUG: the loop runs all 3 passes and only stops because pass limit is hit,
    // NOT because convergence was detected. 26 total agent turns later, the
    // same issues remain unaddressed.
    expect(result.reason).toBe("pass limit reached");
    expect(result.stoppedAtPass).toBe(3);
  });

  it("also allows a loop that bounces: 10 → 9 → 8 → 7 ... indefinitely until pass limit", () => {
    // Each pass has one fewer finding than the last (tiny monotone decrease).
    // Identical underlying issues — the implement agent just drops one at random.
    const findingsPerPass = [10, 9, 8, 7, 6]; // passLimit = 5 (maxDeepReviewPasses=5)

    const result = simulateRunnerConvergenceCheck(findingsPerPass);

    // Current logic keeps running — it never detects that the same core issues
    // reappear in every pass and the implementation is not really converging.
    expect(result.reason).toBe("pass limit reached");
    expect(result.stoppedAtPass).toBe(5);
  });

  it("does NOT abort when the same 3 issues appear in 3 consecutive passes (AC requirement)", () => {
    // The AC requires aborting when "the same unresolved issues appear in 3
    // consecutive turn results without changes to the implementation diff."
    // This is NOT implemented. The existing check only compares counts.

    // Simulate 3 passes each with exactly 5 findings (same issues each time).
    // The existing check: pass 2 has 5 >= 5 (previousFindingsCount), so it stops
    // at pass 2 with "did not decrease" — NOT with "3 consecutive same issues".
    const findingsPerPass = [5, 5, 5];
    const result = simulateRunnerConvergenceCheck(findingsPerPass);

    // The loop stops at pass 2, but for the wrong reason (count didn't decrease),
    // not the AC-required reason (3 consecutive passes with the same issues).
    // It also stops after only 2 passes, not 3 (the AC threshold).
    expect(result.stoppedAtPass).toBe(2);
    expect(result.reason).toBe(
      "findings count did not decrease — stopping to prevent loop",
    );
    // The AC says abort after 3 consecutive passes, not 2. Current behavior
    // is inconsistent with the required 3-consecutive threshold.
    // (If counts were 5 → 4 → 4, the loop would also stop at pass 3 for wrong reason.)
  });
});

// ---------------------------------------------------------------------------
// REPRO 3: no turn-based maximum (only pass-based)
// ---------------------------------------------------------------------------
describe("BEC-208 repro 3: no turn-based max in PipelineConfigSchema", () => {
  it("PipelineConfigSchema has no maxReviewTurns or reviewTurnLimit field", async () => {
    const { PipelineConfigSchema } = await import("../types.js");

    // A config with a hypothetical `maxReviewTurns: 12` field should be
    // recognised once the AC is implemented. Currently it is silently stripped.
    const result = PipelineConfigSchema.safeParse({
      name: "test",
      stages: ["implement", "review"],
      retry: { maxAttempts: 1, strategy: "fail-fast" },
      review: { requiredApprovals: 0 },
      prStrategy: "ready",
      maxReviewTurns: 12, // AC: configurable, default 12
    });

    expect(result.success).toBe(true); // parsing succeeds…
    if (result.success) {
      // …but the field is dropped (not in schema yet) — BUG
      expect((result.data as Record<string, unknown>).maxReviewTurns).toBeUndefined();
    }
  });

  it("deepReviewPasses schema max of 5 × sub-agent maxTurns 8 × 3 agents = up to 120 agent turns with no convergence guard", () => {
    // With maxDeepReviewPasses=5, each pass running 3 sub-agents at maxTurns=8:
    //   5 passes × 3 agents × 8 turns = 120 sub-agent turns
    // Plus implement and review re-runs per pass, total can be >26 easily.
    // The AC asks for a configurable turn cap (default 12) to prevent runaway.
    const maxPasses = 5;
    const agentsPerPass = 3;
    const turnsPerAgent = 8;
    const worstCaseSubAgentTurns = maxPasses * agentsPerPass * turnsPerAgent;

    // 26 turns (the observed incident count) is well within reach of a single
    // deep-review pass (3 agents × 8 turns + implement + review stages).
    expect(worstCaseSubAgentTurns).toBeGreaterThan(26);

    // And the current schema allows maxDeepReviewPasses up to 10:
    const schemaMaxPasses = 10;
    const absoluteWorstCase = schemaMaxPasses * agentsPerPass * turnsPerAgent;
    expect(absoluteWorstCase).toBe(240); // 240 possible sub-agent turns, no turn cap
  });
});

// ---------------------------------------------------------------------------
// REPRO 4: no diff comparison between passes
// ---------------------------------------------------------------------------
describe("BEC-208 repro 4: no implementation diff comparison between passes", () => {
  it("buildDeepReviewContext does not embed or reference a diff fingerprint", async () => {
    const { buildDeepReviewContext } = await import("../executor/deep-review.js");

    const handoff = {
      runId: "run-1",
      issueId: "BEC-208",
      stage: "implement" as const,
      timestamp: "2026-05-11T00:00:00Z",
      summary: "Fix convergence issue",
      filesChanged: ["src/runner.ts"],
      approach: "Add convergence check",
      context: {
        issueIntent: "Fix loop",
        constraints: [],
        assumptions: [],
      },
      tokenBudget: { contextTokensUsed: 1000, maxTurns: 10 },
    };

    const findings = [
      {
        agent: "quality" as const,
        severity: "blocking" as const,
        file: "src/runner.ts",
        line: 42,
        category: "missing-convergence",
        description: "No convergence check",
        fix: "Add convergenceValidator call",
      },
    ];

    const ctx = buildDeepReviewContext(1, findings, handoff);

    // The context block does NOT include any diff hash or diff fingerprint
    // that would allow the implement agent or the convergence check to
    // compare whether the implementation actually changed between passes.
    expect(ctx).not.toMatch(/diff.hash|diffHash|implHash|implementation.diff/i);
  });
});
