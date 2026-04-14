import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPmScheduler } from "../pm/scheduler.js";
import { createDb } from "../db/client.js";
import { auditEvents } from "../db/schema.js";
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

describe("pm tick audit retention sweep", () => {
  beforeEach(async () => {
    await installTestProLicense("enterprise");
  });

  afterEach(async () => {
    await restoreLicense();
  });

  it("deletes audit_events older than retentionDays", async () => {
    const db = await createDb({ connectionString: ":memory:" });

    const oldTs = new Date(Date.now() - 400 * 86400000);
    const freshTs = new Date();
    await (db as any).insert(auditEvents).values([
      {
        id: "old",
        timestamp: oldTs,
        eventType: "pm.issue_promoted",
        actor: "pm-agent",
        actorType: "pm-agent",
        payload: "{}",
      },
      {
        id: "fresh",
        timestamp: freshTs,
        eventType: "pm.issue_promoted",
        actor: "pm-agent",
        actorType: "pm-agent",
        payload: "{}",
      },
    ]);

    const scheduler = createPmScheduler({
      config: baseConfig({ auditLog: { retentionDays: 365 } }),
      db: db as any,
      linearApiKey: "",
      slackBotToken: "",
      actions: stubActions() as any,
    });

    await scheduler.tick();

    const rows = await (db as any).select().from(auditEvents);
    const ids = rows.map((r: any) => r.id);
    expect(ids).not.toContain("old");
    expect(ids).toContain("fresh");
  });

  it("uses default retention (365d) when config.auditLog is unset", async () => {
    const db = await createDb({ connectionString: ":memory:" });

    await (db as any).insert(auditEvents).values([
      {
        id: "ancient",
        timestamp: new Date(Date.now() - 400 * 86400000),
        eventType: "pm.issue_promoted",
        actor: "pm-agent",
        actorType: "pm-agent",
        payload: "{}",
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

    const rows = await (db as any).select().from(auditEvents);
    expect(rows.find((r: any) => r.id === "ancient")).toBeUndefined();
  });

  it("tick does not throw when retention sweep fails", async () => {
    const db = await createDb({ connectionString: ":memory:" });

    // Break the audit_events table so pruneAuditLog throws.
    await (db as any).run?.("DROP TABLE audit_events");

    const scheduler = createPmScheduler({
      config: baseConfig({ auditLog: { retentionDays: 30 } }),
      db: db as any,
      linearApiKey: "",
      slackBotToken: "",
      actions: stubActions() as any,
    });

    await expect(scheduler.tick()).resolves.toBeUndefined();
  });
});
