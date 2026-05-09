/**
 * BEC-161 — PM circuit breaker for repeated failures.
 *
 * countConsecutiveFailures(db, issueId) returns the number of failed pipeline
 * runs for the issue since the last successfully-completed run (or since first
 * run if none completed). Promote/start-todo use this to short-circuit
 * candidates that have failed N+ times in a row.
 *
 * batchCountConsecutiveFailures(db, issueIds) is the batch variant introduced
 * in BEC-181 to avoid the N+1 query pattern when checking multiple candidates
 * in the same scheduler tick.
 */
import { describe, it, expect, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { unlinkSync } from "node:fs";
import { createDb, pipelineRuns } from "../db/index.js";
import { countConsecutiveFailures, batchCountConsecutiveFailures } from "../pm/actions/db-queries.js";

function tmpDbPath(prefix = "laf-cb-test"): string {
  return `/tmp/${prefix}-${randomBytes(8).toString("hex")}.sqlite`;
}

function makeRun(id: string, issueId: string, status: string, startedAt: Date, completedAt?: Date) {
  return {
    id,
    issueId,
    issueTitle: `Issue ${issueId}`,
    pipelineKey: "default",
    repoUrl: "https://github.com/org/repo",
    status,
    startedAt,
    completedAt,
  };
}

describe("countConsecutiveFailures", () => {
  const paths: string[] = [];

  async function makeDb() {
    const path = tmpDbPath();
    paths.push(path);
    return createDb({ driver: "sqlite", connectionString: path });
  }

  afterEach(() => {
    for (const p of paths) {
      for (const suffix of ["", "-wal", "-shm"]) {
        try { unlinkSync(p + suffix); } catch { /* ignore */ }
      }
    }
    paths.length = 0;
  });

  it("returns 0 when issue has no runs", async () => {
    const db = await makeDb() as any;
    expect(await countConsecutiveFailures(db, "ISSUE-NEW")).toBe(0);
  });

  it("returns 3 when issue has 3 consecutive failures and no completed run", async () => {
    const db = await makeDb() as any;
    const t0 = new Date(Date.now() - 30 * 60_000);
    await db.insert(pipelineRuns).values([
      makeRun("r1", "ISSUE-A", "failed", new Date(t0.getTime() + 0),  new Date(t0.getTime() + 1_000)),
      makeRun("r2", "ISSUE-A", "failed", new Date(t0.getTime() + 5_000),  new Date(t0.getTime() + 6_000)),
      makeRun("r3", "ISSUE-A", "failed", new Date(t0.getTime() + 10_000), new Date(t0.getTime() + 11_000)),
    ]);
    expect(await countConsecutiveFailures(db, "ISSUE-A")).toBe(3);
  });

  it("resets counter after a completed run (returns failures since last completion)", async () => {
    const db = await makeDb() as any;
    const t0 = new Date(Date.now() - 30 * 60_000);
    await db.insert(pipelineRuns).values([
      makeRun("r1", "ISSUE-B", "failed",    new Date(t0.getTime() + 0),       new Date(t0.getTime() + 1_000)),
      makeRun("r2", "ISSUE-B", "failed",    new Date(t0.getTime() + 5_000),   new Date(t0.getTime() + 6_000)),
      makeRun("r3", "ISSUE-B", "failed",    new Date(t0.getTime() + 10_000),  new Date(t0.getTime() + 11_000)),
      makeRun("r4", "ISSUE-B", "completed", new Date(t0.getTime() + 15_000),  new Date(t0.getTime() + 16_000)),
      makeRun("r5", "ISSUE-B", "failed",    new Date(t0.getTime() + 20_000),  new Date(t0.getTime() + 21_000)),
    ]);
    expect(await countConsecutiveFailures(db, "ISSUE-B")).toBe(1);
  });

  it("returns 0 when most recent run is completed (no failures since)", async () => {
    const db = await makeDb() as any;
    const t0 = new Date(Date.now() - 30 * 60_000);
    await db.insert(pipelineRuns).values([
      makeRun("r1", "ISSUE-C", "failed",    new Date(t0.getTime() + 0),     new Date(t0.getTime() + 1_000)),
      makeRun("r2", "ISSUE-C", "completed", new Date(t0.getTime() + 5_000), new Date(t0.getTime() + 6_000)),
    ]);
    expect(await countConsecutiveFailures(db, "ISSUE-C")).toBe(0);
  });

  it("ignores runs for other issues", async () => {
    const db = await makeDb() as any;
    const t0 = new Date(Date.now() - 30 * 60_000);
    await db.insert(pipelineRuns).values([
      makeRun("r1", "ISSUE-D", "failed", new Date(t0.getTime() + 0),     new Date(t0.getTime() + 1_000)),
      makeRun("r2", "ISSUE-E", "failed", new Date(t0.getTime() + 5_000), new Date(t0.getTime() + 6_000)),
      makeRun("r3", "ISSUE-E", "failed", new Date(t0.getTime() + 10_000), new Date(t0.getTime() + 11_000)),
    ]);
    expect(await countConsecutiveFailures(db, "ISSUE-D")).toBe(1);
    expect(await countConsecutiveFailures(db, "ISSUE-E")).toBe(2);
  });

  it("does not count active (running/queued) runs", async () => {
    const db = await makeDb() as any;
    const t0 = new Date(Date.now() - 30 * 60_000);
    await db.insert(pipelineRuns).values([
      makeRun("r1", "ISSUE-F", "failed",  new Date(t0.getTime() + 0),     new Date(t0.getTime() + 1_000)),
      makeRun("r2", "ISSUE-F", "failed",  new Date(t0.getTime() + 5_000), new Date(t0.getTime() + 6_000)),
      makeRun("r3", "ISSUE-F", "running", new Date(t0.getTime() + 10_000)),
    ]);
    expect(await countConsecutiveFailures(db, "ISSUE-F")).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// batchCountConsecutiveFailures — BEC-181 batch variant
// ---------------------------------------------------------------------------

describe("batchCountConsecutiveFailures", () => {
  const paths: string[] = [];

  async function makeDb() {
    const path = tmpDbPath("laf-cb-batch-test");
    paths.push(path);
    return createDb({ driver: "sqlite", connectionString: path });
  }

  afterEach(() => {
    for (const p of paths) {
      for (const suffix of ["", "-wal", "-shm"]) {
        try { unlinkSync(p + suffix); } catch { /* ignore */ }
      }
    }
    paths.length = 0;
  });

  it("returns empty map for empty input", async () => {
    const db = await makeDb() as any;
    const result = await batchCountConsecutiveFailures(db, []);
    expect(result.size).toBe(0);
  });

  it("returns 0 for issues with no runs", async () => {
    const db = await makeDb() as any;
    const result = await batchCountConsecutiveFailures(db, ["ISSUE-NEW"]);
    expect(result.get("ISSUE-NEW")).toBe(0);
  });

  it("returns correct counts for multiple issues in one query", async () => {
    const db = await makeDb() as any;
    const t0 = new Date(Date.now() - 30 * 60_000);
    await db.insert(pipelineRuns).values([
      // ISSUE-X: 3 consecutive failures
      makeRun("r1", "ISSUE-X", "failed",    new Date(t0.getTime() + 0),       new Date(t0.getTime() + 1_000)),
      makeRun("r2", "ISSUE-X", "failed",    new Date(t0.getTime() + 5_000),   new Date(t0.getTime() + 6_000)),
      makeRun("r3", "ISSUE-X", "failed",    new Date(t0.getTime() + 10_000),  new Date(t0.getTime() + 11_000)),
      // ISSUE-Y: 1 failure after a completion
      makeRun("r4", "ISSUE-Y", "failed",    new Date(t0.getTime() + 0),       new Date(t0.getTime() + 1_000)),
      makeRun("r5", "ISSUE-Y", "completed", new Date(t0.getTime() + 5_000),   new Date(t0.getTime() + 6_000)),
      makeRun("r6", "ISSUE-Y", "failed",    new Date(t0.getTime() + 10_000),  new Date(t0.getTime() + 11_000)),
      // ISSUE-Z: most recent run is completed
      makeRun("r7", "ISSUE-Z", "failed",    new Date(t0.getTime() + 0),       new Date(t0.getTime() + 1_000)),
      makeRun("r8", "ISSUE-Z", "completed", new Date(t0.getTime() + 5_000),   new Date(t0.getTime() + 6_000)),
    ]);

    const result = await batchCountConsecutiveFailures(db, ["ISSUE-X", "ISSUE-Y", "ISSUE-Z"]);
    expect(result.get("ISSUE-X")).toBe(3);
    expect(result.get("ISSUE-Y")).toBe(1);
    expect(result.get("ISSUE-Z")).toBe(0);
  });

  it("matches countConsecutiveFailures for each issue individually", async () => {
    const db = await makeDb() as any;
    const t0 = new Date(Date.now() - 30 * 60_000);
    await db.insert(pipelineRuns).values([
      makeRun("r1", "ISSUE-A", "failed",    new Date(t0.getTime() + 0),       new Date(t0.getTime() + 1_000)),
      makeRun("r2", "ISSUE-A", "failed",    new Date(t0.getTime() + 5_000),   new Date(t0.getTime() + 6_000)),
      makeRun("r3", "ISSUE-B", "completed", new Date(t0.getTime() + 0),       new Date(t0.getTime() + 1_000)),
    ]);

    const batch = await batchCountConsecutiveFailures(db, ["ISSUE-A", "ISSUE-B"]);
    const singleA = await countConsecutiveFailures(db, "ISSUE-A");
    const singleB = await countConsecutiveFailures(db, "ISSUE-B");

    expect(batch.get("ISSUE-A")).toBe(singleA);
    expect(batch.get("ISSUE-B")).toBe(singleB);
  });
});
