import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDb } from "../../db/client.js";
import { pipelineRuns, stageRuns } from "../../db/schema.js";
import { streamCostCsv } from "../../cost/csv.js";
import { installTestProLicense, restoreLicense } from "../helpers/license.js";

// streamCostCsv short-circuits to an empty stream without an enterprise
// license (defensive gate). All tests assume the gate has passed.
beforeEach(async () => {
  await installTestProLicense("enterprise");
});
afterEach(async () => {
  await restoreLicense();
});

async function collect(iter: AsyncIterable<string>): Promise<string> {
  let out = "";
  for await (const chunk of iter) out += chunk;
  return out;
}

const config = {
  costs: {
    modelPricing: {
      "claude-sonnet-4-6": { inputPerMillion: 3, outputPerMillion: 15 },
    },
    hourlyEngRate: 50,
    timeSavedPerPrDefault: 4,
  },
  pipelineConfigs: {
    "quick-fix": { profile: { model: "claude-sonnet-4-6" } } as any,
  },
} as any;

describe("streamCostCsv", () => {
  it("emits header then one row per run", async () => {
    const db = await createDb({ connectionString: ":memory:" });
    await (db as any).insert(pipelineRuns).values({
      id: "r1",
      issueId: "BEC-1",
      issueTitle: "t",
      pipelineKey: "quick-fix",
      repoUrl: "https://github.com/acme/api",
      status: "completed",
      startedAt: new Date("2026-04-01T10:00:00Z"),
      completedAt: new Date("2026-04-01T10:05:00Z"),
      linearTeamId: "T1",
    });
    await (db as any).insert(stageRuns).values({
      id: "s1",
      pipelineRunId: "r1",
      stage: "implement",
      status: "completed",
      startedAt: new Date("2026-04-01T10:00:00Z"),
      completedAt: new Date("2026-04-01T10:05:00Z"),
      inputTokens: 100_000,
      outputTokens: 50_000,
    });

    const csv = await collect(
      streamCostCsv(
        db,
        {
          from: new Date("2026-04-01"),
          to: new Date("2026-04-30"),
        },
        config,
      ),
    );
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe(
      "completed_at,run_id,issue_id,pipeline_key,linear_team_id,repo_url,input_tokens,output_tokens,dollars,time_saved_hours",
    );
    expect(lines[1]).toContain("r1");
    expect(lines[1]).toContain("BEC-1");
    expect(lines[1]).toContain("quick-fix");
  });

  it("escapes formula-injection prefixes", async () => {
    const db = await createDb({ connectionString: ":memory:" });
    await (db as any).insert(pipelineRuns).values({
      id: "r1",
      issueId: "=HYPERLINK(evil)",
      issueTitle: "t",
      pipelineKey: "quick-fix",
      repoUrl: "https://github.com/acme/api",
      status: "completed",
      startedAt: new Date("2026-04-01T10:00:00Z"),
      completedAt: new Date("2026-04-01T10:05:00Z"),
    });
    const csv = await collect(
      streamCostCsv(
        db,
        {
          from: new Date("2026-04-01"),
          to: new Date("2026-05-01"),
        },
        config,
      ),
    );
    expect(csv).toContain("'=HYPERLINK(evil)");
  });

  it("caps CSV export at maxRuns and emits a truncation footer", async () => {
    const db = await createDb({ connectionString: ":memory:" });
    // Seed 20 runs across April 2026.
    for (let i = 1; i <= 20; i++) {
      await (db as any).insert(pipelineRuns).values({
        id: `r${i}`,
        issueId: `BEC-${i}`,
        issueTitle: "t",
        pipelineKey: "quick-fix",
        repoUrl: "https://github.com/acme/api",
        status: "completed",
        startedAt: new Date(`2026-04-${String(i).padStart(2, "0")}T10:00:00Z`),
        completedAt: new Date(`2026-04-${String(i).padStart(2, "0")}T10:05:00Z`),
        linearTeamId: "T1",
      });
    }

    const csv = await collect(
      streamCostCsv(
        db,
        { from: new Date("2026-04-01"), to: new Date("2026-05-01") },
        config,
        5,
      ),
    );

    const lines = csv.split("\n").filter(Boolean);
    // 1 header + 5 data rows + 1 truncation footer = 7 lines
    expect(lines).toHaveLength(7);
    expect(lines[0]).toContain("completed_at");
    // Last line is the truncation comment
    expect(lines[6]).toMatch(/^# truncated: 20 runs in window, exported most recent 5/);
  });
});
