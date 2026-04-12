import { describe, it, expect } from "vitest";
import { PipelineConfigSchema, RepoConfigSchema, HandoffArtifactSchema } from "../types.js";

describe("PipelineConfigSchema", () => {
  it("accepts valid pipeline config", () => {
    const result = PipelineConfigSchema.safeParse({
      name: "Auto Implement",
      stages: ["implement", "test", "review"],
      retry: { maxAttempts: 2, strategy: "fix-and-retry" },
      review: { requiredApprovals: 1 },
      prStrategy: "draft",
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid stage name", () => {
    const result = PipelineConfigSchema.safeParse({
      name: "Bad",
      stages: ["invalid-stage"],
      retry: { maxAttempts: 1, strategy: "escalate" },
      review: { requiredApprovals: 0 },
      prStrategy: "draft",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid retry strategy", () => {
    const result = PipelineConfigSchema.safeParse({
      name: "Bad",
      stages: ["implement"],
      retry: { maxAttempts: 1, strategy: "invalid" },
      review: { requiredApprovals: 0 },
      prStrategy: "draft",
    });
    expect(result.success).toBe(false);
  });
});

describe("RepoConfigSchema", () => {
  it("accepts valid repo config", () => {
    const result = RepoConfigSchema.safeParse({
      url: "github.com/org/repo",
      defaultBranch: "main",
      testCommand: "npm test",
      buildCommand: "npm run build",
    });
    expect(result.success).toBe(true);
  });

  it("accepts optional fields", () => {
    const result = RepoConfigSchema.safeParse({
      url: "github.com/org/repo",
      defaultBranch: "main",
      testCommand: "npm test",
      buildCommand: "npm run build",
      setupCommands: [["npm", "install"]],
      workingDirectory: "packages/api",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.setupCommands).toEqual([["npm", "install"]]);
      expect(result.data.workingDirectory).toBe("packages/api");
    }
  });
});

describe("HandoffArtifactSchema", () => {
  it("accepts valid handoff artifact", () => {
    const result = HandoffArtifactSchema.safeParse({
      runId: "run-abc123",
      issueId: "LIN-123",
      stage: "implement",
      timestamp: "2026-03-30T12:00:00Z",
      summary: "Implemented user search endpoint",
      filesChanged: ["src/search.ts", "src/search.test.ts"],
      approach: "Added a new GET /search endpoint using existing user service",
      context: {
        issueIntent: "Add user search functionality",
        constraints: ["Must use existing user service"],
        assumptions: ["Search is case-insensitive"],
      },
      tokenBudget: { contextTokensUsed: 42000, recommendedMaxTurns: 20 },
    });
    expect(result.success).toBe(true);
  });

  it("accepts optional test results", () => {
    const result = HandoffArtifactSchema.safeParse({
      runId: "run-abc123",
      issueId: "LIN-123",
      stage: "test",
      timestamp: "2026-03-30T12:00:00Z",
      summary: "Tests ran",
      filesChanged: [],
      approach: "Ran test suite",
      context: {
        issueIntent: "Verify implementation",
        constraints: [],
        assumptions: [],
        testResults: {
          passed: 14,
          failed: 1,
          firstFailure: { test: "search returns results", error: "Expected 3 but got 0", file: "src/search.test.ts" },
        },
      },
      tokenBudget: { contextTokensUsed: 30000, recommendedMaxTurns: 15 },
    });
    expect(result.success).toBe(true);
  });

  it("accepts optional review findings", () => {
    const result = HandoffArtifactSchema.safeParse({
      runId: "run-abc123",
      issueId: "LIN-123",
      stage: "review",
      timestamp: "2026-03-30T12:00:00Z",
      summary: "Review complete",
      filesChanged: [],
      approach: "Reviewed diff",
      context: {
        issueIntent: "Review code",
        constraints: [],
        assumptions: [],
        reviewFindings: [{
          severity: "blocking",
          file: "src/search.ts",
          line: 42,
          category: "SQL Injection",
          description: "User input concatenated into query",
          fix: "Use parameterized query",
        }],
      },
      tokenBudget: { contextTokensUsed: 80000, recommendedMaxTurns: 20 },
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid severity", () => {
    const result = HandoffArtifactSchema.safeParse({
      runId: "run-abc123",
      issueId: "LIN-123",
      stage: "review",
      timestamp: "2026-03-30T12:00:00Z",
      summary: "Review",
      filesChanged: [],
      approach: "Reviewed",
      context: {
        issueIntent: "Review",
        constraints: [],
        assumptions: [],
        reviewFindings: [{
          severity: "critical",
          file: "x.ts",
          line: 1,
          category: "Bug",
          description: "Bad",
          fix: "Fix it",
        }],
      },
      tokenBudget: { contextTokensUsed: 0, recommendedMaxTurns: 0 },
    });
    expect(result.success).toBe(false);
  });
});
