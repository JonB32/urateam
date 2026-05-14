import { describe, it, expect, beforeEach } from "vitest";
import { createDb } from "../db/client.js";
import { auditEvents } from "../db/schema.js";
import { readTriageQualityEvents } from "../audit/triage-quality-reader.js";

let db: any;

beforeEach(async () => {
  db = await createDb({ connectionString: ":memory:" });
});

function makeQualityRow(overrides: Partial<{
  id: string;
  runId: string;
  issueId: string;
  timestamp: Date;
  hasV2Prediction: boolean;
  predicted: number;
  actual: number;
  intersection: number;
  missed: string[];
  unexpected: string[];
}> = {}) {
  const o = {
    id: overrides.id ?? `evt_${Math.random().toString(36).slice(2)}`,
    runId: overrides.runId ?? "run-1",
    issueId: overrides.issueId ?? "BEC-1",
    timestamp: overrides.timestamp ?? new Date(),
    hasV2Prediction: overrides.hasV2Prediction ?? true,
    predicted: overrides.predicted ?? 5,
    actual: overrides.actual ?? 4,
    intersection: overrides.intersection ?? 3,
    missed: overrides.missed ?? ["a.ts"],
    unexpected: overrides.unexpected ?? ["b.ts", "c.ts"],
  };
  return {
    id: o.id,
    timestamp: o.timestamp,
    eventType: "pm.triage_quality_score",
    actor: "system",
    actorType: "system",
    scope: null,
    runId: o.runId,
    issueId: o.issueId,
    inputTokens: 0,
    outputTokens: 0,
    payload: JSON.stringify({
      hasV2Prediction: o.hasV2Prediction,
      predicted: o.predicted,
      actual: o.actual,
      intersection: o.intersection,
      missed: o.missed,
      unexpected: o.unexpected,
    }),
  };
}

describe("readTriageQualityEvents", () => {
  it("returns an empty array when no events exist", async () => {
    const result = await readTriageQualityEvents(db);
    expect(result).toEqual([]);
  });

  it("returns parsed events for pm.triage_quality_score rows", async () => {
    await db.insert(auditEvents).values([makeQualityRow({ id: "evt-1", issueId: "BEC-10" })]);
    const result = await readTriageQualityEvents(db);
    expect(result).toHaveLength(1);
    expect(result[0]!.issueId).toBe("BEC-10");
    expect(result[0]!.payload.hasV2Prediction).toBe(true);
    expect(result[0]!.payload.predicted).toBe(5);
    expect(result[0]!.payload.missed).toEqual(["a.ts"]);
  });

  it("ignores non-triage-quality audit events", async () => {
    await db.insert(auditEvents).values([
      makeQualityRow({ id: "evt-q" }),
      {
        id: "evt-other",
        timestamp: new Date(),
        eventType: "run.completed",
        actor: "system",
        actorType: "system",
        scope: null,
        runId: "run-x",
        issueId: "BEC-99",
        inputTokens: 0,
        outputTokens: 0,
        payload: "{}",
      },
    ]);
    const result = await readTriageQualityEvents(db);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("evt-q");
  });

  it("filters by sinceMs", async () => {
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000); // 10 days ago
    const recent = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000); // 1 day ago
    await db.insert(auditEvents).values([
      makeQualityRow({ id: "evt-old", timestamp: old }),
      makeQualityRow({ id: "evt-recent", timestamp: recent }),
    ]);
    const sinceMs = Date.now() - 7 * 24 * 60 * 60 * 1000; // last 7 days
    const result = await readTriageQualityEvents(db, { sinceMs });
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("evt-recent");
  });

  it("returns most recent first", async () => {
    const t1 = new Date(Date.now() - 3000);
    const t2 = new Date(Date.now() - 1000);
    await db.insert(auditEvents).values([
      makeQualityRow({ id: "evt-old", timestamp: t1 }),
      makeQualityRow({ id: "evt-new", timestamp: t2 }),
    ]);
    const result = await readTriageQualityEvents(db);
    expect(result[0]!.id).toBe("evt-new");
    expect(result[1]!.id).toBe("evt-old");
  });

  it("respects limit option", async () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      makeQualityRow({ id: `evt-${i}`, timestamp: new Date(Date.now() - i * 1000) }),
    );
    await db.insert(auditEvents).values(rows);
    const result = await readTriageQualityEvents(db, { limit: 3 });
    expect(result).toHaveLength(3);
  });

  it("handles hasV2Prediction: false rows gracefully", async () => {
    await db.insert(auditEvents).values([
      makeQualityRow({
        id: "evt-v1",
        hasV2Prediction: false,
        predicted: 0,
        actual: 4,
        intersection: 0,
        missed: [],
        unexpected: [],
      }),
    ]);
    const result = await readTriageQualityEvents(db);
    expect(result[0]!.payload.hasV2Prediction).toBe(false);
    expect(result[0]!.payload.predicted).toBe(0);
    expect(result[0]!.payload.actual).toBe(4);
  });

  it("handles malformed payload gracefully (falls back to zeros)", async () => {
    await db.insert(auditEvents).values([{
      id: "evt-bad",
      timestamp: new Date(),
      eventType: "pm.triage_quality_score",
      actor: "system",
      actorType: "system",
      scope: null,
      runId: "run-bad",
      issueId: "BEC-bad",
      inputTokens: 0,
      outputTokens: 0,
      payload: "not-json{{{",
    }]);
    const result = await readTriageQualityEvents(db);
    expect(result).toHaveLength(1);
    expect(result[0]!.payload.hasV2Prediction).toBe(false);
    expect(result[0]!.payload.predicted).toBe(0);
  });
});
