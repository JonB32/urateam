import { describe, it, expect } from "vitest";
import { evaluateBudget } from "../pm/budget.js";
import type { PmAgentConfig, BudgetTier, ScopeBudget } from "../pm/types.js";

/**
 * Mock DB that returns a preset array of grouped rows from a
 * select().from().where().groupBy() chain.
 */
interface MockRow {
  linearTeamId: string | null;
  repoUrl: string;
  totalTokens: number;
  activeCount: number;
}

function mockDb(rows: MockRow[]) {
  const chain: any = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    groupBy: () => Promise.resolve(rows),
  };
  return chain;
}

function baseConfig(overrides: Partial<PmAgentConfig> = {}): PmAgentConfig {
  return {
    enabled: true,
    dailyTokenBudget: 5_000_000,
    slackChannelId: "C_TEST",
    teamIds: ["team-a"],
    maxInFlight: 3,
    cronIntervalMs: 1_800_000,
    triageBatchSize: 3,
    stuckIssueRecovery: true,
    stuckIssueTargetState: "Backlog",
    stuckIssueMaxPerTick: 5,
    requirePipelineLabelForPromote: false,
        maxConsecutiveFailures: 3,
    ...overrides,
  };
}

describe("evaluateBudget", () => {
  it("returns ok for empty spend with default config", async () => {
    const db = mockDb([]);
    const result = await evaluateBudget({ db, config: baseConfig() });
    expect(result.worstTier).toBe("ok");
    expect(result.promoteBlocked).toBe(false);
    expect(result.scopes).toHaveLength(1);
    expect(result.scopes[0].scope.kind).toBe("global");
    expect(result.scopes[0].used).toBe(0);
    expect(result.scopes[0].percent).toBe(0);
    expect(result.activeCount).toBe(0);
  });

  it("computes global scope from rows", async () => {
    const db = mockDb([
      { linearTeamId: "team-a", repoUrl: "github.com/org/repo", totalTokens: 2_500_000, activeCount: 1 },
    ]);
    const result = await evaluateBudget({ db, config: baseConfig() });
    const global = result.scopes.find((s: ScopeBudget) => s.scope.kind === "global")!;
    expect(global.used).toBe(2_500_000);
    expect(global.percent).toBe(50);
    expect(global.tier).toBe("warn-50");
    expect(result.activeCount).toBe(1);
  });

  it("tier transitions: 0/50/80/100", async () => {
    const cases: Array<[number, BudgetTier]> = [
      [0, "ok"],
      [49, "ok"],
      [50, "warn-50"],
      [79, "warn-50"],
      [80, "warn-80"],
      [99, "warn-80"],
      [100, "blocked-100"],
      [150, "blocked-100"],
    ];
    for (const [percent, expected] of cases) {
      const used = (5_000_000 * percent) / 100;
      const db = mockDb([
        { linearTeamId: "team-a", repoUrl: "r", totalTokens: used, activeCount: 0 },
      ]);
      const result = await evaluateBudget({ db, config: baseConfig() });
      const global = result.scopes.find((s: ScopeBudget) => s.scope.kind === "global")!;
      expect({ percent, tier: global.tier }).toEqual({ percent, tier: expected });
    }
  });

  it("per-team scope uses perTeam override", async () => {
    const db = mockDb([
      { linearTeamId: "team-a", repoUrl: "r", totalTokens: 1_600_000, activeCount: 0 },
    ]);
    const result = await evaluateBudget({
      db,
      config: baseConfig({
        budgets: { perTeam: { "team-a": 2_000_000 } },
      }),
    });
    const teamScope = result.scopes.find(
      (s: ScopeBudget) => s.scope.kind === "team" && s.scope.teamId === "team-a",
    )!;
    expect(teamScope).toBeDefined();
    expect(teamScope.limit).toBe(2_000_000);
    expect(teamScope.percent).toBe(80);
    expect(teamScope.tier).toBe("warn-80");
  });

  it("per-team scope falls back to budgets.default when team not in perTeam", async () => {
    const db = mockDb([
      { linearTeamId: "team-z", repoUrl: "r", totalTokens: 500_000, activeCount: 0 },
    ]);
    const result = await evaluateBudget({
      db,
      config: baseConfig({
        budgets: {
          default: 1_000_000,
          perTeam: { "team-a": 500_000 },
        },
      }),
    });
    const teamScope = result.scopes.find(
      (s: ScopeBudget) => s.scope.kind === "team" && s.scope.teamId === "team-z",
    )!;
    expect(teamScope.limit).toBe(1_000_000);
    expect(teamScope.percent).toBe(50);
  });

  it("per-repo scope uses perRepo override", async () => {
    const db = mockDb([
      { linearTeamId: "team-a", repoUrl: "github.com/org/secret", totalTokens: 900_000, activeCount: 0 },
    ]);
    const result = await evaluateBudget({
      db,
      config: baseConfig({
        budgets: { perRepo: { "github.com/org/secret": 1_000_000 } },
      }),
    });
    const repoScope = result.scopes.find(
      (s: ScopeBudget) => s.scope.kind === "repo" && s.scope.repoUrl === "github.com/org/secret",
    )!;
    expect(repoScope.limit).toBe(1_000_000);
    expect(repoScope.percent).toBe(90);
    expect(repoScope.tier).toBe("warn-80");
  });

  it("both per-team and per-repo can apply — worstTier is the max", async () => {
    const db = mockDb([
      { linearTeamId: "team-a", repoUrl: "github.com/org/secret", totalTokens: 5_200_000, activeCount: 1 },
    ]);
    const result = await evaluateBudget({
      db,
      config: baseConfig({
        dailyTokenBudget: 20_000_000, // keep global well below 100% so only repo blocks
        budgets: {
          perTeam: { "team-a": 10_000_000 },      // 52% — warn-50
          perRepo: { "github.com/org/secret": 5_000_000 }, // 104% — blocked-100
        },
      }),
    });
    expect(result.worstTier).toBe("blocked-100");
    expect(result.promoteBlocked).toBe(true);
    expect(result.blockReason).toContain("github.com/org/secret");
  });

  it("legacy rows with NULL linearTeamId contribute to global only", async () => {
    const db = mockDb([
      { linearTeamId: null, repoUrl: "r1", totalTokens: 1_000_000, activeCount: 0 },
      { linearTeamId: "team-a", repoUrl: "r1", totalTokens: 500_000, activeCount: 0 },
    ]);
    const result = await evaluateBudget({
      db,
      config: baseConfig({ budgets: { perTeam: { "team-a": 2_000_000 } } }),
    });
    const global = result.scopes.find((s: ScopeBudget) => s.scope.kind === "global")!;
    expect(global.used).toBe(1_500_000);
    const teamScope = result.scopes.find(
      (s: ScopeBudget) => s.scope.kind === "team" && s.scope.teamId === "team-a",
    )!;
    expect(teamScope.used).toBe(500_000);
  });

  it("blocks when any scope is at 100%", async () => {
    const db = mockDb([
      { linearTeamId: "team-a", repoUrl: "r", totalTokens: 5_000_000, activeCount: 0 },
    ]);
    const result = await evaluateBudget({ db, config: baseConfig() });
    expect(result.promoteBlocked).toBe(true);
    expect(result.blockReason).toBeDefined();
    expect(result.blockReason).toContain("global");
  });
});
