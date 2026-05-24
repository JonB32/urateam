import { describe, it, expect, afterEach } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { and, eq, isNotNull, desc } from "drizzle-orm";
import { createDb } from "../db/index.js";
import { releaseDecisions } from "../db/schema.js";

function tmpDbPath(): string {
  const id = randomBytes(8).toString("hex");
  return join(tmpdir(), `bec145-qarun-test-${id}.sqlite`);
}

describe("BEC-145: QA run query optimization (isNotNull + limit(1))", () => {
  const paths: string[] = [];

  async function makeDb() {
    const path = tmpDbPath();
    paths.push(path);
    const db = await createDb({ driver: "sqlite", connectionString: path });
    return { db: db as any };
  }

  afterEach(() => {
    for (const p of paths) {
      try { unlinkSync(p); } catch { /* ignore */ }
      try { unlinkSync(p + "-wal"); } catch { /* ignore */ }
      try { unlinkSync(p + "-shm"); } catch { /* ignore */ }
    }
  });

  it("returns latest qaRun when multiple rows exist with non-null qa_run_id", async () => {
    const { db } = await makeDb();
    const repoUrl = "https://github.com/org/repo";
    const branch = "main";

    // Insert multiple decisions with various qa_run_id values
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 3600 * 1000);
    const twoHoursAgo = new Date(now.getTime() - 7200 * 1000);

    // Row 1: oldest, with qa_run_id = 100
    await db.insert(releaseDecisions).values({
      id: `rd_${randomUUID()}`,
      repoUrl,
      branch,
      decidedAt: twoHoursAgo,
      decision: "skip",
      reason: "test",
      triggerStateJson: "{}",
      qaRunId: 100,
      qaRunSha: "abc123",
    });

    // Row 2: middle, NO qa_run_id (null)
    await db.insert(releaseDecisions).values({
      id: `rd_${randomUUID()}`,
      repoUrl,
      branch,
      decidedAt: oneHourAgo,
      decision: "skip",
      reason: "test",
      triggerStateJson: "{}",
      // qaRunId: undefined (not set)
    });

    // Row 3: newest, with qa_run_id = 200
    await db.insert(releaseDecisions).values({
      id: `rd_${randomUUID()}`,
      repoUrl,
      branch,
      decidedAt: now,
      decision: "skip",
      reason: "test",
      triggerStateJson: "{}",
      qaRunId: 200,
      qaRunSha: "def456",
    });

    // Query using the optimized approach: isNotNull() + limit(1)
    const latestQaRows = await db
      .select({
        qaRunId: releaseDecisions.qaRunId,
        qaRunSha: releaseDecisions.qaRunSha,
        decidedAt: releaseDecisions.decidedAt,
      })
      .from(releaseDecisions)
      .where(
        and(
          eq(releaseDecisions.repoUrl, repoUrl),
          eq(releaseDecisions.branch, branch),
          isNotNull(releaseDecisions.qaRunId),
        ),
      )
      .orderBy(desc(releaseDecisions.decidedAt))
      .limit(1);

    // Should return only the latest row with non-null qaRunId (row 3)
    expect(latestQaRows).toHaveLength(1);
    expect(latestQaRows[0].qaRunId).toBe(200);
    expect(latestQaRows[0].qaRunSha).toBe("def456");
  });

  it("returns null when no rows have non-null qa_run_id", async () => {
    const { db } = await makeDb();
    const repoUrl = "https://github.com/org/repo";
    const branch = "main";

    // Insert rows, all with null qa_run_id
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 3600 * 1000);

    await db.insert(releaseDecisions).values({
      id: `rd_${randomUUID()}`,
      repoUrl,
      branch,
      decidedAt: oneHourAgo,
      decision: "skip",
      reason: "test",
      triggerStateJson: "{}",
      // qaRunId: undefined
    });

    await db.insert(releaseDecisions).values({
      id: `rd_${randomUUID()}`,
      repoUrl,
      branch,
      decidedAt: now,
      decision: "skip",
      reason: "test",
      triggerStateJson: "{}",
      // qaRunId: undefined
    });

    // Query
    const latestQaRows = await db
      .select({
        qaRunId: releaseDecisions.qaRunId,
        qaRunSha: releaseDecisions.qaRunSha,
        decidedAt: releaseDecisions.decidedAt,
      })
      .from(releaseDecisions)
      .where(
        and(
          eq(releaseDecisions.repoUrl, repoUrl),
          eq(releaseDecisions.branch, branch),
          isNotNull(releaseDecisions.qaRunId),
        ),
      )
      .orderBy(desc(releaseDecisions.decidedAt))
      .limit(1);

    // Should return empty array when no non-null qaRunId rows exist
    expect(latestQaRows).toHaveLength(0);
  });

  it("respects repo/branch filtering in the query", async () => {
    const { db } = await makeDb();
    const repoUrl1 = "https://github.com/org/repo1";
    const repoUrl2 = "https://github.com/org/repo2";
    const branch1 = "main";
    const branch2 = "develop";

    const now = new Date();

    // Insert row for repo1/branch1 with qaRunId
    await db.insert(releaseDecisions).values({
      id: `rd_${randomUUID()}`,
      repoUrl: repoUrl1,
      branch: branch1,
      decidedAt: now,
      decision: "skip",
      reason: "test",
      triggerStateJson: "{}",
      qaRunId: 100,
      qaRunSha: "repo1-main",
    });

    // Insert row for repo2/branch2 with different qaRunId
    await db.insert(releaseDecisions).values({
      id: `rd_${randomUUID()}`,
      repoUrl: repoUrl2,
      branch: branch2,
      decidedAt: now,
      decision: "skip",
      reason: "test",
      triggerStateJson: "{}",
      qaRunId: 200,
      qaRunSha: "repo2-develop",
    });

    // Query for repo1/branch1
    const repo1Branch1 = await db
      .select({
        qaRunId: releaseDecisions.qaRunId,
        qaRunSha: releaseDecisions.qaRunSha,
      })
      .from(releaseDecisions)
      .where(
        and(
          eq(releaseDecisions.repoUrl, repoUrl1),
          eq(releaseDecisions.branch, branch1),
          isNotNull(releaseDecisions.qaRunId),
        ),
      )
      .orderBy(desc(releaseDecisions.decidedAt))
      .limit(1);

    // Query for repo2/branch2
    const repo2Branch2 = await db
      .select({
        qaRunId: releaseDecisions.qaRunId,
        qaRunSha: releaseDecisions.qaRunSha,
      })
      .from(releaseDecisions)
      .where(
        and(
          eq(releaseDecisions.repoUrl, repoUrl2),
          eq(releaseDecisions.branch, branch2),
          isNotNull(releaseDecisions.qaRunId),
        ),
      )
      .orderBy(desc(releaseDecisions.decidedAt))
      .limit(1);

    // Should isolate results by repo/branch
    expect(repo1Branch1).toHaveLength(1);
    expect(repo1Branch1[0].qaRunSha).toBe("repo1-main");

    expect(repo2Branch2).toHaveLength(1);
    expect(repo2Branch2[0].qaRunSha).toBe("repo2-develop");
  });

  it("handles timestamp ordering correctly (DESC by decidedAt)", async () => {
    const { db } = await makeDb();
    const repoUrl = "https://github.com/org/repo";
    const branch = "main";

    const now = new Date();
    const baseTime = new Date(now.getTime() - 24 * 3600 * 1000); // 24 hours ago

    // Insert rows in random order with different timestamps
    const timestamps = [0, 5, 2, 8, 1].map(h => new Date(baseTime.getTime() + h * 3600 * 1000));
    const qaRunIds = [100, 200, 300, 400, 500];

    for (let i = 0; i < 5; i++) {
      await db.insert(releaseDecisions).values({
        id: `rd_${randomUUID()}`,
        repoUrl,
        branch,
        decidedAt: timestamps[i],
        decision: "skip",
        reason: "test",
        triggerStateJson: "{}",
        qaRunId: qaRunIds[i],
        qaRunSha: `sha-${qaRunIds[i]}`,
      });
    }

    // Query should return the row with the most recent decidedAt
    const latest = await db
      .select({
        qaRunId: releaseDecisions.qaRunId,
        qaRunSha: releaseDecisions.qaRunSha,
        decidedAt: releaseDecisions.decidedAt,
      })
      .from(releaseDecisions)
      .where(
        and(
          eq(releaseDecisions.repoUrl, repoUrl),
          eq(releaseDecisions.branch, branch),
          isNotNull(releaseDecisions.qaRunId),
        ),
      )
      .orderBy(desc(releaseDecisions.decidedAt))
      .limit(1);

    expect(latest).toHaveLength(1);
    // Should be the one with 8-hour offset (most recent)
    expect(latest[0].qaRunId).toBe(400);
    expect(latest[0].qaRunSha).toBe("sha-400");
  });
});
