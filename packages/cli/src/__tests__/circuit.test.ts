import { describe, it, expect, beforeEach } from "vitest";
import { createDb, pipelineRuns, circuitBreakerState, type AnyDb } from "@urateam/core";
import { runCircuitList } from "../commands/circuit.js";

describe("ura circuit list", () => {
  let db: AnyDb;
  let logs: string[];
  let log: (msg: string) => void;
  beforeEach(async () => {
    db = await createDb({ connectionString: ":memory:" });
    logs = [];
    log = (m: string) => logs.push(m);
  });

  it("prints a friendly message when no issues are circuit-broken", async () => {
    await runCircuitList({ db, log, maxConsecutiveFailures: 3 });
    expect(logs.some((l) => l.toLowerCase().includes("no circuit-broken issues"))).toBe(true);
  });

  it("lists issues with ≥ threshold failures, joined to state when present", async () => {
    for (let i = 0; i < 3; i++) {
      await db.insert(pipelineRuns).values({
        id: `BEC-1-r${i}`,
        issueId: "BEC-1",
        issueTitle: "test",
        pipelineKey: "auto-implement",
        repoUrl: "https://example.com/r.git",
        status: "failed",
        startedAt: new Date(1_000_000_000 + i * 1000),
      });
    }
    await db.insert(circuitBreakerState).values({
      issueId: "BEC-1",
      escalatedAt: new Date(1_000_000_000),
      probeAttempts: 1,
    });

    await runCircuitList({ db, log, maxConsecutiveFailures: 3 });
    const out = logs.join("\n");
    expect(out).toContain("BEC-1");
    expect(out).toContain("3"); // failures column
  });

  it("lists broken issues without a state row too (pre-deploy bootstrap case)", async () => {
    for (let i = 0; i < 3; i++) {
      await db.insert(pipelineRuns).values({
        id: `BEC-2-r${i}`,
        issueId: "BEC-2",
        issueTitle: "test",
        pipelineKey: "auto-implement",
        repoUrl: "https://example.com/r.git",
        status: "failed",
        startedAt: new Date(1_000_000_000 + i * 1000),
      });
    }
    // No circuit_breaker_state row — mimics pre-deploy bootstrap

    await runCircuitList({ db, log, maxConsecutiveFailures: 3 });
    const out = logs.join("\n");
    expect(out).toContain("BEC-2");
  });
});
