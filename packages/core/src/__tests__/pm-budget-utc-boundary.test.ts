/**
 * UTC day-boundary integration tests for evaluateBudget (BEC-129).
 *
 * Uses a real SQLite in-memory DB (not a mock) to verify that the half-open
 * [dayStart, dayEnd) window stored as epoch-second integers behaves correctly at
 * the UTC midnight boundary.
 *
 * Postgres (TIMESTAMPTZ) is not covered here because there is no Postgres
 * instance in the CI environment. The crossTimestamp toDriver path for Postgres
 * produces ISO-8601 strings that TIMESTAMPTZ comparisons handle identically.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { evaluateBudget } from "../pm/budget.js";
import { createDb } from "../db/client.js";
import { pipelineRuns } from "../db/schema.js";
import type { AnyDb } from "../db/client.js";
import type { PmAgentConfig } from "../pm/types.js";

// Fixed UTC midnight used as the reference boundary for all tests.
// 2026-03-15T00:00:00.000Z is an exact epoch-second multiple (no sub-second remainder).
const UTC_MIDNIGHT = new Date("2026-03-15T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function baseConfig(overrides: Partial<PmAgentConfig> = {}): PmAgentConfig {
  return {
    enabled: true,
    dailyTokenBudget: 1_000_000,
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

let runSeq = 0;
async function seedRun(db: AnyDb, startedAt: Date, totalInputTokens: number): Promise<void> {
  const id = `run-${++runSeq}`;
  await db.insert(pipelineRuns).values({
    id,
    issueId: `issue-${id}`,
    issueTitle: `Boundary test run ${id}`,
    pipelineKey: "auto-implement",
    repoUrl: "github.com/org/repo",
    branch: `branch-${id}`,
    status: "completed",
    startedAt,
    totalInputTokens,
    totalOutputTokens: 0,
  });
}

function globalUsed(result: Awaited<ReturnType<typeof evaluateBudget>>): number {
  return result.scopes.find((s) => s.scope.kind === "global")!.used;
}

describe("evaluateBudget – UTC day boundary (SQLite real DB)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Default clock: noon UTC on 2026-03-15 — well within "today" for all tests
    vi.setSystemTime(new Date("2026-03-15T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("excludes a run starting 1 ms before UTC midnight (previous day)", async () => {
    const db = await createDb({ connectionString: ":memory:" });

    // 2026-03-14T23:59:59.999Z — stored as epoch_s - 1, which is < dayStart
    await seedRun(db, new Date(UTC_MIDNIGHT.getTime() - 1), 100_000);

    expect(globalUsed(await evaluateBudget({ db, config: baseConfig() }))).toBe(0);
  });

  it("includes a run starting exactly at UTC midnight (gte boundary)", async () => {
    const db = await createDb({ connectionString: ":memory:" });

    // 2026-03-15T00:00:00.000Z — stored as epoch_s, which equals dayStart
    await seedRun(db, UTC_MIDNIGHT, 100_000);

    expect(globalUsed(await evaluateBudget({ db, config: baseConfig() }))).toBe(100_000);
  });

  it("includes a run starting 1 ms after UTC midnight (first ms of current day)", async () => {
    const db = await createDb({ connectionString: ":memory:" });

    // 2026-03-15T00:00:00.001Z — Math.floor rounds to same epoch_s as midnight,
    // still satisfies gte(dayStart)
    await seedRun(db, new Date(UTC_MIDNIGHT.getTime() + 1), 75_000);

    expect(globalUsed(await evaluateBudget({ db, config: baseConfig() }))).toBe(75_000);
  });

  it("includes a run at the last ms of the day, excludes the first ms of the next day", async () => {
    const db = await createDb({ connectionString: ":memory:" });
    const dayEnd = new Date(UTC_MIDNIGHT.getTime() + DAY_MS);

    // 2026-03-15T23:59:59.999Z — epoch_s = dayEnd_s - 1 → lt(dayEnd_s) is TRUE
    await seedRun(db, new Date(dayEnd.getTime() - 1), 100_000);
    // 2026-03-16T00:00:00.000Z — epoch_s = dayEnd_s → lt(dayEnd_s) is FALSE
    await seedRun(db, dayEnd, 200_000);

    expect(globalUsed(await evaluateBudget({ db, config: baseConfig() }))).toBe(100_000);
  });

  it("correctly separates yesterday from today across the UTC midnight boundary", async () => {
    const db = await createDb({ connectionString: ":memory:" });

    await seedRun(db, new Date(UTC_MIDNIGHT.getTime() - 1), 50_000); // yesterday
    await seedRun(db, new Date(UTC_MIDNIGHT.getTime() + 1), 75_000); // today

    expect(globalUsed(await evaluateBudget({ db, config: baseConfig() }))).toBe(75_000);
  });

  it("uses UTC date when system clock is early morning UTC (TZ-independence guard)", async () => {
    // 2026-03-15T00:30:00Z is 30 minutes into the UTC day, but would be
    // 2026-03-14 in a UTC-8 timezone. evaluateBudget must use UTC ("2026-03-15").
    vi.setSystemTime(new Date("2026-03-15T00:30:00.000Z"));
    const db = await createDb({ connectionString: ":memory:" });

    // 2026-03-15T00:15:00Z — UTC today
    await seedRun(db, new Date("2026-03-15T00:15:00.000Z"), 80_000);
    // 2026-03-14T23:45:00Z — UTC yesterday
    await seedRun(db, new Date("2026-03-14T23:45:00.000Z"), 40_000);

    expect(globalUsed(await evaluateBudget({ db, config: baseConfig() }))).toBe(80_000);
  });

  it("returns promoteBlocked=true when today's runs exhaust the daily budget", async () => {
    const db = await createDb({ connectionString: ":memory:" });
    const config = baseConfig({ dailyTokenBudget: 100_000 });

    await seedRun(db, new Date(UTC_MIDNIGHT.getTime() + 1), 100_000);

    const result = await evaluateBudget({ db, config });
    expect(result.promoteBlocked).toBe(true);
    expect(result.worstTier).toBe("blocked-100");
  });

  it("returns promoteBlocked=false when only yesterday's runs are present", async () => {
    const db = await createDb({ connectionString: ":memory:" });
    const config = baseConfig({ dailyTokenBudget: 100_000 });

    // All runs are from yesterday — budget resets at UTC midnight
    await seedRun(db, new Date(UTC_MIDNIGHT.getTime() - 1_000), 100_000);

    const result = await evaluateBudget({ db, config });
    expect(result.promoteBlocked).toBe(false);
    expect(result.worstTier).toBe("ok");
  });
});
