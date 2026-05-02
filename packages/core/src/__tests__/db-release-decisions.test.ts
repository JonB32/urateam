import { describe, it, expect, afterEach } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { eq, and } from "drizzle-orm";
import { createDb } from "../db/index.js";
import { releaseDecisions, releaseApprovals } from "../db/schema.js";

function tmpDbPath(): string {
  const id = randomBytes(8).toString("hex");
  return `/tmp/laf-rm-test-${id}.sqlite`;
}

describe("release-manager DB tables", () => {
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

  it("inserts and reads a release_decisions row", async () => {
    const { db } = await makeDb();
    const id = `rd_${randomUUID()}`;
    await db.insert(releaseDecisions).values({
      id,
      repoUrl: "https://github.com/org/repo",
      branch: "main",
      decidedAt: new Date(),
      decision: "skip",
      reason: "timeSinceLastHours not met",
      triggerStateJson: JSON.stringify({ mergedPRs: 3 }),
      attemptCount: 0,
    });
    const rows = await db.select().from(releaseDecisions).where(eq(releaseDecisions.id, id));
    expect(rows).toHaveLength(1);
    expect(rows[0].decision).toBe("skip");
    expect(rows[0].reason).toBe("timeSinceLastHours not met");
  });

  it("enforces UNIQUE(repo_url, branch, approved_by) WHERE consumed_at IS NULL — second pending approve from same user fails", async () => {
    const { db } = await makeDb();
    await db.insert(releaseApprovals).values({
      id: `ra_${randomUUID()}`,
      repoUrl: "https://github.com/org/repo",
      branch: "main",
      approvedAt: new Date(),
      approvedBy: "U123",
    });
    await expect(
      db.insert(releaseApprovals).values({
        id: `ra_${randomUUID()}`,
        repoUrl: "https://github.com/org/repo",
        branch: "main",
        approvedAt: new Date(),
        approvedBy: "U123",
      })
    ).rejects.toThrow();
  });

  it("allows a second approve from the same user once the first is consumed", async () => {
    const { db } = await makeDb();
    const firstId = `ra_${randomUUID()}`;
    await db.insert(releaseApprovals).values({
      id: firstId,
      repoUrl: "https://github.com/org/repo",
      branch: "main",
      approvedAt: new Date(),
      approvedBy: "U123",
    });
    await db.update(releaseApprovals)
      .set({ consumedAt: new Date(), consumedByDecisionId: "rd_consumed" })
      .where(eq(releaseApprovals.id, firstId));
    // Second approve should now succeed
    await db.insert(releaseApprovals).values({
      id: `ra_${randomUUID()}`,
      repoUrl: "https://github.com/org/repo",
      branch: "main",
      approvedAt: new Date(),
      approvedBy: "U123",
    });
    const rows = await db
      .select()
      .from(releaseApprovals)
      .where(
        and(
          eq(releaseApprovals.repoUrl, "https://github.com/org/repo"),
          eq(releaseApprovals.approvedBy, "U123"),
        ),
      );
    expect(rows).toHaveLength(2);
  });
});
