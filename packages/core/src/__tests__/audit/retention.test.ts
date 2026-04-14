import { describe, it, expect } from "vitest";
import { createDb } from "../../db/client.js";
import { auditEvents, pipelineRuns } from "../../db/schema.js";
import { pruneAuditLog } from "../../audit/retention.js";

describe("pruneAuditLog", () => {
  it("deletes rows older than retentionDays", async () => {
    const db = await createDb({ connectionString: ":memory:" });
    const now = Date.now();
    await (db as any).insert(auditEvents).values([
      {
        id: "old",
        timestamp: new Date(now - 400 * 86400000),
        eventType: "pm.issue_promoted",
        actor: "pm-agent",
        actorType: "pm-agent",
        payload: "{}",
      },
      {
        id: "new",
        timestamp: new Date(now - 10 * 86400000),
        eventType: "pm.issue_promoted",
        actor: "pm-agent",
        actorType: "pm-agent",
        payload: "{}",
      },
    ]);
    const deleted = await pruneAuditLog(db, 365);
    expect(deleted).toBe(1);
    const rows = await (db as any).select().from(auditEvents);
    expect(rows.map((r: any) => r.id)).toEqual(["new"]);
  });

  it("does not touch pipeline_runs", async () => {
    const db = await createDb({ connectionString: ":memory:" });
    await (db as any).insert(pipelineRuns).values({
      id: "r1",
      issueId: "BEC-1",
      issueTitle: "t",
      pipelineKey: "auto-implement",
      repoUrl: "x",
      status: "completed",
      startedAt: new Date(Date.now() - 400 * 86400000),
    });
    await pruneAuditLog(db, 365);
    const rows = await (db as any).select().from(pipelineRuns);
    expect(rows).toHaveLength(1);
  });
});
