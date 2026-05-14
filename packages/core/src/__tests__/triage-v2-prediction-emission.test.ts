/**
 * Tier 6e tests: triage prediction quality audit event emission.
 *
 * Tests the integration path: parseAffectedFilesFromDescription +
 * computeAffectedFilesPredictionQuality + pmTriageQualityScoreEvent are all
 * called from runner.ts after a successful push.
 */
import { describe, it, expect } from "vitest";
import {
  parseAffectedFilesFromDescription,
  computeAffectedFilesPredictionQuality,
} from "../pm/triage-prediction-quality.js";
import { pmTriageQualityScoreEvent } from "../audit/events.js";

// ---------------------------------------------------------------------------
// parseAffectedFilesFromDescription unit tests
// ---------------------------------------------------------------------------

describe("parseAffectedFilesFromDescription", () => {
  it("returns undefined when no Affected Files section exists (v1 triage)", () => {
    const description = `## Summary\n\nFix a bug.\n\n**Acceptance Criteria:**\n- It works`;
    expect(parseAffectedFilesFromDescription(description)).toBeUndefined();
  });

  it("returns an array of paths when section exists", () => {
    const description = [
      "**Acceptance Criteria:**",
      "- fix it",
      "",
      "**Affected Files:**",
      "- src/foo.ts",
      "- src/bar.ts",
      "",
      "**Test Strategy:**",
      "- unit tests",
    ].join("\n");
    expect(parseAffectedFilesFromDescription(description)).toEqual([
      "src/foo.ts",
      "src/bar.ts",
    ]);
  });

  it("returns empty array when section exists but has no list items", () => {
    const description = `**Affected Files:**\n\n**Test Strategy:**\n- unit`;
    expect(parseAffectedFilesFromDescription(description)).toEqual([]);
  });

  it("handles section at end of description", () => {
    const description = `**Affected Files:**\n- src/alpha.ts\n- src/beta.ts`;
    expect(parseAffectedFilesFromDescription(description)).toEqual([
      "src/alpha.ts",
      "src/beta.ts",
    ]);
  });
});

// ---------------------------------------------------------------------------
// computeAffectedFilesPredictionQuality unit tests
// ---------------------------------------------------------------------------

describe("computeAffectedFilesPredictionQuality", () => {
  it("v2 prediction present → computes quality metrics correctly", () => {
    const predicted = ["src/foo.ts", "src/bar.ts", "src/baz.ts"];
    const actual = ["src/foo.ts", "src/bar.ts", "src/qux.ts"];
    const result = computeAffectedFilesPredictionQuality(predicted, actual);
    expect(result.hasV2Prediction).toBe(true);
    expect(result.predicted).toBe(3);
    expect(result.actual).toBe(3);
    expect(result.intersection).toBe(2);
    expect(result.missed).toEqual(["src/baz.ts"]);
    expect(result.unexpected).toEqual(["src/qux.ts"]);
  });

  it("v1 path (no prediction) → hasV2Prediction false, all metrics zeroed", () => {
    const result = computeAffectedFilesPredictionQuality(undefined, ["src/foo.ts"]);
    expect(result.hasV2Prediction).toBe(false);
    expect(result.predicted).toBe(0);
    expect(result.intersection).toBe(0);
    expect(result.missed).toEqual([]);
    expect(result.unexpected).toEqual(["src/foo.ts"]);
  });

  it("empty actual files → all files are missed", () => {
    const result = computeAffectedFilesPredictionQuality(["src/foo.ts"], []);
    expect(result.hasV2Prediction).toBe(true);
    expect(result.actual).toBe(0);
    expect(result.intersection).toBe(0);
    expect(result.missed).toEqual(["src/foo.ts"]);
    expect(result.unexpected).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// pmTriageQualityScoreEvent unit tests
// ---------------------------------------------------------------------------

describe("pmTriageQualityScoreEvent", () => {
  it("produces correct event shape with v2 prediction", () => {
    const event = pmTriageQualityScoreEvent({
      runId: "run-123",
      issueId: "BEC-217",
      hasV2Prediction: true,
      predicted: 3,
      actual: 2,
      intersection: 1,
      missed: ["src/baz.ts"],
      unexpected: ["src/qux.ts"],
    });
    expect(event.eventType).toBe("pm.triage_quality_score");
    expect(event.actor).toBe("system");
    expect(event.actorType).toBe("system");
    expect(event.runId).toBe("run-123");
    expect(event.issueId).toBe("BEC-217");
    expect(event.payload).toMatchObject({
      hasV2Prediction: true,
      predicted: 3,
      actual: 2,
      intersection: 1,
      missed: ["src/baz.ts"],
      unexpected: ["src/qux.ts"],
    });
  });

  it("v1 path → event still emitted with hasV2Prediction false", () => {
    const event = pmTriageQualityScoreEvent({
      runId: "run-456",
      issueId: "BEC-100",
      hasV2Prediction: false,
      predicted: 0,
      actual: 5,
      intersection: 0,
      missed: [],
      unexpected: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"],
    });
    expect(event.eventType).toBe("pm.triage_quality_score");
    expect(event.payload).toMatchObject({ hasV2Prediction: false, predicted: 0 });
  });

  it("caps missed and unexpected at 50 paths", () => {
    const many = Array.from({ length: 60 }, (_, i) => `src/file${i}.ts`);
    const event = pmTriageQualityScoreEvent({
      runId: "run-789",
      issueId: "BEC-999",
      hasV2Prediction: true,
      predicted: 60,
      actual: 60,
      intersection: 0,
      missed: many,
      unexpected: many,
    });
    expect((event.payload as any).missed).toHaveLength(50);
    expect((event.payload as any).unexpected).toHaveLength(50);
  });
});

// ---------------------------------------------------------------------------
// Integration-path tests: the emission flow as called from runner.ts
// ---------------------------------------------------------------------------

describe("triage quality score emission integration", () => {
  it("full flow: v2 prediction → correct quality computed and event shaped", async () => {
    // Simulate the runner.ts flow:
    // 1. Parse predicted from description
    // 2. Supply mock actual files
    // 3. Call compute
    // 4. Build event
    const description = [
      "**Acceptance Criteria:**",
      "- It works",
      "",
      "**Affected Files:**",
      "- packages/core/src/types.ts",
      "- packages/core/src/audit/events.ts",
      "- packages/core/src/pipeline/runner.ts",
    ].join("\n");

    const predicted = parseAffectedFilesFromDescription(description);
    const actual = [
      "packages/core/src/types.ts",
      "packages/core/src/audit/events.ts",
      "packages/core/src/pm/triage-prediction-quality.ts", // unexpected
    ];

    const quality = computeAffectedFilesPredictionQuality(predicted, actual);
    const event = pmTriageQualityScoreEvent({
      runId: "run-bec217",
      issueId: "BEC-217",
      ...quality,
    });

    expect(event.eventType).toBe("pm.triage_quality_score");
    expect(event.payload).toMatchObject({
      hasV2Prediction: true,
      predicted: 3,
      actual: 3,
      intersection: 2,
      missed: ["packages/core/src/pipeline/runner.ts"],
      unexpected: ["packages/core/src/pm/triage-prediction-quality.ts"],
    });
  });

  it("v1 path: no Affected Files section → hasV2Prediction false, event still emitted", () => {
    const description = "## Summary\n\nFix a bug.\n\n**Acceptance Criteria:**\n- It works";
    const predicted = parseAffectedFilesFromDescription(description);

    // predicted is undefined (v1 path)
    expect(predicted).toBeUndefined();

    const actual = ["src/foo.ts", "src/bar.ts"];
    const quality = computeAffectedFilesPredictionQuality(predicted, actual);
    const event = pmTriageQualityScoreEvent({
      runId: "run-v1",
      issueId: "BEC-100",
      ...quality,
    });

    expect(event.payload).toMatchObject({
      hasV2Prediction: false,
      predicted: 0,
      actual: 2,
      intersection: 0,
    });
  });

  it("getChangedFiles failure → the catch block prevents throw", async () => {
    // Simulate getChangedFiles throwing — the runner wraps the entire block in try/catch
    // This test verifies our quality result still has sensible shape when actual=[]
    const description = "**Affected Files:**\n- src/foo.ts\n";
    const predicted = parseAffectedFilesFromDescription(description);

    // Simulate getChangedFiles failing: we pass empty array (the fail-open return)
    const actual: string[] = [];
    const quality = computeAffectedFilesPredictionQuality(predicted, actual);

    // Should not throw
    expect(() => pmTriageQualityScoreEvent({
      runId: "run-fail",
      issueId: "BEC-999",
      ...quality,
    })).not.toThrow();

    expect(quality.hasV2Prediction).toBe(true);
    expect(quality.actual).toBe(0);
    expect(quality.intersection).toBe(0);
    expect(quality.missed).toEqual(["src/foo.ts"]);
  });
});
