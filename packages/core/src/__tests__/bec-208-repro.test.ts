/**
 * BEC-208: Deep-review loop convergence — bug confirmed & fixed.
 *
 * The original reproduction tests (pre-fix) demonstrated four gaps:
 *   1. No `convergenceValidator` module existed.
 *   2. The convergence check only compared finding COUNTS; identical issues could
 *      cycle indefinitely as long as the count slowly decreased.
 *   3. `PipelineConfigSchema` had no `maxReviewTurns` field.
 *   4. `buildDeepReviewContext` did not embed an implementation diff hash.
 *
 * This file now confirms all four gaps are fixed.
 * For unit-level behavioral tests of the new logic, see convergenceValidator.test.ts.
 */

import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// FIX 1: convergenceValidator module now exists
// ---------------------------------------------------------------------------
describe("BEC-208 fix 1: convergenceValidator module exists", () => {
  it("importing convergenceValidator succeeds and exports checkConvergence", async () => {
    const mod = await import("../pipeline/convergenceValidator.js");
    expect(typeof mod.checkConvergence).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// FIX 2: new convergence check detects repeated issues (not just count)
// ---------------------------------------------------------------------------
describe("BEC-208 fix 2: convergence check detects repeated issues", () => {
  it("detects 3 consecutive turns with the same finding (regardless of count trend)", async () => {
    const { checkConvergence } = await import("../pipeline/convergenceValidator.js");

    // Scenario that the old check missed: counts slowly decrease (10→8→6)
    // but the SAME underlying issues persist. The new validator detects this.
    const persistentFinding = { file: "src/runner.ts", line: 100, category: "bug", description: "convergence issue" };

    const history = [
      // Turn 1: 10 findings including the persistent one
      {
        turn: 1,
        findings: [
          persistentFinding,
          ...Array.from({ length: 9 }, (_, i) => ({ file: `file${i}.ts`, line: 1, category: "minor", description: `minor-${i}` })),
        ],
        implDiffHash: "hash1",
      },
      // Turn 2: 8 findings — some minor ones resolved, but the persistent one stays
      {
        turn: 2,
        findings: [
          persistentFinding,
          ...Array.from({ length: 7 }, (_, i) => ({ file: `file${i}.ts`, line: 1, category: "minor", description: `minor-${i}` })),
        ],
        implDiffHash: "hash1", // same hash — implementation didn't change
      },
      // Turn 3: 6 findings — count still decreasing, but persistent issue remains
      {
        turn: 3,
        findings: [
          persistentFinding,
          ...Array.from({ length: 5 }, (_, i) => ({ file: `file${i}.ts`, line: 1, category: "minor", description: `minor-${i}` })),
        ],
        implDiffHash: "hash1", // still no implementation change
      },
    ];

    const result = checkConvergence(history, { maxTurns: 12, consecutiveThreshold: 3 });

    // FIX: the validator detects the persistent issue and stops the loop
    expect(result.shouldStop).toBe(true);
    expect(result.reason).toBe("repeated-issues");
    expect(result.diagnosis).toBe("non-responsive-implementation");
    expect(result.unresolvedIssues.length).toBeGreaterThan(0);
  });

  it("allows 3 turns with 3 consecutive passes with the same issues to abort (AC threshold)", async () => {
    const { checkConvergence } = await import("../pipeline/convergenceValidator.js");

    const finding = { file: "src/a.ts", line: 5, category: "bug", description: "same issue" };
    const history = [
      { turn: 1, findings: [finding], implDiffHash: "same" },
      { turn: 2, findings: [finding], implDiffHash: "same" },
      { turn: 3, findings: [finding], implDiffHash: "same" },
    ];

    const result = checkConvergence(history, { maxTurns: 12, consecutiveThreshold: 3 });
    expect(result.shouldStop).toBe(true);
    expect(result.reason).toBe("repeated-issues");
  });
});

// ---------------------------------------------------------------------------
// FIX 3: PipelineConfigSchema now has maxReviewTurns
// ---------------------------------------------------------------------------
describe("BEC-208 fix 3: PipelineConfigSchema has maxReviewTurns", () => {
  it("maxReviewTurns: 12 is accepted and preserved by PipelineConfigSchema", async () => {
    const { PipelineConfigSchema } = await import("../types.js");

    const result = PipelineConfigSchema.safeParse({
      name: "test",
      stages: ["implement", "review"],
      retry: { maxAttempts: 1, strategy: "fail-fast" },
      review: { requiredApprovals: 0 },
      prStrategy: "ready",
      maxReviewTurns: 12,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      // FIX: the field is now present in the schema and preserved
      expect((result.data as Record<string, unknown>).maxReviewTurns).toBe(12);
    }
  });
});

// ---------------------------------------------------------------------------
// FIX 4: buildDeepReviewContext now embeds diff hash when provided
// ---------------------------------------------------------------------------
describe("BEC-208 fix 4: buildDeepReviewContext embeds implDiffHash", () => {
  it("embeds the implementation diff hash when provided", async () => {
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

    // FIX: the function now accepts and embeds an implDiffHash
    const testHash = "abc123def456";
    const ctx = buildDeepReviewContext(1, findings, handoff, testHash);

    expect(ctx).toMatch(testHash);
    // The hash appears in an attribute or in the context body
    expect(ctx).toMatch(/implDiffHash|Implementation diff hash/i);
  });

  it("omits the hash line when no implDiffHash is provided (backwards-compatible)", async () => {
    const { buildDeepReviewContext } = await import("../executor/deep-review.js");

    const handoff = {
      runId: "run-1",
      issueId: "BEC-208",
      stage: "implement" as const,
      timestamp: "2026-05-11T00:00:00Z",
      summary: "Fix",
      filesChanged: ["src/a.ts"],
      approach: "Add check",
      context: { issueIntent: "Fix", constraints: [], assumptions: [] },
      tokenBudget: { contextTokensUsed: 100, maxTurns: 5 },
    };

    const ctx = buildDeepReviewContext(1, [], handoff);
    // Without a hash, neither the attribute nor the hash line should appear
    expect(ctx).not.toMatch(/implDiffHash|Implementation diff hash/i);
  });
});
