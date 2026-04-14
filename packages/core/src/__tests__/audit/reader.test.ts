import { describe, it, expect, beforeEach } from "vitest";
import { createDb } from "../../db/client.js";
import { auditEvents, pipelineRuns, pmApprovals, budgetAlerts } from "../../db/schema.js";
import { logAuditEvent } from "../../audit/writer.js";
import { pmPromotedEvent, budgetRefusedEvent } from "../../audit/events.js";
import { listAuditEvents } from "../../audit/reader.js";

let db: any;

beforeEach(async () => {
  db = await createDb({ connectionString: ":memory:" });
});

async function seed() {
  // native audit events
  await logAuditEvent(db, pmPromotedEvent({ issueId: "BEC-1", fromState: "Backlog", toState: "Todo" }));
  await logAuditEvent(db, budgetRefusedEvent({
    scope: "team:T1", scopeType: "team", tokensUsed: 100, limit: 100, utilization: 100,
  }));
  // projectable: pipeline run
  await db.insert(pipelineRuns).values({
    id: "run_1", issueId: "BEC-9", issueTitle: "t", pipelineKey: "auto-implement",
    repoUrl: "https://x.y/z", status: "completed",
    startedAt: new Date("2026-04-01T10:00:00Z"),
    completedAt: new Date("2026-04-01T10:05:00Z"),
    totalInputTokens: 100, totalOutputTokens: 50, runType: "standard",
    linearTeamId: "T1",
  });
}

describe("listAuditEvents", () => {
  it("returns native + projected events merged by time", async () => {
    await seed();
    const { events } = await listAuditEvents(db, { limit: 100 });
    const types = events.map(e => e.eventType).sort();
    expect(types).toContain("pm.issue_promoted");
    expect(types).toContain("budget.run_refused");
    expect(types).toContain("run.started");
    expect(types).toContain("run.completed");
  });

  it("filters by event type", async () => {
    await seed();
    const { events } = await listAuditEvents(db, { eventTypes: ["run.completed"], limit: 100 });
    expect(events.map(e => e.eventType)).toEqual(["run.completed"]);
  });

  it("filters by scope prefix-exact", async () => {
    await seed();
    const { events } = await listAuditEvents(db, { scope: "team:T1", limit: 100 });
    for (const e of events) expect(e.scope === "team:T1" || e.scope === null).toBeTruthy();
    expect(events.some(e => e.scope === "team:T1")).toBe(true);
  });

  it("filters by date window", async () => {
    await seed();
    const from = new Date("2026-04-01T09:00:00Z");
    const to = new Date("2026-04-01T10:10:00Z");
    const { events } = await listAuditEvents(db, { from, to, limit: 100 });
    for (const e of events) {
      expect(e.timestamp >= from && e.timestamp <= to).toBe(true);
    }
  });

  it("filters by runId", async () => {
    await seed();
    const { events } = await listAuditEvents(db, { runId: "run_1", limit: 100 });
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) expect(e.runId).toBe("run_1");
  });

  it("paginates via cursor", async () => {
    // seed 5 promoted events
    for (let i = 0; i < 5; i++) {
      await logAuditEvent(db, pmPromotedEvent({ issueId: `BEC-${i}`, fromState: "Backlog", toState: "Todo" }));
      await new Promise(r => setTimeout(r, 10));
    }
    const page1 = await listAuditEvents(db, { limit: 2 });
    expect(page1.events).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await listAuditEvents(db, { limit: 2, cursor: page1.nextCursor! });
    expect(page2.events).toHaveLength(2);
    const seen = new Set([...page1.events, ...page2.events].map(e => e.id));
    expect(seen.size).toBe(4);
  });
});
