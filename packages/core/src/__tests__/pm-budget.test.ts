import { describe, it, expect } from "vitest";
import { checkBudgetGuards } from "../pm/budget.js";

/**
 * Mock DB that simulates a Drizzle query builder chain.
 * budget.ts now uses Drizzle select().from().where() instead of raw SQL.
 */
function mockDb(rows: any[]) {
  const mapped = rows.length > 0 ? {
    totalIn: rows[0].totalIn ?? 0,
    totalOut: rows[0].totalOut ?? 0,
    activeCount: rows[0].activeCount ?? 0,
  } : { totalIn: 0, totalOut: 0, activeCount: 0 };

  const chain = {
    select: () => chain,
    from: () => chain,
    where: () => Promise.resolve([mapped]),
  };

  return chain as any;
}

describe("checkBudgetGuards", () => {
  it("returns promoteBlocked=false when under limits", async () => {
    const db = mockDb([{ totalIn: 100000, totalOut: 50000, activeCount: 1 }]);
    const result = await checkBudgetGuards({
      db,
      maxInFlight: 3,
      dailyTokenBudget: 5000000,
    });
    expect(result.promoteBlocked).toBe(false);
    expect(result.activeCount).toBe(1);
    expect(result.tokenSpendPercent).toBeLessThan(80);
  });

  it("blocks when activeCount >= maxInFlight", async () => {
    const db = mockDb([{ totalIn: 100000, totalOut: 50000, activeCount: 3 }]);
    const result = await checkBudgetGuards({
      db,
      maxInFlight: 3,
      dailyTokenBudget: 5000000,
    });
    expect(result.promoteBlocked).toBe(true);
    expect(result.reason).toContain("maxInFlight");
  });

  it("blocks when token spend >= 80%", async () => {
    const db = mockDb([{ totalIn: 3000000, totalOut: 1100000, activeCount: 1 }]);
    const result = await checkBudgetGuards({
      db,
      maxInFlight: 3,
      dailyTokenBudget: 5000000,
    });
    expect(result.promoteBlocked).toBe(true);
    expect(result.reason).toContain("token budget");
    expect(result.tokenSpendPercent).toBeGreaterThanOrEqual(80);
  });

  it("handles empty DB rows gracefully", async () => {
    const db = mockDb([]);
    const result = await checkBudgetGuards({
      db,
      maxInFlight: 3,
      dailyTokenBudget: 5000000,
    });
    expect(result.promoteBlocked).toBe(false);
    expect(result.activeCount).toBe(0);
    expect(result.dailyTokensUsed).toBe(0);
  });
});
