import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPmScheduler } from "../pm/scheduler.js";
import { createDb } from "../db/client.js";
import { pipelineRuns, stageRuns, costRollupsDaily } from "../db/schema.js";
import { installTestProLicense, restoreLicense } from "./helpers/license.js";

function stubActions() {
  return {
    evaluateBudget: vi.fn().mockResolvedValue({
      scopes: [
        {
          scope: { kind: "global" as const },
          scopeLabel: "global",
          limit: 100,
          used: 0,
          percent: 0,
          tier: "ok" as const,
        },
      ],
      worstTier: "ok" as const,
      promoteBlocked: false,
      activeCount: 0,
    }),
    recoverRetriableRuns: vi.fn().mockResolvedValue({ recovered: [], exhausted: [] }),
    recoverStuckInProgressIssues: vi.fn().mockResolvedValue([]),
    triageNewIssues: vi.fn().mockResolvedValue([]),
    resolveApprovals: vi.fn().mockResolvedValue({ resolved: 0, stillPending: 0 }),
    promoteReadyIssues: vi.fn().mockResolvedValue([]),
    deprioritizeStaleIssues: vi.fn().mockResolvedValue([]),
    cancelAbandonedIssues: vi.fn().mockResolvedValue([]),
    postDigest: vi.fn().mockResolvedValue(undefined),
    getActiveFileMaps: vi.fn().mockResolvedValue(new Map()),
    predictConflict: vi.fn().mockResolvedValue({ overlapRisk: "none", likelyFiles: [], reasoning: "" }),
  };
}

function baseConfig(extra: Record<string, unknown> = {}): any {
  return {
    enabled: true,
    cronIntervalMs: 1800000,
    triageBatchSize: 3,
    maxInFlight: 3,
    dailyTokenBudget: 100,
    slackChannelId: "C123",
    teamIds: ["team-1"],
    ...extra,
  };
}

function yesterdayNoonUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1, 12, 0, 0,
  ));
}

describe("pm tick cost rollup step", () => {
  beforeEach(async () => {
    await installTestProLicense("enterprise");
  });

  afterEach(async () => {
    await restoreLicense();
  });

  it("writes cost_rollups_daily rows for yesterday's completed runs", async () => {
    const db = await createDb({ connectionString: ":memory:" });

    const completedAt = yesterdayNoonUtc();
    const startedAt = new Date(completedAt.getTime() - 3600 * 1000);

    await (db as any).insert(pipelineRuns).values({
      id: "run-1",
      issueId: "ISSUE-1",
      issueTitle: "test issue",
      pipelineKey: "auto-implement",
      repoUrl: "https://github.com/acme/app",
      branch: "agent/ISSUE-1",
      status: "completed",
      startedAt,
      completedAt,
      totalInputTokens: 1000,
      totalOutputTokens: 500,
      linearTeamId: "team-1",
    });

    await (db as any).insert(stageRuns).values({
      id: "stage-1",
      pipelineRunId: "run-1",
      stage: "implement",
      status: "completed",
      startedAt,
      completedAt,
      inputTokens: 1000,
      outputTokens: 500,
      turns: 3,
    });

    const scheduler = createPmScheduler({
      config: baseConfig(),
      db: db as any,
      linearApiKey: "",
      slackBotToken: "",
      actions: stubActions() as any,
    });

    await scheduler.tick();

    const rows = await (db as any).select().from(costRollupsDaily);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].pipelineKey).toBe("auto-implement");
    expect(rows[0].runs).toBe(1);
  });

  it("tick does not throw when rollup fails", async () => {
    const db = await createDb({ connectionString: ":memory:" });
    await (db as any).run?.("DROP TABLE cost_rollups_daily");

    const scheduler = createPmScheduler({
      config: baseConfig(),
      db: db as any,
      linearApiKey: "",
      slackBotToken: "",
      actions: stubActions() as any,
    });

    await expect(scheduler.tick()).resolves.toBeUndefined();
  });
});
