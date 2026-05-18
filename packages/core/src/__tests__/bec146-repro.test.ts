/**
 * BEC-146 Regression Test
 *
 * Verifies that `getMaxAttemptCountForReason` correctly returns the attempt count
 * from the most-recent row (ORDER BY decidedAt DESC LIMIT 1) rather than the
 * historical maximum (MAX(attemptCount)) across all rows.
 *
 * Before the fix: MAX(attemptCount) returned the old high-water mark even after
 * a successful dispatch wrote attemptCount=0, causing the next failure to falsely
 * escalate to a permanent skip.
 *
 * After the fix: the function reads the most-recent row's attemptCount, so a
 * successful dispatch (attemptCount=0) correctly resets the counter for
 * subsequent failure rows.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { unlinkSync } from "node:fs";
import { createDb } from "../db/index.js";
import { releaseDecisions } from "../db/schema.js";
import { getMaxAttemptCountForReason } from "../release-manager/release-helpers.js";

function tmpDbPath(): string {
  const id = randomBytes(8).toString("hex");
  return `/tmp/bec146-repro-${id}.sqlite`;
}

describe("BEC-146 — retry counter resets to 0 on successful dispatch (regression)", () => {
  const paths: string[] = [];
  let db: any;
  const repoUrl = "https://github.com/org/repo";
  const branch = "main";
  const SHA1 = "head_sha_x";

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

  it("getMaxAttemptCountForReason returns 0 after a successful dispatch wrote attemptCount=0 (most-recent row wins)", async () => {
    // Seed the DB to represent the scenario:
    //   Tick 1: dispatch_error → qa_needs_trigger, attemptCount=1
    //   Tick 2: dispatch_error → qa_needs_trigger, attemptCount=2
    //   Tick 3: dispatch ok   → qa_needs_trigger, qaRunId=88888, attemptCount=0 (reset)
    await db.insert(releaseDecisions).values([
      {
        id: "rd_fail1",
        repoUrl,
        branch,
        decidedAt: new Date(Date.now() - 3000),
        decision: "skip",
        reason: "qa_needs_trigger",
        triggerStateJson: "{}",
        qaRunSha: SHA1,
        qaRunId: null,
        attemptCount: 1,
      },
      {
        id: "rd_fail2",
        repoUrl,
        branch,
        decidedAt: new Date(Date.now() - 2000),
        decision: "skip",
        reason: "qa_needs_trigger",
        triggerStateJson: "{}",
        qaRunSha: SHA1,
        qaRunId: null,
        attemptCount: 2,
      },
      {
        // Successful dispatch: qaRunId IS set, attemptCount reset to 0
        id: "rd_success",
        repoUrl,
        branch,
        decidedAt: new Date(Date.now() - 1000),
        decision: "skip",
        reason: "qa_needs_trigger",
        triggerStateJson: "{}",
        qaRunSha: SHA1,
        qaRunId: 88888,
        attemptCount: 0,
      },
    ]);

    // Fix: ORDER BY decidedAt DESC LIMIT 1 returns the most recent row (attemptCount=0).
    // Before fix: MAX(1, 2, 0) = 2 — caused false escalation.
    const maxCount = await getMaxAttemptCountForReason(db, repoUrl, branch, "qa_needs_trigger", SHA1);
    expect(maxCount).toBe(0);
  });

  it("subsequent dispatch failure after success gets attemptCount=1 (not 3), no false permanent skip", async () => {
    // Seed rows 1-3: 2 failures, 1 success (same SHA)
    await db.insert(releaseDecisions).values([
      {
        id: "rd_fail1",
        repoUrl,
        branch,
        decidedAt: new Date(Date.now() - 3000),
        decision: "skip",
        reason: "qa_needs_trigger",
        triggerStateJson: "{}",
        qaRunSha: SHA1,
        qaRunId: null,
        attemptCount: 1,
      },
      {
        id: "rd_fail2",
        repoUrl,
        branch,
        decidedAt: new Date(Date.now() - 2000),
        decision: "skip",
        reason: "qa_needs_trigger",
        triggerStateJson: "{}",
        qaRunSha: SHA1,
        qaRunId: null,
        attemptCount: 2,
      },
      {
        id: "rd_success",
        repoUrl,
        branch,
        decidedAt: new Date(Date.now() - 1000),
        decision: "skip",
        reason: "qa_needs_trigger",
        triggerStateJson: "{}",
        qaRunSha: SHA1,
        qaRunId: 88888,
        attemptCount: 0,
      },
    ]);

    // Simulate tick 4: dispatch fails again.
    // Fix: most-recent row has attemptCount=0, so the new failure starts from 1.
    // Before fix: MAX=2, then +1 = 3 → false permanent skip!
    const prevMax = await getMaxAttemptCountForReason(db, repoUrl, branch, "qa_needs_trigger", SHA1);
    const newAttemptCount = prevMax + 1;

    const MAX_QA_RETRY_ATTEMPTS = 3;
    const wouldBePermanentSkip = newAttemptCount >= MAX_QA_RETRY_ATTEMPTS;

    expect(prevMax).toBe(0);
    expect(newAttemptCount).toBe(1);
    expect(wouldBePermanentSkip).toBe(false);
  });
});
