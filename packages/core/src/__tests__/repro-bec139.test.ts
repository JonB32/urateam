/**
 * BEC-139 Reproduction Tests
 *
 * Demonstrates the two gaps that BEC-139 must fix:
 *
 * 1. No retry: when `createRelease` fails after the tag was created, the
 *    current code immediately writes `decision="skip", reason="release_create_failed"`
 *    and emits `releasePartialEvent`. No `fire-pending` row is written, so
 *    subsequent ticks cannot retry the release-creation step.
 *
 * 2. Spurious manualTagDetected: `state.ts` `manualTagDetected` only considers
 *    `decision="fire"` rows. If a `fire-pending` row exists with the orphaned tag,
 *    the scheduler will misread it as a human-created tag on the next tick and skip
 *    with reason="manual_tag_detected" instead of retrying.
 *
 * All tests are EXPECTED TO FAIL until BEC-139 is implemented.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { unlinkSync } from "node:fs";
import { and, eq, desc } from "drizzle-orm";
import { createDb } from "../db/index.js";
import { releaseDecisions } from "../db/schema.js";
import { createReleaseManagerScheduler } from "../release-manager/scheduler.js";
import { _resetLicenseCache } from "../license.js";
import { ReleaseManagerConfigSchema } from "../release-manager/types.js";
import { collectState } from "../release-manager/state.js";

function tmpDbPath(): string {
  const id = randomBytes(8).toString("hex");
  return `/tmp/bec139-repro-${id}.sqlite`;
}

/** Base octokit mock: 2 commits ahead of v1.0.0, CI green, createRef OK, createRelease OK. */
function makeMockOctokit(over: any = {}) {
  return {
    repos: {
      getBranch: vi.fn(async () => ({ data: { commit: { sha: "head_sha_abc" } } })),
      listTags: vi.fn(async () => ({
        data: [{ name: "v1.0.0", commit: { sha: "old_sha" } }],
      })),
      getCommit: vi.fn(async () => ({
        data: { commit: { committer: { date: "2026-04-01T12:00:00Z" } } },
      })),
      compareCommits: vi.fn(async () => ({
        data: {
          commits: [
            { commit: { message: "fix: alpha" } },
            { commit: { message: "fix: beta" } },
          ],
        },
      })),
      listCommits: vi.fn(async () => ({ data: [] })),
      createRelease: vi.fn(async () => ({
        data: { html_url: "https://github.com/org/repo/releases/tag/v1.0.1" },
      })),
    },
    git: {
      createRef: vi.fn(async () => ({ data: {} })),
      getRef: vi.fn(async () => ({ data: { object: { sha: "head_sha_abc" } } })),
    },
    checks: {
      listForRef: vi.fn(async () => ({
        data: {
          check_runs: [
            { status: "completed", conclusion: "success", completed_at: "2026-05-01T11:00:00Z" },
          ],
        },
      })),
    },
    ...over,
  } as any;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared setup / teardown
// ─────────────────────────────────────────────────────────────────────────────

describe("BEC-139 reproduction", () => {
  const paths: string[] = [];
  let db: any;
  const repoUrl = "https://github.com/org/repo";
  const branch = "main";

  const baseConfig = ReleaseManagerConfigSchema.parse({
    enabled: true,
    triggers: { mergedPRsSince: 1 },
  });

  beforeEach(async () => {
    delete process.env.URATEAM_LICENSE_KEY;
    _resetLicenseCache();
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
    _resetLicenseCache();
  });

  // ─── Bug 1: No retry — release_create_failed immediately skips ─────────────

  it(
    "BUG 1a: release_create_failed writes skip immediately instead of fire-pending",
    async () => {
      // Arrange: createRef succeeds (tag created in GitHub), createRelease throws.
      const releaseError = new Error("GitHub 500 — createRelease failed");
      const octokit = makeMockOctokit({
        repos: {
          getBranch: vi.fn(async () => ({ data: { commit: { sha: "head_sha_abc" } } })),
          listTags: vi.fn(async () => ({
            data: [{ name: "v1.0.0", commit: { sha: "old_sha" } }],
          })),
          getCommit: vi.fn(async () => ({
            data: { commit: { committer: { date: "2026-04-01T12:00:00Z" } } },
          })),
          compareCommits: vi.fn(async () => ({
            data: {
              commits: [
                { commit: { message: "fix: alpha" } },
                { commit: { message: "fix: beta" } },
              ],
            },
          })),
          listCommits: vi.fn(async () => ({ data: [] })),
          createRelease: vi.fn(async () => { throw releaseError; }),
        },
        git: {
          createRef: vi.fn(async () => ({ data: {} })), // tag created OK
          getRef: vi.fn(async () => ({ data: { object: { sha: "head_sha_abc" } } })),
        },
        checks: {
          listForRef: vi.fn(async () => ({
            data: {
              check_runs: [
                { status: "completed", conclusion: "success", completed_at: "2026-05-01T11:00:00Z" },
              ],
            },
          })),
        },
      });

      const sched = createReleaseManagerScheduler({
        config: baseConfig,
        db,
        octokit,
        repoUrl,
        isLicensed: () => true,
        slack: undefined,
      });

      // Act: run tick 1 (createRelease will fail)
      await sched.tick();

      const rows = await db.select().from(releaseDecisions);
      expect(rows).toHaveLength(1);

      // CURRENT (buggy) behavior: writes skip immediately
      // EXPECTED v2 behavior: should write fire-pending so retry is possible
      expect(rows[0].decision).toBe("skip");
      expect(rows[0].reason).toBe("release_create_failed");

      // The following expectation FAILS today — it demonstrates the feature gap.
      // After BEC-139, this line should pass with decision="fire-pending".
      expect(rows[0].decision, "BEC-139: should write fire-pending, not skip immediately").toBe("fire-pending");
    },
  );

  it(
    "BUG 1b: after release_create_failed, second tick does NOT retry createRelease",
    async () => {
      // Arrange: tick 1 — tag created, release fails
      let callCount = 0;
      const octokit = makeMockOctokit({
        repos: {
          getBranch: vi.fn(async () => ({ data: { commit: { sha: "head_sha_abc" } } })),
          listTags: vi.fn(async () => ({
            // Tick 2: the tag v1.0.1 now exists (created by tick 1)
            data: [{ name: "v1.0.1", commit: { sha: "head_sha_abc" } }],
          })),
          getCommit: vi.fn(async () => ({
            data: { commit: { committer: { date: "2026-04-01T12:00:00Z" } } },
          })),
          compareCommits: vi.fn(async () => ({
            data: { commits: [{ commit: { message: "fix: a" } }, { commit: { message: "fix: b" } }] },
          })),
          listCommits: vi.fn(async () => ({ data: [] })),
          createRelease: vi.fn(async () => {
            callCount++;
            if (callCount === 1) throw new Error("createRelease failure tick 1");
            return { data: { html_url: "https://github.com/org/repo/releases/tag/v1.0.1" } };
          }),
        },
        git: {
          createRef: vi.fn(async () => ({ data: {} })),
          getRef: vi.fn(async () => ({ data: { object: { sha: "head_sha_abc" } } })),
        },
        checks: {
          listForRef: vi.fn(async () => ({
            data: {
              check_runs: [
                { status: "completed", conclusion: "success", completed_at: "2026-05-01T11:00:00Z" },
              ],
            },
          })),
        },
      });

      const sched = createReleaseManagerScheduler({
        config: baseConfig,
        db,
        octokit,
        repoUrl,
        isLicensed: () => true,
        slack: undefined,
      });

      // Act: tick 1 — sets up the failed state
      await sched.tick();

      // Act: tick 2 — should retry createRelease only (no createRef), succeed, write "fire"
      await sched.tick();

      const rows = await db
        .select()
        .from(releaseDecisions)
        .orderBy(desc(releaseDecisions.decidedAt));

      // EXPECTED v2 behavior after BEC-139:
      // - tick 2 should have called createRelease (retry) and written a "fire" row
      // - createRef should NOT have been called on tick 2 (tag already exists)
      const fireRow = rows.find((r: any) => r.decision === "fire");
      expect(
        fireRow,
        "BEC-139: tick 2 should succeed with decision=fire after retrying createRelease",
      ).toBeDefined();

      // Also assert createRelease was called twice total (once per tick)
      expect(octokit.repos.createRelease).toHaveBeenCalledTimes(2);
    },
  );

  // ─── Bug 2: manualTagDetected spuriously fires for fire-pending tags ────────

  it(
    "BUG 2: fire-pending tag spuriously triggers manualTagDetected in state.ts",
    async () => {
      // Seed a fire-pending row: the release manager created tag v1.0.1 but
      // createRelease failed.  The LAST "fire" row has firedTag=v1.0.0.
      await db.insert(releaseDecisions).values({
        id: "rd_fire_old",
        repoUrl,
        branch,
        decidedAt: new Date(Date.now() - 2 * 86_400_000),
        decision: "fire",
        reason: "all triggers passed",
        triggerStateJson: "{}",
        firedTag: "v1.0.0",
        firedSha: "old_sha",
        attemptCount: 0,
      });
      await db.insert(releaseDecisions).values({
        id: "rd_fire_pending",
        repoUrl,
        branch,
        decidedAt: new Date(Date.now() - 3600_000),
        decision: "fire-pending",
        reason: "release_create_failed",
        triggerStateJson: "{}",
        firedTag: "v1.0.1",
        firedSha: "head_sha_abc",
        attemptCount: 1,
      });

      // GitHub now has the tag v1.0.1 (the orphaned tag from the failed tick)
      const octokit = makeMockOctokit({
        repos: {
          getBranch: vi.fn(async () => ({ data: { commit: { sha: "head_sha_abc" } } })),
          listTags: vi.fn(async () => ({
            data: [{ name: "v1.0.1", commit: { sha: "head_sha_abc" } }],
          })),
          getCommit: vi.fn(async () => ({
            data: { commit: { committer: { date: "2026-04-02T12:00:00Z" } } },
          })),
          compareCommits: vi.fn(async () => ({ data: { commits: [] } })),
          listCommits: vi.fn(async () => ({ data: [] })),
          createRelease: vi.fn(async () => ({
            data: { html_url: "https://github.com/org/repo/releases/tag/v1.0.1" },
          })),
        },
        git: {
          createRef: vi.fn(async () => ({ data: {} })),
          getRef: vi.fn(async () => ({ data: { object: { sha: "head_sha_abc" } } })),
        },
        checks: {
          listForRef: vi.fn(async () => ({
            data: {
              check_runs: [
                { status: "completed", conclusion: "success", completed_at: "2026-05-01T11:00:00Z" },
              ],
            },
          })),
        },
      });

      // Directly call collectState to inspect what manualTagDetected returns
      const { AnyDb } = await import("../db/client.js").catch(() => ({ AnyDb: null }));
      const state = await collectState({
        octokit,
        db,
        repoUrl,
        branch,
        approvalTtlMs: 24 * 3600 * 1000,
      });

      // CURRENT (buggy) behavior:
      // - lastFiredTag from "fire" rows = "v1.0.0"
      // - lastTag from GitHub = "v1.0.1"
      // - v1.0.0 !== v1.0.1 → manualTagDetected = true (WRONG)
      //
      // EXPECTED v2 behavior after BEC-139:
      // - state.ts should also check fire-pending rows
      // - lastFiredTag should include "v1.0.1" from the fire-pending row
      // - v1.0.1 === v1.0.1 → manualTagDetected = false (correct)
      expect(
        state.manualTagDetected,
        "BEC-139: fire-pending tag v1.0.1 should NOT trigger manualTagDetected — we created that tag",
      ).toBe(false);
    },
  );

  it(
    "BUG 2b: scheduler skips with manual_tag_detected when fire-pending tag is present",
    async () => {
      // Same setup as Bug 2 but through the full scheduler.tick() path.
      await db.insert(releaseDecisions).values({
        id: "rd_fire_old",
        repoUrl,
        branch,
        decidedAt: new Date(Date.now() - 2 * 86_400_000),
        decision: "fire",
        reason: "all triggers passed",
        triggerStateJson: "{}",
        firedTag: "v1.0.0",
        firedSha: "old_sha",
        attemptCount: 0,
      });
      // Simulate: tick N wrote fire-pending (v2 path, once BEC-139 is partially done)
      await db.insert(releaseDecisions).values({
        id: "rd_fire_pending",
        repoUrl,
        branch,
        decidedAt: new Date(Date.now() - 3600_000),
        decision: "fire-pending",
        reason: "release_create_failed",
        triggerStateJson: "{}",
        firedTag: "v1.0.1",
        firedSha: "head_sha_abc",
        attemptCount: 1,
      });

      const octokit = makeMockOctokit({
        repos: {
          getBranch: vi.fn(async () => ({ data: { commit: { sha: "head_sha_abc" } } })),
          listTags: vi.fn(async () => ({
            // GitHub now reports v1.0.1 — the orphaned tag
            data: [{ name: "v1.0.1", commit: { sha: "head_sha_abc" } }],
          })),
          getCommit: vi.fn(async () => ({
            data: { commit: { committer: { date: "2026-04-02T12:00:00Z" } } },
          })),
          compareCommits: vi.fn(async () => ({ data: { commits: [] } })),
          listCommits: vi.fn(async () => ({ data: [] })),
          createRelease: vi.fn(async () => ({
            data: { html_url: "https://github.com/org/repo/releases/tag/v1.0.1" },
          })),
        },
        git: {
          createRef: vi.fn(async () => ({ data: {} })),
          getRef: vi.fn(async () => ({ data: { object: { sha: "head_sha_abc" } } })),
        },
        checks: {
          listForRef: vi.fn(async () => ({
            data: {
              check_runs: [
                { status: "completed", conclusion: "success", completed_at: "2026-05-01T11:00:00Z" },
              ],
            },
          })),
        },
      });

      const sched = createReleaseManagerScheduler({
        config: baseConfig,
        db,
        octokit,
        repoUrl,
        isLicensed: () => true,
        slack: undefined,
      });

      await sched.tick();

      const newRows = await db
        .select()
        .from(releaseDecisions)
        .orderBy(desc(releaseDecisions.decidedAt));
      // Most recently written row (inserted by this tick)
      const latestNew = newRows.find(
        (r: any) => r.id !== "rd_fire_old" && r.id !== "rd_fire_pending",
      );

      // CURRENT (buggy) behavior: scheduler writes manual_tag_detected instead of retrying
      // EXPECTED v2 behavior: scheduler should retry createRelease and write fire
      expect(
        latestNew?.reason,
        "BEC-139: tick should retry the pending release, not skip with manual_tag_detected",
      ).not.toBe("manual_tag_detected");
    },
  );
});
