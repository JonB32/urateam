/**
 * BEC-146 Reproduction Test
 *
 * Proves that the QA dispatch retry counter resets to 0 on successful dispatch
 * within the current SHA cycle is BROKEN:
 * `getMaxAttemptCountForReason` uses MAX(attemptCount) over ALL qa_needs_trigger
 * rows for the current SHA, including those from BEFORE a successful dispatch.
 * A subsequent dispatch failure within the same SHA cycle therefore reads the
 * old MAX and immediately escalates to a permanent skip.
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

describe("BEC-146 — retry counter resets to 0 on successful dispatch (REPRODUCTION)", () => {
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

  it("BEC-146 UNIT BUG: getMaxAttemptCountForReason returns old MAX (2) after a successful dispatch wrote attemptCount=0", async () => {
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

    // Now simulate a new dispatch attempt for the same SHA.
    // The expected behavior: getMaxAttemptCountForReason should return 0
    // (using only rows AFTER the last successful dispatch).
    // The actual (buggy) behavior: returns MAX(1, 2, 0) = 2.
    const maxCount = await getMaxAttemptCountForReason(db, repoUrl, branch, "qa_needs_trigger", SHA1);

    // EXPECTED after fix: 0 (from the reset on successful dispatch)
    // ACTUAL (bug): 2 (from the pre-success failure rows)
    //
    // This assertion FAILS with the current code, proving the bug:
    expect(maxCount).toBe(0); // BUG: actual is 2
  });

  it("BEC-146 UNIT BUG: subsequent dispatch failure gets wrong attemptCount (3 not 1), causing false permanent skip", async () => {
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
    // The NEW failure should start counting from 0 (post-success reset).
    // Bug: reads MAX=2, then +1 = 3 → permanent skip!
    const prevMax = await getMaxAttemptCountForReason(db, repoUrl, branch, "qa_needs_trigger", SHA1);
    const newAttemptCount = prevMax + 1;

    const MAX_QA_RETRY_ATTEMPTS = 3;
    const wouldBePermanentSkip = newAttemptCount >= MAX_QA_RETRY_ATTEMPTS;

    console.log(`BEC-146 bug: prevMax=${prevMax}, newAttemptCount=${newAttemptCount}, permanentSkip=${wouldBePermanentSkip}`);

    // EXPECTED: prevMax=0, newAttemptCount=1, no permanent skip
    // ACTUAL (bug): prevMax=2, newAttemptCount=3, false permanent skip!
    expect(prevMax).toBe(0);           // FAILS: actual is 2
    expect(newAttemptCount).toBe(1);   // FAILS: actual is 3
    expect(wouldBePermanentSkip).toBe(false); // FAILS: actual is true (false permanent skip!)
  });
});
