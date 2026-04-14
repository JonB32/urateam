import { describe, it, expect } from "vitest";
import { createDb } from "../../db/client.js";
import { auditEvents } from "../../db/schema.js";
import { logAuditEvent } from "../../audit/writer.js";
import { pmPromotedEvent } from "../../audit/events.js";

describe("logAuditEvent", () => {
  it("persists an event row", async () => {
    const db = await createDb({ connectionString: ":memory:" });
    await logAuditEvent(
      db,
      pmPromotedEvent({
        issueId: "BEC-1",
        fromState: "Backlog",
        toState: "Todo",
      }),
    );
    const rows = await (db as any).select().from(auditEvents);
    expect(rows).toHaveLength(1);
    expect(rows[0].eventType).toBe("pm.issue_promoted");
    expect(JSON.parse(rows[0].payload)).toMatchObject({
      fromState: "Backlog",
      toState: "Todo",
    });
  });

  it("does not throw when the db insert fails", async () => {
    const fakeDb = {
      insert: () => ({
        values: () => {
          throw new Error("db down");
        },
      }),
    } as any;
    await expect(
      logAuditEvent(
        fakeDb,
        pmPromotedEvent({
          issueId: "BEC-1",
          fromState: "Backlog",
          toState: "Todo",
        }),
      ),
    ).resolves.toBeUndefined();
  });
});
