/**
 * Budget-alert dedup tests — BEC-130
 *
 * The same behavioural suite runs against both SQLite (always) and Postgres
 * (when TEST_POSTGRES_URL is set). The critical invariant tested explicitly:
 *
 *   onConflictDoNothing().returning() returns an empty array on a UNIQUE
 *   conflict for BOTH drivers. budget-alerts.ts relies on `result.length > 0`
 *   meaning "newly inserted (fire alert)" vs 0 meaning "duplicate (skip)".
 *
 * Run against Postgres:
 *   TEST_POSTGRES_URL=postgres://user:pass@localhost:5432/testdb \
 *     npx vitest run src/__tests__/pm-budget-alerts.test.ts
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import { nanoid } from "nanoid";
import * as schema from "../db/schema.js";
import { budgetAlerts, _setSchemaDriver } from "../db/schema.js";
import { maybeFireAlerts } from "../pm/budget-alerts.js";
import { createDb, getCreateTablesDDL } from "../db/index.js";
import type { BudgetEvaluation } from "../pm/types.js";

const TEST_URL = process.env.TEST_POSTGRES_URL;

// ---- Shared fixture builders ------------------------------------------------

function makeSqliteDb() {
  _setSchemaDriver("sqlite");
  const sqlite = new Database(":memory:");
  sqlite.exec(getCreateTablesDDL("sqlite"));
  return drizzleSqlite(sqlite, { schema });
}

function scopeAt(kind: "global" | "team" | "repo", id: string, percent: number) {
  return {
    scope:
      kind === "global"
        ? { kind: "global" as const }
        : kind === "team"
          ? { kind: "team" as const, teamId: id }
          : { kind: "repo" as const, repoUrl: id },
    scopeLabel: kind === "global" ? "global" : `${kind} ${id}`,
    limit: 1_000_000,
    used: Math.floor(1_000_000 * (percent / 100)),
    percent,
    tier:
      percent >= 100
        ? ("blocked-100" as const)
        : percent >= 80
          ? ("warn-80" as const)
          : percent >= 50
            ? ("warn-50" as const)
            : ("ok" as const),
  };
}

function evaluationWith(scopes: ReturnType<typeof scopeAt>[]): BudgetEvaluation {
  const tierRank = { ok: 0, "warn-50": 1, "warn-80": 2, "blocked-100": 3 } as const;
  let worst: keyof typeof tierRank = "ok";
  for (const s of scopes) {
    if (tierRank[s.tier] > tierRank[worst]) worst = s.tier;
  }
  return {
    scopes,
    worstTier: worst,
    promoteBlocked: worst === "blocked-100",
    activeCount: 0,
  };
}

// ---- Parameterised test suite -----------------------------------------------
//
// `makeDb` is called in beforeEach. For SQLite it returns a fresh in-memory DB;
// for Postgres it clears the shared table and returns the same connection.

function runBudgetAlertSuite(makeDb: () => Promise<any> | any) {
  let db: any;
  let postSlack: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    db = await makeDb();
    postSlack = vi.fn().mockResolvedValue(undefined);
  });

  it("skips scopes at tier ok", async () => {
    const evaluation = evaluationWith([scopeAt("global", "", 10)]);
    await maybeFireAlerts(evaluation, db, postSlack, "C_TEST");
    expect(postSlack).not.toHaveBeenCalled();
  });

  it("fires a message at 50%", async () => {
    const evaluation = evaluationWith([scopeAt("global", "", 55)]);
    await maybeFireAlerts(evaluation, db, postSlack, "C_TEST");
    expect(postSlack).toHaveBeenCalledTimes(1);
    const [channel, blocks] = postSlack.mock.calls[0];
    expect(channel).toBe("C_TEST");
    const json = JSON.stringify(blocks);
    expect(json).toContain("global");
    expect(json).toContain("55");
  });

  it("fires 50 and 80 when a scope is at 80%", async () => {
    const evaluation = evaluationWith([scopeAt("team", "team-a", 82)]);
    await maybeFireAlerts(evaluation, db, postSlack, "C_TEST");
    expect(postSlack).toHaveBeenCalledTimes(2);
  });

  it("fires 50, 80, and 100 when a scope is blocked", async () => {
    const evaluation = evaluationWith([scopeAt("repo", "r", 105)]);
    await maybeFireAlerts(evaluation, db, postSlack, "C_TEST");
    expect(postSlack).toHaveBeenCalledTimes(3);
    const joined = postSlack.mock.calls.map((c) => JSON.stringify(c[1])).join("\n");
    expect(joined).toContain("blocked");
  });

  it("dedup: same threshold same day fires exactly once", async () => {
    const evaluation = evaluationWith([scopeAt("global", "", 60)]);
    await maybeFireAlerts(evaluation, db, postSlack, "C_TEST");
    await maybeFireAlerts(evaluation, db, postSlack, "C_TEST");
    expect(postSlack).toHaveBeenCalledTimes(1);
  });

  it("dedup: different scopes same threshold fire separately", async () => {
    const evaluation = evaluationWith([
      scopeAt("team", "team-a", 60),
      scopeAt("team", "team-b", 60),
    ]);
    await maybeFireAlerts(evaluation, db, postSlack, "C_TEST");
    expect(postSlack).toHaveBeenCalledTimes(2);
  });

  it("dedup: threshold escalation from 50 to 80 fires only the new one on second call", async () => {
    const first = evaluationWith([scopeAt("global", "", 55)]);
    await maybeFireAlerts(first, db, postSlack, "C_TEST");
    expect(postSlack).toHaveBeenCalledTimes(1);

    const second = evaluationWith([scopeAt("global", "", 85)]);
    await maybeFireAlerts(second, db, postSlack, "C_TEST");
    expect(postSlack).toHaveBeenCalledTimes(2);
  });

  it("compensating delete: a failed Slack post leaves no dedup row, so next call retries", async () => {
    const evaluation = evaluationWith([scopeAt("global", "", 55)]);

    // First call: postSlack throws, row should be rolled back
    const failingPost = vi
      .fn<typeof postSlack>()
      .mockRejectedValueOnce(new Error("slack is down"));
    await maybeFireAlerts(evaluation, db, failingPost, "C_TEST");
    expect(failingPost).toHaveBeenCalledTimes(1);

    // Second call with a working post: should re-fire because the row was rolled back
    await maybeFireAlerts(evaluation, db, postSlack, "C_TEST");
    expect(postSlack).toHaveBeenCalledTimes(1);
  });

  it("DB insert failure is swallowed and does NOT call Slack", async () => {
    const evaluation = evaluationWith([scopeAt("global", "", 55)]);

    // Construct a db whose .insert() throws
    const brokenDb = {
      insert: () => {
        throw new Error("db is down");
      },
    } as unknown as typeof db;

    await maybeFireAlerts(evaluation, brokenDb, postSlack, "C_TEST");
    expect(postSlack).not.toHaveBeenCalled();
  });

  // BEC-130: explicit low-level test documenting the exact Drizzle behaviour
  // that tryInsertAlert() relies on.  Both SQLite and Postgres return an empty
  // array when a conflict is suppressed by onConflictDoNothing() — the result
  // is NOT the existing row (contrary to some documentation). This test pins
  // that contract so a Drizzle upgrade that changes the behaviour is caught.
  it("onConflictDoNothing().returning() returns [] on conflict — both drivers agree", async () => {
    const today = new Date().toISOString().slice(0, 10);
    // Use a unique scope so parallel test runs don't collide on Postgres.
    const scopeKey = `bec130-test:${nanoid(8)}`;

    const first = await db
      .insert(budgetAlerts)
      .values({ id: nanoid(), date: today, scope: scopeKey, threshold: 50 })
      .onConflictDoNothing()
      .returning({ id: budgetAlerts.id });
    // Fresh insert: row was actually written → returns the new id.
    expect((first as Array<{ id: string }>).length).toBe(1);

    const second = await db
      .insert(budgetAlerts)
      .values({ id: nanoid(), date: today, scope: scopeKey, threshold: 50 })
      .onConflictDoNothing()
      .returning({ id: budgetAlerts.id });
    // Duplicate: conflict suppressed by DO NOTHING → empty result, NOT the existing row.
    // budget-alerts.ts interprets length === 0 as "already fired today — skip".
    expect((second as Array<{ id: string }>).length).toBe(0);
  });
}

// ---- SQLite suite (always runs) --------------------------------------------

describe("maybeFireAlerts — SQLite", () => {
  runBudgetAlertSuite(makeSqliteDb);
});

// ---- Postgres suite (runs when TEST_POSTGRES_URL is set) -------------------

describe.skipIf(!TEST_URL)("maybeFireAlerts — Postgres (BEC-130)", () => {
  let pgDb: any;

  beforeAll(async () => {
    // createDb() calls _setSchemaDriver("postgres") and runs DDL + migrations.
    pgDb = await createDb({ connectionString: TEST_URL! });
  });

  afterAll(async () => {
    // Best-effort cleanup; Vitest exits the worker on completion.
    try { if (pgDb) await pgDb.delete(budgetAlerts); } catch { /* ignore */ }
  });

  runBudgetAlertSuite(async () => {
    // Truncate budget_alerts before each test so every test sees a clean slate,
    // matching the in-memory SQLite behaviour (fresh DB per test).
    await pgDb.delete(budgetAlerts);
    return pgDb;
  });
});
