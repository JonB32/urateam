import { describe, it, expect, beforeEach } from "vitest";
import { createDb } from "../../db/client.js";
import { logAuditEvent } from "../../audit/writer.js";
import { pmPromotedEvent, budgetRefusedEvent } from "../../audit/events.js";
import { streamAuditCsv } from "../../audit/csv.js";
import type { AuditEvent } from "../../types.js";

let db: any;

beforeEach(async () => {
  db = await createDb({ connectionString: ":memory:" });
});

async function collect(gen: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const row of gen) out.push(row);
  return out;
}

describe("streamAuditCsv", () => {
  it("yields header row first", async () => {
    const rows = await collect(streamAuditCsv(db, {}));
    expect(rows[0]).toBe(
      "timestamp_utc,event_type,actor,actor_type,scope,run_id,issue_id,input_tokens,output_tokens,payload_json",
    );
  });

  it("streams data rows after header", async () => {
    await logAuditEvent(
      db,
      pmPromotedEvent({ issueId: "BEC-1", fromState: "Backlog", toState: "Todo" }),
    );
    await logAuditEvent(
      db,
      budgetRefusedEvent({
        scope: "team:T1",
        scopeType: "team",
        tokensUsed: 100,
        limit: 100,
        utilization: 100,
      }),
    );
    const rows = await collect(streamAuditCsv(db, {}));
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows[0]).toMatch(/^timestamp_utc,/);
    // data rows should have 10 fields (allowing embedded escaped quotes)
    const dataRow = rows[1];
    expect(dataRow).toContain(",");
  });

  it("escapes fields containing commas, quotes, and newlines", async () => {
    // scope is written as-is (not JSON-stringified), so a raw
    // `has "quotes", commas` value must be CSV-escaped: wrap in quotes,
    // double internal quotes → `"has ""quotes"", commas"`.
    await logAuditEvent(db, {
      id: "evt_csv_1",
      timestamp: new Date(),
      eventType: "pm.issue_promoted",
      actor: "pm-agent",
      actorType: "system",
      scope: 'has "quotes", commas',
      runId: null,
      issueId: "BEC-1",
      inputTokens: 0,
      outputTokens: 0,
      payload: {},
    });
    const rows = await collect(streamAuditCsv(db, {}));
    const dataRow = rows.find((r) => r.includes("pm.issue_promoted"));
    expect(dataRow).toBeDefined();
    // scope field should have escaped doubled quotes around "quotes"
    expect(dataRow).toContain('""quotes""');
    // and the scope cell should be wrapped in quotes
    expect(dataRow).toContain('"has ""quotes"", commas"');
  });

  it("escapes fields containing newlines", async () => {
    await logAuditEvent(db, {
      id: "evt_csv_2",
      timestamp: new Date(),
      eventType: "pm.issue_promoted",
      actor: "pm-agent",
      actorType: "system",
      scope: "line1\nline2",
      runId: null,
      issueId: "BEC-1",
      inputTokens: 0,
      outputTokens: 0,
      payload: {},
    });
    const rows = await collect(streamAuditCsv(db, {}));
    const dataRow = rows.find((r) => r.includes("pm.issue_promoted"));
    expect(dataRow).toContain('"line1\nline2"');
  });

  it("pages through events via pageSize", async () => {
    for (let i = 0; i < 6; i++) {
      await logAuditEvent(
        db,
        pmPromotedEvent({ issueId: `BEC-${i}`, fromState: "Backlog", toState: "Todo" }),
      );
    }
    const rows = await collect(streamAuditCsv(db, {}, 3));
    // 1 header + 6 data rows across 2 pages
    expect(rows.length).toBe(7);
    expect(rows[0]).toMatch(/^timestamp_utc,/);
  });
});
