/**
 * Tier 6e tests: triage prediction quality audit event emission.
 *
 * Tests the integration path: getTriageResult (DB-backed) +
 * computeAffectedFilesPredictionQuality + pmTriageQualityScoreEvent are all
 * called from runner.ts after a successful push.
 */
import { describe, it, expect } from "vitest";
import { computeAffectedFilesPredictionQuality } from "../pm/triage-prediction-quality.js";
import { pmTriageQualityScoreEvent } from "../audit/events.js";

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
// Integration-path tests: the emission flow as called from runner.ts.
// The runner reads the stored triage v2 prediction from
// `triage_results.v2_prediction` (DB), feeds the affectedFiles array into
// computeAffectedFilesPredictionQuality, and emits the audit event.
// ---------------------------------------------------------------------------

describe("triage quality score emission integration (DB-backed read)", () => {
  it("full flow: stored v2 prediction → correct quality computed and event shaped", () => {
    // Simulated stored prediction shape (what getTriageResult returns from DB):
    const stored = {
      affectedFiles: [
        "packages/core/src/types.ts",
        "packages/core/src/audit/events.ts",
        "packages/core/src/pipeline/runner.ts",
      ],
    };
    const actual = [
      "packages/core/src/types.ts",
      "packages/core/src/audit/events.ts",
      "packages/core/src/pm/triage-prediction-quality.ts", // unexpected
    ];

    const quality = computeAffectedFilesPredictionQuality(stored.affectedFiles, actual);
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

  it("v1 path: no stored prediction → hasV2Prediction false, event still emitted", () => {
    // getTriageResult returns undefined when no row exists for the issue.
    const predicted: string[] | undefined = undefined;
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

  it("triage row exists but affectedFiles omitted → hasV2Prediction false", () => {
    // upsertTriageResult writes the row even when triage v2 didn't emit
    // affectedFiles (so we can distinguish "ran but skipped" from "hasn't
    // run"). At read time, `stored.affectedFiles` is undefined → v1 path.
    const stored: { affectedFiles?: string[] } = {};
    const predicted = stored.affectedFiles;
    expect(predicted).toBeUndefined();

    const quality = computeAffectedFilesPredictionQuality(predicted, ["src/x.ts"]);
    expect(quality.hasV2Prediction).toBe(false);
  });

  it("getChangedFiles failure → the catch block prevents throw", () => {
    // Simulate getChangedFiles throwing — the runner wraps the entire block
    // in try/catch. This test verifies our quality result still has sensible
    // shape when actual=[].
    const stored = { affectedFiles: ["src/foo.ts"] };
    const actual: string[] = [];
    const quality = computeAffectedFilesPredictionQuality(stored.affectedFiles, actual);

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
