import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPmScheduler } from "../pm/scheduler.js";
import { createDb } from "../db/client.js";
import { auditEvents } from "../db/schema.js";
import { installTestProLicense, restoreLicense } from "./helpers/license.js";
import type { BudgetEvaluation } from "../pm/types.js";

function mixedBlockedEvaluation(): BudgetEvaluation {
  return {
    scopes: [
      {
        scope: { kind: "global" as const },
        scopeLabel: "global",
        limit: 100,
        used: 100,
        percent: 100,
        tier: "blocked-100" as const,
      },
      {
        scope: { kind: "team" as const, teamId: "T1" },
        scopeLabel: "team T1",
        limit: 50,
        used: 60,
        percent: 120,
        tier: "blocked-100" as const,
      },
      {
        scope: { kind: "repo" as const, repoUrl: "https://github.com/x/y" },
        scopeLabel: "repo x",
        limit: 100,
        used: 10,
        percent: 10,
        tier: "ok" as const,
      },
    ],
    worstTier: "blocked-100",
    promoteBlocked: true,
    blockReason: "global at 100%",
    activeCount: 0,
  };
}

describe("budget.run_refused audit event", () => {
  beforeEach(async () => {
    await installTestProLicense("enterprise");
  });

  afterEach(async () => {
    await restoreLicense();
  });

  it("writes one event per blocked scope from evaluateBudget", async () => {
    const db = await createDb({ connectionString: ":memory:" });

    const mockActions = {
      evaluateBudget: vi.fn().mockResolvedValue(mixedBlockedEvaluation()),
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

    const scheduler = createPmScheduler({
      config: {
        enabled: true,
        cronIntervalMs: 1800000,
        triageBatchSize: 3,
        maxInFlight: 3,
        dailyTokenBudget: 100,
        slackChannelId: "C123",
        teamIds: ["team-1"],
      } as any,
      db: db as any,
      linearApiKey: "",
      slackBotToken: "",
      actions: mockActions as any,
    });

    await scheduler.tick();

    const rows = await (db as any).select().from(auditEvents);
    const refused = rows.filter((r: any) => r.eventType === "budget.run_refused");
    expect(refused).toHaveLength(2);
    const scopes = refused.map((r: any) => r.scope).sort();
    expect(scopes).toEqual(["global", "team:T1"]);

    for (const row of refused) {
      const payload = JSON.parse(row.payload);
      expect(payload).toHaveProperty("scopeType");
      expect(payload).toHaveProperty("tokensUsed");
      expect(payload).toHaveProperty("limit");
      expect(payload).toHaveProperty("utilization");
    }
  });

  it("does not write audit events when no scopes are blocked", async () => {
    const db = await createDb({ connectionString: ":memory:" });

    const mockActions = {
      evaluateBudget: vi.fn().mockResolvedValue({
        scopes: [
          {
            scope: { kind: "global" as const },
            scopeLabel: "global",
            limit: 100,
            used: 10,
            percent: 10,
            tier: "ok" as const,
          },
        ],
        worstTier: "ok",
        promoteBlocked: false,
        activeCount: 0,
      } as BudgetEvaluation),
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

    const scheduler = createPmScheduler({
      config: {
        enabled: true,
        cronIntervalMs: 1800000,
        triageBatchSize: 3,
        maxInFlight: 3,
        dailyTokenBudget: 100,
        slackChannelId: "C123",
        teamIds: ["team-1"],
      } as any,
      db: db as any,
      linearApiKey: "",
      slackBotToken: "",
      actions: mockActions as any,
    });

    await scheduler.tick();

    const rows = await (db as any).select().from(auditEvents);
    const refused = rows.filter((r: any) => r.eventType === "budget.run_refused");
    expect(refused).toHaveLength(0);
  });
});
