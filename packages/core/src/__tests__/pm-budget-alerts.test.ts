import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema.js";
import { maybeFireAlerts } from "../pm/budget-alerts.js";
import { getCreateTablesDDL } from "../db/client.js";
import { _setSchemaDriver } from "../db/schema.js";
import type { BudgetEvaluation } from "../pm/types.js";

function makeDb() {
  _setSchemaDriver("sqlite");
  const sqlite = new Database(":memory:");
  sqlite.exec(getCreateTablesDDL("sqlite"));
  return drizzle(sqlite, { schema });
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

describe("maybeFireAlerts", () => {
  let db: ReturnType<typeof makeDb>;
  let postSlack: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    db = makeDb();
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
});
