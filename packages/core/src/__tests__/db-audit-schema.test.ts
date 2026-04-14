import { describe, it, expect } from "vitest";
import { createDb } from "../db/client.js";
import { auditEvents } from "../db/schema.js";
import { sql } from "drizzle-orm";

describe("audit_events schema", () => {
  it("creates the table with required columns on fresh SQLite db", async () => {
    const db = await createDb({ connectionString: ":memory:" });
    const cols = (db as any).all(sql`PRAGMA table_info(audit_events)`) as Array<{name: string}>;
    const names = cols.map(c => c.name).sort();
    expect(names).toEqual([
      "actor", "actor_type", "event_type", "id", "input_tokens",
      "issue_id", "output_tokens", "payload", "run_id", "scope", "timestamp",
    ]);
  });

  it("inserts and reads back an audit event", async () => {
    const db = await createDb({ connectionString: ":memory:" });
    await (db as any).insert(auditEvents).values({
      id: "evt_1",
      eventType: "pm.issue_promoted",
      actor: "pm-agent",
      actorType: "pm-agent",
      scope: "team:T1",
      runId: null,
      issueId: "BEC-1",
      inputTokens: 0,
      outputTokens: 0,
      payload: JSON.stringify({ test: true }),
    });
    const rows = await (db as any).select().from(auditEvents);
    expect(rows).toHaveLength(1);
    expect(rows[0].eventType).toBe("pm.issue_promoted");
    expect(rows[0].timestamp).toBeInstanceOf(Date);
  });
});
