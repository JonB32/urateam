/**
 * BEC-169 acceptance tests for findLoopingDeepReviews.
 * - completed+pr_url + high turns → NO finding (false-positive guard)
 * - failed + high turns → finding fires
 * - completed without pr_url + high turns → finding fires
 * - below threshold → never flagged
 */
import { describe, it, expect } from "vitest";
import { findLoopingDeepReviews } from "../run-patterns.js";

describe("findLoopingDeepReviews", () => {
  /**
   * AC: completed run with pr_url + 100 turns → NO finding.
   *
   * Mirrors the real incident: BEC-152 run AUEHrV8TPvNF1PHB96mVt hit 77 turns
   * legitimately (deep-review fanout across 3 OpenRouter models) and produced
   * PR #173.  This run should never be flagged.
   *
   * STATUS: FAILS with pre-fix implementation (false positive)
   */
  it("completed run with pr_url set and 100 turns should NOT fire a finding (BEC-169 false-positive)", () => {
    const runs = [
      {
        id: "AUEHrV8TPvNF1PHB96mVt",
        status: "completed",
        pr_url: "https://github.com/JonB32/urateam/pull/173",
        total_turns: 100,
      },
    ];

    const findings = findLoopingDeepReviews(runs);

    // Expect no finding — this is the false-positive the fix must eliminate
    expect(findings).toHaveLength(0);
  });

  /**
   * AC: failed run with 100 turns → finding still fires.
   *
   * A high turn count on a run that never shipped a PR is a genuine loop signal.
   *
   * STATUS: PASSES with pre-fix implementation
   */
  it("failed run with 100 turns fires a looping finding", () => {
    const runs = [
      {
        id: "run-failed-001",
        status: "failed",
        pr_url: null,
        total_turns: 100,
      },
    ];

    const findings = findLoopingDeepReviews(runs);

    expect(findings).toHaveLength(1);
    expect(findings[0].runId).toBe("run-failed-001");
    expect(findings[0].totalTurns).toBe(100);
  });

  /**
   * AC: completed run without pr_url + 100 turns → finding still fires.
   *
   * A no-op completion (run ended but produced no PR) with high turns is
   * still suspicious — the deep-review pass should not complete without a PR.
   *
   * STATUS: PASSES with pre-fix implementation
   */
  it("completed run without pr_url and 100 turns fires a looping finding", () => {
    const runs = [
      {
        id: "run-noop-001",
        status: "completed",
        pr_url: null,
        total_turns: 100,
      },
    ];

    const findings = findLoopingDeepReviews(runs);

    expect(findings).toHaveLength(1);
    expect(findings[0].runId).toBe("run-noop-001");
    expect(findings[0].totalTurns).toBe(100);
  });

  // Edge: run below threshold is never flagged regardless of status
  it("run below turn threshold is not flagged even if it failed", () => {
    const runs = [
      {
        id: "run-low-turns",
        status: "failed",
        pr_url: null,
        total_turns: 20,
      },
    ];

    const findings = findLoopingDeepReviews(runs);
    expect(findings).toHaveLength(0);
  });
});
