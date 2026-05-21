/**
 * BEC-146 Regression Test
 *
 * Verifies that the QA retry counter resets correctly after a successful dispatch.
 *
 * Original bug: MAX(attemptCount) returned the old high-water mark even after a
 * successful dispatch wrote attemptCount=0, causing the next failure to falsely
 * escalate to a permanent skip.
 *
 * Fix mechanism (this version): `clearFailureRowsForSha` is called from the
 * `release-tick` dispatch_pending / ok branches BEFORE persisting the reset row.
 * That removes prior failure rows so MAX(attemptCount) naturally returns 0.
 *
 * (An earlier attempted fix used ORDER BY decidedAt DESC LIMIT 1 in the helper,
 * but `crossTimestamp` stores SQLite epoch at SECOND resolution — rapid consecutive
 * ticks tied on decidedAt and the LIMIT 1 query returned a non-deterministic row.)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { unlinkSync } from "node:fs";
import { createDb } from "../db/index.js";
import { releaseDecisions } from "../db/schema.js";
import {
  getMaxAttemptCountForReason,
  clearFailureRowsForSha,
} from "../release-manager/release-helpers.js";

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

  it("clearFailureRowsForSha removes prior failure rows so MAX(attemptCount) returns 0 after reset", async () => {
    // Seed the DB to represent the scenario:
    //   Tick 1: dispatch_error → qa_needs_trigger, attemptCount=1, qaRunId=null
    //   Tick 2: dispatch_error → qa_needs_trigger, attemptCount=2, qaRunId=null
    // At tick 3 (dispatch_pending or ok), release-tick.ts calls
    // clearFailureRowsForSha BEFORE persisting the reset row.
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
    ]);

    // Before clear: MAX returns the high-water mark.
    expect(await getMaxAttemptCountForReason(db, repoUrl, branch, "qa_needs_trigger", SHA1)).toBe(2);

    // Simulate tick 3 (dispatch_pending): clear prior failure rows for this SHA.
    await clearFailureRowsForSha(db, repoUrl, branch, "qa_needs_trigger", SHA1);

    // After clear + reset row write, MAX returns 0 (only the reset row remains).
    await db.insert(releaseDecisions).values({
      id: "rd_reset",
      repoUrl,
      branch,
      decidedAt: new Date(Date.now() - 1000),
      decision: "skip",
      reason: "qa_needs_trigger",
      triggerStateJson: "{}",
      qaRunSha: SHA1,
      qaRunId: null, // dispatch_pending — HTTP succeeded but runId not yet visible
      attemptCount: 0,
    });

    const maxCount = await getMaxAttemptCountForReason(db, repoUrl, branch, "qa_needs_trigger", SHA1);
    expect(maxCount).toBe(0);
  });

  it("clearFailureRowsForSha does NOT delete rows with qaRunId set (success rows are preserved)", async () => {
    // Seed a row that represents a SUCCESSFUL dispatch (qaRunId IS NOT NULL).
    // state.ts uses these rows for the latest-QA-run snapshot; they must survive.
    await db.insert(releaseDecisions).values({
      id: "rd_success",
      repoUrl,
      branch,
      decidedAt: new Date(),
      decision: "skip",
      reason: "qa_needs_trigger",
      triggerStateJson: "{}",
      qaRunSha: SHA1,
      qaRunId: 12345,
      attemptCount: 0,
    });

    await clearFailureRowsForSha(db, repoUrl, branch, "qa_needs_trigger", SHA1);

    const rows = await db.select().from(releaseDecisions);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe("rd_success");
  });

  it("subsequent dispatch failure after reset starts attemptCount=1, not 3, no false permanent skip", async () => {
    // Seed: 2 failures, then clear (simulating tick 3 dispatch_pending), then write the reset row.
    await db.insert(releaseDecisions).values([
      { id: "rd_fail1", repoUrl, branch, decidedAt: new Date(Date.now() - 3000), decision: "skip",
        reason: "qa_needs_trigger", triggerStateJson: "{}", qaRunSha: SHA1, qaRunId: null, attemptCount: 1 },
      { id: "rd_fail2", repoUrl, branch, decidedAt: new Date(Date.now() - 2000), decision: "skip",
        reason: "qa_needs_trigger", triggerStateJson: "{}", qaRunSha: SHA1, qaRunId: null, attemptCount: 2 },
    ]);
    await clearFailureRowsForSha(db, repoUrl, branch, "qa_needs_trigger", SHA1);
    await db.insert(releaseDecisions).values({
      id: "rd_reset", repoUrl, branch, decidedAt: new Date(Date.now() - 1000), decision: "skip",
      reason: "qa_needs_trigger", triggerStateJson: "{}", qaRunSha: SHA1, qaRunId: null, attemptCount: 0,
    });

    // Simulate tick 4: dispatch fails again. release-tick computes
    // newAttemptCount = getMaxAttemptCountForReason(...) + 1.
    const prevMax = await getMaxAttemptCountForReason(db, repoUrl, branch, "qa_needs_trigger", SHA1);
    const newAttemptCount = prevMax + 1;

    const MAX_QA_RETRY_ATTEMPTS = 3;
    const wouldBePermanentSkip = newAttemptCount >= MAX_QA_RETRY_ATTEMPTS;

    expect(prevMax).toBe(0);
    expect(newAttemptCount).toBe(1);
    expect(wouldBePermanentSkip).toBe(false);
  });
});
