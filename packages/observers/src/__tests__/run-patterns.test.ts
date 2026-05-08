/**
 * BEC-169 acceptance tests for findLoopingDeepReviews.
 * - completed+pr_url + high turns → NO finding (false-positive guard)
 * - failed + high turns → finding fires
 * - completed without pr_url + high turns → finding fires
 * - below threshold → never flagged
 */
import { describe, it, expect } from "vitest";
import { findLoopingDeepReviews } from "../run-patterns.js";
import { observeRunPatterns } from "../index.js";

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

/**
 * Integration path: observeRunPatterns (index.ts entry point) calls
 * findLoopingDeepReviews internally. These tests verify the full call chain
 * from the package's public API through to the pattern-detection logic.
 *
 * observeRunPatterns is the canonical entry point for the quality observer
 * sidecar (BEC-138); it accepts raw run summaries and returns a structured
 * report with all findings grouped by pattern type.
 */
describe("observeRunPatterns (index entry point)", () => {
  it("returns empty loopingFindings for a successful PR-creating run (BEC-169 false-positive fix)", () => {
    const runs = [
      {
        id: "AUEHrV8TPvNF1PHB96mVt",
        status: "completed",
        pr_url: "https://github.com/JonB32/urateam/pull/173",
        total_turns: 100,
      },
    ];

    const report = observeRunPatterns(runs);

    expect(report.loopingFindings).toHaveLength(0);
  });

  it("returns a looping finding for a failed run with high turn count", () => {
    const runs = [
      {
        id: "run-failed-999",
        status: "failed",
        pr_url: null,
        total_turns: 80,
      },
    ];

    const report = observeRunPatterns(runs);

    expect(report.loopingFindings).toHaveLength(1);
    expect(report.loopingFindings[0].runId).toBe("run-failed-999");
    expect(report.loopingFindings[0].totalTurns).toBe(80);
  });

  it("aggregates findings from a mixed set of runs", () => {
    const runs = [
      // Should NOT fire — completed + pr_url (BEC-169 false-positive)
      { id: "ok-run", status: "completed", pr_url: "https://github.com/org/repo/pull/1", total_turns: 100 },
      // Should fire — failed with high turns
      { id: "bad-run", status: "failed", pr_url: null, total_turns: 60 },
      // Should fire — completed but no PR produced
      { id: "noop-run", status: "completed", pr_url: null, total_turns: 55 },
      // Should NOT fire — below threshold
      { id: "low-run", status: "failed", pr_url: null, total_turns: 10 },
    ];

    const report = observeRunPatterns(runs);

    expect(report.loopingFindings).toHaveLength(2);
    const runIds = report.loopingFindings.map((f) => f.runId);
    expect(runIds).toContain("bad-run");
    expect(runIds).toContain("noop-run");
    expect(runIds).not.toContain("ok-run");
    expect(runIds).not.toContain("low-run");
  });
});
