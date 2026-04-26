import { describe, it, expect } from "vitest";
// Tests assert on the unmerged baseline shape; use DEFAULT_AGENT_PROFILES
// instead of the deprecated `agentProfiles` alias to make that intent explicit.
import {
  DEFAULT_AGENT_PROFILES as agentProfiles,
  DEFAULT_MODEL,
  HAIKU_MODEL,
} from "../executor/profiles.js";
import { parseHandoffArtifact } from "../executor/handoff.js";
import { AGENT_STAGES } from "../types.js";

// ---------------------------------------------------------------------------
// agentProfiles
// ---------------------------------------------------------------------------
describe("agentProfiles", () => {
  /** Assert that the implement stage has the highest value for a given numeric profile field. */
  function expectImplementHasHighest(propName: "maxInputTokens" | "maxTurns") {
    const implementValue = agentProfiles.implement[propName];
    for (const [name, profile] of Object.entries(agentProfiles)) {
      if (name !== "implement") {
        expect(implementValue).toBeGreaterThanOrEqual(profile[propName]);
      }
    }
  }

  it("has a profile for every agent stage", () => {
    for (const stage of AGENT_STAGES) {
      expect(agentProfiles[stage]).toBeDefined();
      expect(agentProfiles[stage].tools.length).toBeGreaterThan(0);
      expect(agentProfiles[stage].maxInputTokens).toBeGreaterThan(0);
      expect(agentProfiles[stage].maxTurns).toBeGreaterThan(0);
    }
  });

  it("triage has Read, Glob, Grep, WebSearch but no Write/Edit/Bash", () => {
    const { tools } = agentProfiles.triage;
    expect(tools).toContain("Read");
    expect(tools).toContain("Glob");
    expect(tools).toContain("Grep");
    expect(tools).toContain("WebSearch");
    expect(tools).not.toContain("Write");
    expect(tools).not.toContain("Edit");
    expect(tools).not.toContain("Bash");
  });

  it("implement has the highest token budget", () => {
    expectImplementHasHighest("maxInputTokens");
  });

  it("implement has the highest turn limit", () => {
    expectImplementHasHighest("maxTurns");
  });

  it("test profile includes Write and Edit for fixing simple test issues", () => {
    const { tools } = agentProfiles.test;
    expect(tools).toContain("Write");
    expect(tools).toContain("Edit");
  });

  it("DEFAULT_MODEL constant has the expected value", () => {
    expect(DEFAULT_MODEL).toBe("claude-sonnet-4-6");
  });

  it("HAIKU_MODEL constant has the expected value", () => {
    expect(HAIKU_MODEL).toBe("claude-haiku-4-5");
  });

  it("each profile has a model field defined", () => {
    for (const stage of AGENT_STAGES) {
      expect(agentProfiles[stage].model).toBeDefined();
    }
  });

  it.each([
    ["test", HAIKU_MODEL],
    ["triage", DEFAULT_MODEL],
    ["reproduce", DEFAULT_MODEL],
    ["implement", DEFAULT_MODEL],
    ["review", DEFAULT_MODEL],
  ] as [string, string][])(
    "%s stage profile uses correct model",
    (stage, expectedModel) => {
      expect(agentProfiles[stage].model).toBe(expectedModel);
    },
  );
});

// ---------------------------------------------------------------------------
// parseHandoffArtifact
// ---------------------------------------------------------------------------
describe("parseHandoffArtifact", () => {
  const validPartialArtifact = {
    summary: "Fixed the login bug",
    filesChanged: ["src/auth.ts"],
    approach: "Updated the token validation logic",
    context: {
      issueIntent: "Fix login failure on expired tokens",
      constraints: ["Must not break existing sessions"],
      assumptions: ["Token refresh is handled client-side"],
    },
    tokenBudget: {
      contextTokensUsed: 12000,
      recommendedMaxTurns: 15,
    },
  };

  function wrapInJsonBlock(obj: unknown): string {
    return `Here is the handoff artifact:\n\n\`\`\`json\n${JSON.stringify(obj, null, 2)}\n\`\`\`\n\nDone.`;
  }

  it("extracts valid HandoffArtifact from agent output with JSON block", () => {
    const output = wrapInJsonBlock(validPartialArtifact);
    const result = parseHandoffArtifact(output, "run-1", "ISS-42", "triage");

    expect(result.structured).toBe(true);
    expect(result.artifact.summary).toBe("Fixed the login bug");
    expect(result.artifact.filesChanged).toEqual(["src/auth.ts"]);
    expect(result.artifact.approach).toBe("Updated the token validation logic");
    expect(result.artifact.context.issueIntent).toBe(
      "Fix login failure on expired tokens",
    );
  });

  it("fills in metadata fields (runId, issueId, stage, timestamp)", () => {
    const output = wrapInJsonBlock(validPartialArtifact);
    const before = new Date().toISOString();
    const result = parseHandoffArtifact(
      output,
      "run-123",
      "ISS-99",
      "implement",
    );
    const after = new Date().toISOString();

    expect(result.structured).toBe(true);
    expect(result.artifact.runId).toBe("run-123");
    expect(result.artifact.issueId).toBe("ISS-99");
    expect(result.artifact.stage).toBe("implement");
    expect(result.artifact.timestamp).toBeDefined();
    expect(result.artifact.timestamp >= before).toBe(true);
    expect(result.artifact.timestamp <= after).toBe(true);
  });

  it("returns unstructured fallback when no JSON block is found", () => {
    const result = parseHandoffArtifact(
      "No json here, just text.",
      "run-1",
      "ISS-1",
      "triage",
    );
    expect(result.structured).toBe(false);
    expect(result.artifact.summary).toBe("No json here, just text.");
    expect(result.artifact.filesChanged).toEqual([]);
  });

  it("returns default summary when agent output is empty", () => {
    const stage = "triage";
    const result = parseHandoffArtifact("", "run-1", "ISS-1", stage);
    expect(result.structured).toBe(false);
    expect(result.artifact.summary).toBe(
      `Stage ${stage} completed without structured output`,
    );
  });

  it("returns unstructured fallback when JSON is invalid (malformed)", () => {
    const output = "```json\n{ invalid json }\n```";
    const result = parseHandoffArtifact(output, "run-1", "ISS-1", "test");
    expect(result.structured).toBe(false);
    expect(result.artifact.summary).toBe(output.slice(0, 500));
    expect(result.artifact.filesChanged).toEqual([]);
  });

  it("returns unstructured fallback when JSON does not conform to HandoffArtifactSchema", () => {
    const incomplete = { summary: "Partial only" };
    const output = wrapInJsonBlock(incomplete);
    const result = parseHandoffArtifact(output, "run-1", "ISS-1", "review");
    expect(result.structured).toBe(false);
    expect(result.artifact.summary).toBe(output.slice(0, 500));
  });

  it("pipeline metadata always overrides agent-supplied identity fields", () => {
    const withOverride = {
      ...validPartialArtifact,
      stage: "custom-stage",
      runId: "agent-injected-id",
    };
    const output = wrapInJsonBlock(withOverride);
    const result = parseHandoffArtifact(output, "run-1", "ISS-1", "triage");
    expect(result.structured).toBe(true);
    // Pipeline metadata wins over agent-supplied fields
    expect(result.artifact.stage).toBe("triage");
    expect(result.artifact.runId).toBe("run-1");
  });

  it("handles multiple JSON blocks by extracting the first one", () => {
    const output = [
      "First block:",
      "```json",
      JSON.stringify(validPartialArtifact, null, 2),
      "```",
      "Second block:",
      '```json\n{"summary":"wrong"}\n```',
    ].join("\n");
    const result = parseHandoffArtifact(output, "run-1", "ISS-1", "triage");
    expect(result.structured).toBe(true);
    expect(result.artifact.summary).toBe("Fixed the login bug");
  });
});
