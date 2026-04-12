import { describe, it, expect } from "vitest";
import { assemblePrompt } from "../executor/prompt/assembler.js";
import type { SanitizedIssue, RepoConfig, HandoffArtifact, StageType } from "../types.js";

const issue: SanitizedIssue = {
  id: "ENG-99",
  slug: "add-feature",
  title: "Add feature",
  description: "Add a new feature.",
  acceptanceCriteria: ["Feature works"],
  labels: ["feature"],
  priority: 2,
};

const repo: RepoConfig = {
  url: "https://github.com/acme/app",
  defaultBranch: "main",
  testCommand: "npm test",
  buildCommand: "npm run build",
};

const handoff: HandoffArtifact = {
  runId: "run-2",
  issueId: "ENG-99",
  stage: "reproduce",
  timestamp: "2026-01-02T00:00:00Z",
  summary: "Reproduced successfully",
  filesChanged: ["src/feature.ts"],
  approach: "Add new module",
  context: {
    issueIntent: "New feature",
    constraints: [],
    assumptions: [],
  },
  tokenBudget: {
    contextTokensUsed: 300,
    recommendedMaxTurns: 5,
  },
};

describe("assemblePrompt", () => {
  it("assembles triage prompt", () => {
    const result = assemblePrompt("triage", issue, repo);
    expect(result).toContain("triage agent");
    expect(result).toContain("<issue-data>");
    expect(result).toContain("<repo-context>");
  });

  it("assembles implement prompt with handoff", () => {
    const result = assemblePrompt("implement", issue, repo, handoff);
    expect(result).toContain("<previous-stage-context>");
    expect(result).toContain("Reproduced successfully");
  });

  it("assembles review prompt with security checklist", () => {
    const result = assemblePrompt("review", issue, repo);
    expect(result).toContain("INJECTION");
    expect(result).toContain("AUTHENTICATION");
  });

  it("throws for await-approval", () => {
    expect(() =>
      assemblePrompt("await-approval", issue, repo),
    ).toThrow("await-approval is not an agent stage — no prompt needed");
  });

  it("all 5 agent stages assemble without error", () => {
    const stages: StageType[] = ["triage", "reproduce", "implement", "test", "review"];
    for (const stage of stages) {
      expect(() => assemblePrompt(stage, issue, repo)).not.toThrow();
    }
  });
});
