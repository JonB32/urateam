import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDb } from "../../db/client.js";
import { pipelineRuns } from "../../db/schema.js";
import { logAuditEvent } from "../../audit/writer.js";
import { pmPromotedEvent } from "../../audit/events.js";
import { listAuditEvents } from "../../audit/reader.js";
import { installTestProLicense, restoreLicense } from "../helpers/license.js";

let db: any;

beforeEach(async () => {
  await installTestProLicense("enterprise");
  db = await createDb({ connectionString: ":memory:" });
});

afterEach(async () => {
  await restoreLicense();
});

describe("audit log end-to-end", () => {
  it("surfaces projected pipeline_runs events and native audit_events through listAuditEvents", async () => {
    // Seed completed pipeline run with autoMerged=true
    await db.insert(pipelineRuns).values({
      id: "run_int_1",
      issueId: "BEC-INT",
      issueTitle: "integration test issue",
      pipelineKey: "auto-implement",
      repoUrl: "https://example.com/org/repo",
      status: "completed",
      startedAt: new Date("2026-04-01T10:00:00Z"),
      completedAt: new Date("2026-04-01T10:05:00Z"),
      totalInputTokens: 1000,
      totalOutputTokens: 500,
      runType: "standard",
      linearTeamId: "T-int",
      autoMerged: true,
      autoMergeReason: "trivial diff",
    });

    // Seed native audit event with team scope
    const promoted = pmPromotedEvent({
      issueId: "BEC-INT",
      fromState: "Backlog",
      toState: "Todo",
    });
    promoted.scope = "team:T-int";
    await logAuditEvent(db, promoted);

    const { events } = await listAuditEvents(db, { limit: 100 });
    const types = events.map(e => e.eventType);
    expect(types).toContain("run.started");
    expect(types).toContain("run.completed");
    expect(types).toContain("run.auto_merged");
    expect(types).toContain("pm.issue_promoted");

    const { events: byRun } = await listAuditEvents(db, { runId: "run_int_1", limit: 100 });
    expect(byRun.length).toBeGreaterThan(0);
    for (const e of byRun) {
      expect(e.runId).toBe("run_int_1");
    }
  });
});
