import { describe, it, expect } from "vitest";
import { handoffBlock } from "../executor/prompt/templates.js";
import type { HandoffArtifact } from "../types.js";

const handoff: HandoffArtifact = {
  runId: "run-1",
  issueId: "ENG-1",
  stage: "implement",
  timestamp: "2026-01-01T00:00:00Z",
  summary: "Implemented feature X",
  filesChanged: ["a.ts"],
  approach: "Wrote function foo",
  context: {
    issueIntent: "Add feature X",
    constraints: [],
    assumptions: [],
  },
  tokenBudget: {
    contextTokensUsed: 100,
    recommendedMaxTurns: 5,
  },
};

describe("handoffBlock suppression (BEC-227)", () => {
  it("suppress=true → returns empty string", () => {
    const out = handoffBlock(handoff, { suppress: true });
    expect(out).toBe("");
  });

  it("suppress=false → returns XML block as before", () => {
    const out = handoffBlock(handoff, { suppress: false });
    expect(out).toContain("<previous-stage-context>");
    expect(out).toContain("Implemented feature X");
  });

  it("suppress option omitted → defaults to false (legacy behavior)", () => {
    const out = handoffBlock(handoff);
    expect(out).toContain("<previous-stage-context>");
    expect(out).toContain("Implemented feature X");
  });
});
