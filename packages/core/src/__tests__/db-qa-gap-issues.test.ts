import { describe, it, expect, afterEach } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { eq, isNull, and } from "drizzle-orm";
import { createDb } from "../db/index.js";
import { qaGapIssues, releaseDecisions } from "../db/schema.js";

function tmpDbPath(): string {
  const id = randomBytes(8).toString("hex");
  return `/tmp/laf-qa-gap-${id}.sqlite`;
}

describe("qa_gap_issues table", () => {
  const paths: string[] = [];

  async function makeDb() {
    const path = tmpDbPath();
    paths.push(path);
    const db = await createDb({ driver: "sqlite", connectionString: path });
    return { db: db as any };
  }

  afterEach(() => {
    for (const p of paths) {
      try { unlinkSync(p); } catch {}
      try { unlinkSync(p + "-wal"); } catch {}
      try { unlinkSync(p + "-shm"); } catch {}
    }
    paths.length = 0;
  });

  it("inserts and reads a qa_gap_issues row", async () => {
    const { db } = await makeDb();
    const id = `qg_${randomUUID()}`;
    await db.insert(qaGapIssues).values({
      id,
      repoUrl: "https://github.com/org/repo",
      branch: "main",
      workflowPath: ".github/workflows/smoke.yml",
      linearIssueId: "BEC-150",
    });
    const rows = await db.select().from(qaGapIssues).where(eq(qaGapIssues.id, id));
    expect(rows).toHaveLength(1);
    expect(rows[0].linearIssueId).toBe("BEC-150");
    expect(rows[0].resolvedAt).toBeNull();
  });

  it("partial UNIQUE prevents re-filing while resolved_at is null", async () => {
    const { db } = await makeDb();
    await db.insert(qaGapIssues).values({
      id: `qg_${randomUUID()}`,
      repoUrl: "https://github.com/org/repo",
      branch: "main",
      workflowPath: ".github/workflows/smoke.yml",
      linearIssueId: "BEC-150",
    });
    await expect(
      db.insert(qaGapIssues).values({
        id: `qg_${randomUUID()}`,
        repoUrl: "https://github.com/org/repo",
        branch: "main",
        workflowPath: ".github/workflows/smoke.yml",
        linearIssueId: "BEC-151",
      })
    ).rejects.toThrow();
  });

  it("allows re-filing after the previous issue is resolved", async () => {
    const { db } = await makeDb();
    const firstId = `qg_${randomUUID()}`;
    await db.insert(qaGapIssues).values({
      id: firstId,
      repoUrl: "https://github.com/org/repo",
      branch: "main",
      workflowPath: ".github/workflows/smoke.yml",
      linearIssueId: "BEC-150",
    });
    await db.update(qaGapIssues)
      .set({ resolvedAt: new Date() })
      .where(eq(qaGapIssues.id, firstId));
    // Second filing now succeeds
    await db.insert(qaGapIssues).values({
      id: `qg_${randomUUID()}`,
      repoUrl: "https://github.com/org/repo",
      branch: "main",
      workflowPath: ".github/workflows/smoke.yml",
      linearIssueId: "BEC-160",
    });
    const rows = await db.select().from(qaGapIssues).where(
      and(
        eq(qaGapIssues.repoUrl, "https://github.com/org/repo"),
        eq(qaGapIssues.workflowPath, ".github/workflows/smoke.yml"),
      ),
    );
    expect(rows).toHaveLength(2);
  });

  it("releaseDecisions has qaRunId and qaRunSha columns", async () => {
    const { db } = await makeDb();
    const id = `rd_${randomUUID()}`;
    await db.insert(releaseDecisions).values({
      id,
      repoUrl: "https://github.com/org/repo",
      branch: "main",
      decidedAt: new Date(),
      decision: "skip",
      reason: "qa_running",
      triggerStateJson: "{}",
      attemptCount: 0,
      qaRunId: 12345,
      qaRunSha: "abcdef0",
    });
    const rows = await db.select().from(releaseDecisions).where(eq(releaseDecisions.id, id));
    expect(rows).toHaveLength(1);
    expect(rows[0].qaRunId).toBe(12345);
    expect(rows[0].qaRunSha).toBe("abcdef0");
  });
});
