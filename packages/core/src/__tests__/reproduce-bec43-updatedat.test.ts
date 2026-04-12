/**
 * Fix test for BEC-43:
 * upsertActiveWork now refreshes `updatedAt` on the conflict (update) path.
 *
 * Fix: the `onConflictDoUpdate` set clause in coordination.ts now includes
 * `updatedAt` using a driver-aware SQL literal — `(unixepoch())` for SQLite
 * and `now()` for Postgres — so the timestamp advances on every upsert.
 */
import { describe, it, expect, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { unlinkSync } from "node:fs";
import { createDb } from "../db/index.js";
import { upsertActiveWork, getActiveWork } from "../pm/coordination.js";

function tmpDbPath(): string {
  const id = randomBytes(8).toString("hex");
  return `/tmp/laf-bec43-test-${id}.sqlite`;
}

describe("BEC-43 reproduction: updatedAt not refreshed on upsert conflict", () => {
  const paths: string[] = [];

  async function makeDb() {
    const path = tmpDbPath();
    paths.push(path);
    return createDb({ driver: "sqlite", connectionString: path });
  }

  afterEach(() => {
    for (const p of paths) {
      try { unlinkSync(p); } catch { /* ignore */ }
      try { unlinkSync(p + "-wal"); } catch { /* ignore */ }
      try { unlinkSync(p + "-shm"); } catch { /* ignore */ }
    }
    paths.length = 0;
  });

  it("updatedAt advances after a conflict-path update (BEC-43 fix)", async () => {
    const db = await makeDb() as any;

    // First insert
    await upsertActiveWork(db, {
      runId: "run-bec43",
      issueId: "BEC-43",
      stage: "implement",
      filesModified: ["src/foo.ts"],
    });

    const [before] = await getActiveWork(db);
    const updatedAtBefore = before.updatedAt;

    // Wait long enough for the timestamp to differ (SQLite unixepoch() is
    // second-granularity, so we wait >1 s to guarantee a detectable change).
    await new Promise((r) => setTimeout(r, 1100));

    // Second upsert — conflict path (same runId)
    await upsertActiveWork(db, {
      runId: "run-bec43",
      issueId: "BEC-43",
      stage: "test",           // stage changes
      filesModified: ["src/foo.ts", "src/bar.ts"],
    });

    const [after] = await getActiveWork(db);

    // Verify stage was updated (this works)
    expect(after.stage).toBe("test");
    expect(after.filesModified).toHaveLength(2);

    // FIX: updatedAt should have advanced after the conflict-path update.
    const updatedAtAfter = after.updatedAt;

    console.log("updatedAt BEFORE second upsert:", updatedAtBefore);
    console.log("updatedAt AFTER  second upsert:", updatedAtAfter);
    console.log(
      "updatedAt changed?",
      String(updatedAtAfter) !== String(updatedAtBefore),
    );

    // The fix: updatedAt must advance to the current time on every upsert.
    expect(Number(updatedAtAfter)).toBeGreaterThan(Number(updatedAtBefore));
  });
});
