import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { unlinkSync } from "node:fs";
import { eq } from "drizzle-orm";
import { createDb } from "../db/index.js";
import { releaseDecisions, releaseApprovals } from "../db/schema.js";
import { createReleaseManagerScheduler } from "../release-manager/scheduler.js";
import { _resetLicenseCache } from "../license.js";
import { ReleaseManagerConfigSchema } from "../release-manager/types.js";

function tmpDbPath(): string {
  const id = randomBytes(8).toString("hex");
  return `/tmp/laf-rm-sched-${id}.sqlite`;
}

function makeMockOctokit(over: any = {}) {
  return {
    repos: {
      getBranch: vi.fn(async () => ({ data: { commit: { sha: "head_sha" } } })),
      listTags: vi.fn(async () => ({ data: [{ name: "v1.0.0", commit: { sha: "old_sha" } }] })),
      getCommit: vi.fn(async () => ({ data: { commit: { committer: { date: "2026-04-01T12:00:00Z" } } } })),
      compareCommits: vi.fn(async () => ({
        data: { commits: [{ commit: { message: "fix: a" } }, { commit: { message: "fix: b" } }] },
      })),
      listCommits: vi.fn(async () => ({ data: [] })),
      createRelease: vi.fn(async () => ({ data: { html_url: "https://github.com/org/repo/releases/tag/v1.0.1" } })),
    },
    git: {
      createRef: vi.fn(async () => ({ data: {} })),
    },
    checks: {
      listForRef: vi.fn(async () => ({
        data: { check_runs: [{ status: "completed", conclusion: "success", completed_at: "2026-05-01T11:00:00Z" }] },
      })),
    },
    ...over,
  } as any;
}

describe("createReleaseManagerScheduler — single tick", () => {
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
    // Use a stub license bypass: tests inject `licensed: () => true`.
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

  it("license-not-licensed → silent skip and writes nothing", async () => {
    const octokit = makeMockOctokit();
    const sched = createReleaseManagerScheduler({
      config: baseConfig,
      db,
      octokit,
      repoUrl,
      isLicensed: () => false,
      slack: undefined,
    });
    await sched.tick();
    const rows = await db.select().from(releaseDecisions);
    expect(rows).toHaveLength(0);
    expect(octokit.git.createRef).not.toHaveBeenCalled();
  });

  it("happy path: fires when triggers met, creates tag, writes fire row", async () => {
    const octokit = makeMockOctokit();
    const sched = createReleaseManagerScheduler({
      config: baseConfig,
      db,
      octokit,
      repoUrl,
      isLicensed: () => true,
      slack: undefined,
    });
    await sched.tick();
    expect(octokit.git.createRef).toHaveBeenCalled();
    expect(octokit.repos.createRelease).toHaveBeenCalledWith(
      expect.objectContaining({ generate_release_notes: true }),
    );
    const rows = await db.select().from(releaseDecisions);
    expect(rows).toHaveLength(1);
    expect(rows[0].decision).toBe("fire");
    expect(rows[0].firedTag).toMatch(/^v1\.0\.1$/);
  });

  it("skip path: writes skip row when triggers fail", async () => {
    const cfg = ReleaseManagerConfigSchema.parse({
      enabled: true,
      triggers: { mergedPRsSince: 100 }, // way above 2
    });
    const octokit = makeMockOctokit();
    const sched = createReleaseManagerScheduler({
      config: cfg, db, octokit, repoUrl, isLicensed: () => true, slack: undefined,
    });
    await sched.tick();
    const rows = await db.select().from(releaseDecisions);
    expect(rows).toHaveLength(1);
    expect(rows[0].decision).toBe("skip");
    expect(rows[0].reason).toMatch(/mergedPRsSince not met/);
    expect(octokit.git.createRef).not.toHaveBeenCalled();
  });

  it("awaiting-approval path: requireSlackApproval=true with no fresh approval → awaiting-approval row, Slack prompt, no tag", async () => {
    const cfg = ReleaseManagerConfigSchema.parse({
      enabled: true,
      triggers: { mergedPRsSince: 1, requireSlackApproval: true },
      slackChannel: "#releases",
    });
    const octokit = makeMockOctokit();
    const slackMock = { postMessage: vi.fn(async () => true) };
    const sched = createReleaseManagerScheduler({
      config: cfg, db, octokit, repoUrl, isLicensed: () => true, slack: slackMock,
    });
    await sched.tick();
    const rows = await db.select().from(releaseDecisions);
    expect(rows).toHaveLength(1);
    expect(rows[0].decision).toBe("awaiting-approval");
    expect(rows[0].reason).toBe("no_fresh_approval");
    expect(rows[0].proposedVersion).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(octokit.git.createRef).not.toHaveBeenCalled();
    // Slack prompt always posts (transition to awaiting-approval bypasses the dedup window).
    expect(slackMock.postMessage).toHaveBeenCalledTimes(1);
    expect((slackMock.postMessage as any).mock.calls[0][1]).toMatch(/Release ready/i);
  });

  it("awaiting-approval → fire: pre-seed an approval, confirm next tick fires and consumes the approval", async () => {
    const cfg = ReleaseManagerConfigSchema.parse({
      enabled: true,
      triggers: { mergedPRsSince: 1, requireSlackApproval: true },
      slackChannel: "#releases",
    });
    await db.insert(releaseApprovals).values({
      id: "ra_pre",
      repoUrl,
      branch,
      approvedAt: new Date(),
      approvedBy: "U_pre",
    });
    const octokit = makeMockOctokit();
    const slackMock = { postMessage: vi.fn(async () => true) };
    const sched = createReleaseManagerScheduler({
      config: cfg, db, octokit, repoUrl, isLicensed: () => true, slack: slackMock,
    });
    await sched.tick();
    const rows = await db.select().from(releaseDecisions);
    expect(rows).toHaveLength(1);
    expect(rows[0].decision).toBe("fire");
    const approval = await db.select().from(releaseApprovals).where(eq(releaseApprovals.id, "ra_pre"));
    expect(approval[0].consumedAt).not.toBeNull();
    expect(approval[0].consumedByDecisionId).toBe(rows[0].id);
  });

  it("manual-tag detection: latest GH tag differs from last fired tag → skip with reason=manual_tag_detected", async () => {
    // Seed a previous fire with tag v0.5.0 — but GH says latest is v1.0.0 (mismatch).
    await db.insert(releaseDecisions).values({
      id: "rd_prev",
      repoUrl,
      branch,
      decidedAt: new Date(Date.now() - 86_400_000),
      decision: "fire",
      reason: "all triggers passed",
      triggerStateJson: "{}",
      firedTag: "v0.5.0",
      firedSha: "sha_old",
      attemptCount: 0,
    });
    const octokit = makeMockOctokit(); // listTags returns v1.0.0
    const sched = createReleaseManagerScheduler({
      config: baseConfig, db, octokit, repoUrl, isLicensed: () => true, slack: undefined,
    });
    await sched.tick();
    const rows = await db.select().from(releaseDecisions).where(eq(releaseDecisions.decision, "skip"));
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const last = rows[rows.length - 1];
    expect(last.reason).toBe("manual_tag_detected");
    expect(octokit.git.createRef).not.toHaveBeenCalled();
  });

  it("tag-exists path: github returns 422 → skip with reason=tag_exists", async () => {
    const octokit = makeMockOctokit({
      git: {
        createRef: vi.fn(async () => {
          const err: any = new Error("Reference already exists");
          err.status = 422;
          throw err;
        }),
      },
    });
    const sched = createReleaseManagerScheduler({
      config: baseConfig, db, octokit, repoUrl, isLicensed: () => true, slack: undefined,
    });
    await sched.tick();
    const rows = await db.select().from(releaseDecisions);
    expect(rows).toHaveLength(1);
    expect(rows[0].decision).toBe("skip");
    expect(rows[0].reason).toBe("tag_exists");
  });
});
