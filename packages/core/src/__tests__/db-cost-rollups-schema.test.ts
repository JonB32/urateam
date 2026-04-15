import { describe, it, expect } from "vitest";
import { createDb } from "../db/client.js";
import { costRollupsDaily } from "../db/schema.js";
import { sql } from "drizzle-orm";

describe("cost_rollups_daily schema", () => {
  it("creates table with the expected columns", async () => {
    const db = await createDb({ connectionString: ":memory:" });
    const cols = (db as any).all(sql`PRAGMA table_info(cost_rollups_daily)`) as Array<{name: string}>;
    expect(cols.map(c => c.name).sort()).toEqual([
      "computed_at", "date", "dollars", "id", "input_tokens", "linear_team_id",
      "output_tokens", "pipeline_key", "prs_merged", "repo_url", "runs", "time_saved_hours",
    ]);
  });

  it("inserts and reads back a row", async () => {
    const db = await createDb({ connectionString: ":memory:" });
    await (db as any).insert(costRollupsDaily).values({
      id: "r_1", date: "2026-04-01", pipelineKey: "auto-implement",
      linearTeamId: "T1", repoUrl: "https://github.com/x/y",
      runs: 5, prsMerged: 4, inputTokens: 1000, outputTokens: 500,
      dollars: 12.34, timeSavedHours: 16,
    });
    const rows = await (db as any).select().from(costRollupsDaily);
    expect(rows).toHaveLength(1);
    expect(rows[0].dollars).toBeCloseTo(12.34, 2);
    expect(rows[0].timeSavedHours).toBe(16);
  });
});
