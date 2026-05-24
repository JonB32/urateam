import { describe, it, expect } from "vitest";
import { formatTriageQualityText } from "../commands/triage-quality.js";
import type { TriageQualityEvent } from "@urateam/core";

function makeEvent(
  overrides: Partial<TriageQualityEvent & { payload: Partial<TriageQualityEvent["payload"]> }> = {},
): TriageQualityEvent {
  return {
    id: overrides.id ?? "evt_abc",
    timestamp: overrides.timestamp ?? new Date("2026-05-14T10:00:00Z"),
    runId: overrides.runId ?? "run_aejLOYRQ",
    issueId: overrides.issueId ?? "BEC-217",
    payload: {
      hasV2Prediction: true,
      predicted: 6,
      actual: 6,
      intersection: 5,
      missed: ["packages/core/src/audit/events.ts"],
      unexpected: ["pnpm-lock.yaml"],
      ...(overrides.payload ?? {}),
    },
  };
}

describe("formatTriageQualityText", () => {
  it("outputs 'No triage-quality events' when list is empty", () => {
    const out = formatTriageQualityText([], 7, 20);
    expect(out).toContain("No triage-quality events in the last 7 days.");
  });

  it("includes header with days count", () => {
    const out = formatTriageQualityText([makeEvent()], 14, 20);
    expect(out).toContain("Triage v2 prediction quality — last 14 days");
  });

  it("includes Summary section", () => {
    const events = [
      makeEvent({ issueId: "BEC-1" }),
      makeEvent({
        issueId: "BEC-2",
        payload: { hasV2Prediction: false, predicted: 0, actual: 3, intersection: 0, missed: [], unexpected: [] },
      }),
    ];
    const out = formatTriageQualityText(events, 7, 20);
    expect(out).toContain("Summary:");
    expect(out).toContain("Runs with v2 prediction:    1");
    expect(out).toContain("Runs without v2 prediction:  1");
  });

  it("computes intersection ratio correctly", () => {
    // predicted=6, actual=6, intersection=5 → ratio = 5/6 ≈ 83%
    const out = formatTriageQualityText([makeEvent()], 7, 20);
    expect(out).toContain("Avg intersection ratio:    83%");
  });

  it("includes Top missed files section", () => {
    const events = [
      makeEvent({ payload: { hasV2Prediction: true, predicted: 2, actual: 1, intersection: 1, missed: ["CLAUDE.md"], unexpected: [] } }),
      makeEvent({ payload: { hasV2Prediction: true, predicted: 2, actual: 1, intersection: 1, missed: ["CLAUDE.md"], unexpected: [] } }),
    ];
    const out = formatTriageQualityText(events, 7, 20);
    expect(out).toContain("Top missed files (predicted but not in diff):");
    expect(out).toContain("CLAUDE.md");
    expect(out).toContain("2 runs");
  });

  it("includes Top unexpected files section", () => {
    const events = [
      makeEvent({ payload: { hasV2Prediction: true, predicted: 1, actual: 2, intersection: 1, missed: [], unexpected: ["pnpm-lock.yaml"] } }),
    ];
    const out = formatTriageQualityText(events, 7, 20);
    expect(out).toContain("Top unexpected files (in diff but not predicted):");
    expect(out).toContain("pnpm-lock.yaml");
  });

  it("includes Recent runs section with correct format for v2", () => {
    const out = formatTriageQualityText([makeEvent()], 7, 20);
    expect(out).toContain("Recent runs (most recent first):");
    // run_aejLOYRQ sliced to 8 chars = "run_aejL"
    expect(out).toContain("predicted=6");
    expect(out).toContain("actual=6");
    expect(out).toContain("hit=5/6");
  });

  it("includes Recent runs section with correct format for non-v2", () => {
    const events = [
      makeEvent({
        payload: { hasV2Prediction: false, predicted: 0, actual: 4, intersection: 0, missed: [], unexpected: [] },
      }),
    ];
    const out = formatTriageQualityText(events, 7, 20);
    expect(out).toContain("(no v2 prediction)");
    expect(out).toContain("actual=4");
  });

  it("respects limit for Recent runs table", () => {
    const events = Array.from({ length: 10 }, (_, i) =>
      makeEvent({ id: `evt-${i}`, issueId: `BEC-${i}`, runId: `run_${i.toString().padStart(8, "0")}` }),
    );
    const out = formatTriageQualityText(events, 7, 3);
    // Only 3 runs should appear in Recent runs section
    const recentSection = out.split("Recent runs (most recent first):")[1] ?? "";
    const runLines = recentSection.split("\n").filter((l) => l.trim().startsWith("BEC-") || l.match(/^\s+BEC-/));
    expect(runLines.length).toBeLessThanOrEqual(3);
  });

  it("shows (none) when no missed files", () => {
    const events = [
      makeEvent({ payload: { hasV2Prediction: true, predicted: 3, actual: 3, intersection: 3, missed: [], unexpected: [] } }),
    ];
    const out = formatTriageQualityText(events, 7, 20);
    expect(out).toContain("Top missed files (predicted but not in diff):");
    const missedSection = out.split("Top missed files (predicted but not in diff):")[1] ?? "";
    expect(missedSection).toContain("(none)");
  });
});
