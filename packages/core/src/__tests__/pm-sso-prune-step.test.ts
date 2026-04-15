import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPmScheduler } from "../pm/scheduler.js";
import { createDb } from "../db/client.js";
import { dashboardSessions } from "../db/schema.js";
import { upsertUser } from "../auth/index.js";
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

describe("pm tick session prune sweep", () => {
  beforeEach(async () => {
    await installTestProLicense("enterprise");
  });

  afterEach(async () => {
    await restoreLicense();
  });

  it("deletes expired dashboard sessions and keeps live ones", async () => {
    const db = await createDb({ connectionString: ":memory:" });

    const userId = await upsertUser(db as any, {
      email: "u@example.com",
      name: "U",
      workosUserId: null,
    });

    await (db as any).insert(dashboardSessions).values([
      {
        id: "expired-session",
        userId,
        expiresAt: new Date(Date.now() - 60_000),
        lastSeenAt: new Date(Date.now() - 120_000),
      },
      {
        id: "live-session",
        userId,
        expiresAt: new Date(Date.now() + 3600_000),
        lastSeenAt: new Date(),
      },
    ]);

    const scheduler = createPmScheduler({
      config: baseConfig(),
      db: db as any,
      linearApiKey: "",
      slackBotToken: "",
      actions: stubActions() as any,
    });

    await scheduler.tick();

    const rows = await (db as any).select().from(dashboardSessions);
    const ids = rows.map((r: any) => r.id);
    expect(ids).not.toContain("expired-session");
    expect(ids).toContain("live-session");
  });

  it("tick does not throw when session prune fails", async () => {
    const db = await createDb({ connectionString: ":memory:" });

    // Break the dashboard_sessions table so pruneExpiredSessions throws.
    await (db as any).run?.("DROP TABLE dashboard_sessions");

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
