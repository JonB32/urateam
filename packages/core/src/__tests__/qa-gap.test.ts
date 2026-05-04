import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { unlinkSync } from "node:fs";
import { eq, and, isNull } from "drizzle-orm";
import { createDb } from "../db/index.js";
import { qaGapIssues } from "../db/schema.js";
import { fileGapIssue } from "../qa/gap.js";

function tmpDbPath(): string {
  const id = randomBytes(8).toString("hex");
  return `/tmp/laf-qa-gap-fn-${id}.sqlite`;
}

describe("fileGapIssue", () => {
  const paths: string[] = [];
  let db: any;
  const repoUrl = "https://github.com/org/repo";
  const branch = "main";
  const workflowPath = ".github/workflows/smoke.yml";

  beforeEach(async () => {
    const path = tmpDbPath();
    paths.push(path);
    const created = await createDb({ driver: "sqlite", connectionString: path });
    db = created as any;
  });

  afterEach(() => {
    for (const p of paths) {
      try { unlinkSync(p); } catch {}
      try { unlinkSync(p + "-wal"); } catch {}
      try { unlinkSync(p + "-shm"); } catch {}
    }
    paths.length = 0;
  });

  function makeMockLinear(over: any = {}) {
    return {
      createIssue: vi.fn(async () => ({
        issue: Promise.resolve({ identifier: "BEC-150", url: "https://linear.app/beckerspace/issue/BEC-150" }),
      })),
      ...over,
    };
  }

  it("files a new issue when none exists, persists qa_gap_issues row", async () => {
    const linear = makeMockLinear();
    const result = await fileGapIssue({
      db,
      linear: linear as any,
      repoUrl,
      branch,
      workflowPath,
      linearTeamId: "team-uuid-123",
    });
    expect(result.kind).toBe("filed");
    expect(result.kind === "filed" && result.linearIssueId).toBe("BEC-150");
    expect(linear.createIssue).toHaveBeenCalledTimes(1);
    const rows = await db.select().from(qaGapIssues).where(
      and(eq(qaGapIssues.repoUrl, repoUrl), isNull(qaGapIssues.resolvedAt)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].linearIssueId).toBe("BEC-150");
  });

  it("is idempotent — second call with existing open row is a no-op", async () => {
    const linear = makeMockLinear();
    await fileGapIssue({ db, linear: linear as any, repoUrl, branch, workflowPath, linearTeamId: "team-uuid-123" });
    linear.createIssue.mockClear();

    const result = await fileGapIssue({ db, linear: linear as any, repoUrl, branch, workflowPath, linearTeamId: "team-uuid-123" });
    expect(result.kind).toBe("already_filed");
    expect(result.kind === "already_filed" && result.linearIssueId).toBe("BEC-150");
    expect(linear.createIssue).not.toHaveBeenCalled();
  });

  it("re-files when the previous row was resolved", async () => {
    const linear = makeMockLinear();
    await fileGapIssue({ db, linear: linear as any, repoUrl, branch, workflowPath, linearTeamId: "team-uuid-123" });

    // Resolve the existing row
    await db.update(qaGapIssues)
      .set({ resolvedAt: new Date() })
      .where(eq(qaGapIssues.linearIssueId, "BEC-150"));

    // Update the mock to return a new ID for the second filing
    linear.createIssue.mockResolvedValueOnce({
      issue: Promise.resolve({ identifier: "BEC-160", url: "https://linear.app/beckerspace/issue/BEC-160" }),
    });

    const result = await fileGapIssue({ db, linear: linear as any, repoUrl, branch, workflowPath, linearTeamId: "team-uuid-123" });
    expect(result.kind).toBe("filed");
    expect(result.kind === "filed" && result.linearIssueId).toBe("BEC-160");
    expect(linear.createIssue).toHaveBeenCalledTimes(2);
  });

  it("returns linear_error on Linear API failure", async () => {
    const linear = makeMockLinear({
      createIssue: vi.fn(async () => { throw new Error("Linear unauthorized"); }),
    });
    const result = await fileGapIssue({ db, linear: linear as any, repoUrl, branch, workflowPath, linearTeamId: "team-uuid-123" });
    expect(result.kind).toBe("linear_error");
    expect(result.kind === "linear_error" && result.message).toMatch(/unauthorized/);
  });
});
