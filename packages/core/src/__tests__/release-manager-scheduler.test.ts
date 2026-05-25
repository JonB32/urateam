import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { unlinkSync } from "node:fs";
import { desc, eq } from "drizzle-orm";
import { createDb } from "../db/index.js";
import { auditEvents, releaseDecisions, releaseApprovals } from "../db/schema.js";
import { createReleaseManagerScheduler } from "../release-manager/scheduler.js";
import { _resetLicenseCache } from "../license.js";
import { ReleaseManagerConfigSchema } from "../release-manager/types.js";

function tmpDbPath(): string {
  const id = randomBytes(8).toString("hex");
  return `/tmp/laf-rm-sched-${id}.sqlite`;
}

function makeMockOctokit(over: { repos?: Record<string, any>; git?: Record<string, any>; checks?: Record<string, any>; [key: string]: any } = {}) {
  const { repos: overRepos, git: overGit, checks: overChecks, ...restOver } = over;
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
      ...overRepos,
    },
    git: {
      createRef: vi.fn(async () => ({ data: {} })),
      ...overGit,
    },
    checks: {
      listForRef: vi.fn(async () => ({
        data: { check_runs: [{ status: "completed", conclusion: "success", completed_at: "2026-05-01T11:00:00Z" }] },
      })),
      ...overChecks,
    },
    ...restOver,
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

  it("BEC-160: skip path emits a stdout log.info so operators see the tick (visibility gap fix)", async () => {
    // Capture stdout chunks while the tick runs. Pino writes JSON-per-line to
    // process.stdout; we assert one of those lines reflects the skip event.
    const writes: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
      writes.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      return true;
    });

    try {
      const cfg = ReleaseManagerConfigSchema.parse({
        enabled: true,
        triggers: { mergedPRsSince: 100 },
      });
      const octokit = makeMockOctokit();
      const sched = createReleaseManagerScheduler({
        config: cfg, db, octokit, repoUrl, isLicensed: () => true, slack: undefined,
      });
      await sched.tick();
    } finally {
      spy.mockRestore();
      // Flush any captured noise so test runner output is unaffected
      writes.forEach((w) => orig(w));
    }

    const logLines = writes.filter((w) => w.includes("ReleaseManager:scheduler"));
    const skipLine = logLines.find((w) =>
      w.includes("tick skip") || w.includes("triggers not met"),
    );
    expect(skipLine, `expected a tick-skip log line; got ${JSON.stringify(logLines)}`).toBeDefined();
    expect(skipLine).toMatch(/mergedPRsSince not met/);
  });

  it("BEC-160 review: fire path also emits a stdout log.info — a successful release must not be silent", async () => {
    // Same captured-stdout pattern as the skip-path test above. Asserts the
    // fire branch (the production-event branch) also surfaces in docker logs.
    const writes: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
      writes.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      return true;
    });

    try {
      const cfg = ReleaseManagerConfigSchema.parse({
        enabled: true,
        triggers: { mergedPRsSince: 1 },
      });
      const octokit = makeMockOctokit();
      const sched = createReleaseManagerScheduler({
        config: cfg, db, octokit, repoUrl, isLicensed: () => true, slack: undefined,
      });
      await sched.tick();
    } finally {
      spy.mockRestore();
      writes.forEach((w) => orig(w));
    }

    const logLines = writes.filter((w) => w.includes("ReleaseManager:scheduler"));
    const fireLine = logLines.find((w) => w.includes("tick fire"));
    expect(fireLine, `expected a tick-fire log line; got ${JSON.stringify(logLines)}`).toBeDefined();
    expect(fireLine).toMatch(/v1\.0\.1/);
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

describe("createReleaseManagerScheduler — qaCheck integration", () => {
  const paths: string[] = [];
  let db: any;
  const repoUrl = "https://github.com/org/repo";
  const branch = "main";
  const qaConfig = {
    enabled: true,
    triggers: {
      mergedPRsSince: 1,
      qaCheck: {
        workflow: ".github/workflows/smoke.yml",
        linearTeamId: "team-uuid-123",
      },
    },
  };

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

  it("triggers workflow when qaCheck.workflow exists but no run for headSha", async () => {
    const cfg = ReleaseManagerConfigSchema.parse(qaConfig);
    const octokit = makeMockOctokit({
      repos: {
        getBranch: vi.fn(async () => ({ data: { commit: { sha: "head_sha_x" } } })),
        listTags: vi.fn(async () => ({ data: [{ name: "v1.0.0", commit: { sha: "old_sha" } }] })),
        getCommit: vi.fn(async () => ({ data: { commit: { committer: { date: "2026-04-01T12:00:00Z" } } } })),
        compareCommits: vi.fn(async () => ({ data: { commits: [{ commit: { message: "fix: a" } }] } })),
        listCommits: vi.fn(async () => ({ data: [] })),
        getContent: vi.fn(async () => ({ data: { type: "file" } })), // workflow exists
      },
      actions: {
        createWorkflowDispatch: vi.fn(async () => ({ status: 204 })),
        listWorkflowRuns: vi.fn(async () => ({ data: { workflow_runs: [{ id: 88888, head_sha: "head_sha_x", status: "in_progress", run_started_at: "2026-05-04T12:00:00Z" }] } })),
      },
      checks: {
        listForRef: vi.fn(async () => ({ data: { check_runs: [] } })),
      },
    });
    const linear = { createIssue: vi.fn() };
    const sched = createReleaseManagerScheduler({
      config: cfg, db, octokit, linear: linear as any, repoUrl,
      isLicensed: () => true, slack: undefined,
    });
    await sched.tick();
    expect(octokit.actions.createWorkflowDispatch).toHaveBeenCalled();
    const rows = await db.select().from(releaseDecisions);
    expect(rows).toHaveLength(1);
    expect(rows[0].decision).toBe("skip");
    expect(rows[0].reason).toBe("qa_needs_trigger");
    expect(rows[0].qaRunId).toBe(88888);
    expect(rows[0].qaRunSha).toBe("head_sha_x");
  });

  it("polls existing in-flight run and writes qa_running skip", async () => {
    const cfg = ReleaseManagerConfigSchema.parse(qaConfig);
    // Pre-seed an in-flight QA run row
    await db.insert(releaseDecisions).values({
      id: "rd_pre",
      repoUrl,
      branch,
      decidedAt: new Date(Date.now() - 5 * 60 * 1000),
      decision: "skip",
      reason: "qa_needs_trigger",
      triggerStateJson: "{}",
      attemptCount: 0,
      qaRunId: 88888,
      qaRunSha: "head_sha_x",
    });
    const octokit = makeMockOctokit({
      repos: {
        getBranch: vi.fn(async () => ({ data: { commit: { sha: "head_sha_x" } } })),
        listTags: vi.fn(async () => ({ data: [{ name: "v1.0.0", commit: { sha: "old_sha" } }] })),
        getCommit: vi.fn(async () => ({ data: { commit: { committer: { date: "2026-04-01T12:00:00Z" } } } })),
        compareCommits: vi.fn(async () => ({ data: { commits: [{ commit: { message: "fix: a" } }] } })),
        listCommits: vi.fn(async () => ({ data: [] })),
        getContent: vi.fn(async () => ({ data: { type: "file" } })),
      },
      actions: {
        createWorkflowDispatch: vi.fn(),  // should NOT be called
        getWorkflowRun: vi.fn(async () => ({ data: { id: 88888, status: "in_progress", conclusion: null, run_started_at: "2026-05-04T12:00:00Z" } })),
      },
      checks: { listForRef: vi.fn(async () => ({ data: { check_runs: [] } })) },
    });
    const sched = createReleaseManagerScheduler({
      config: cfg, db, octokit, linear: { createIssue: vi.fn() } as any, repoUrl,
      isLicensed: () => true, slack: undefined,
    });
    await sched.tick();
    expect(octokit.actions.createWorkflowDispatch).not.toHaveBeenCalled();
    expect(octokit.actions.getWorkflowRun).toHaveBeenCalled();
    const rows = await db.select().from(releaseDecisions);
    // Two rows: pre-seed + new tick
    expect(rows.length).toBe(2);
    const newRow = rows.find((r: any) => r.id !== "rd_pre");
    expect(newRow.reason).toBe("qa_running");
  });

  it("files Linear gap issue when workflow file is missing", async () => {
    const cfg = ReleaseManagerConfigSchema.parse(qaConfig);
    const octokit = makeMockOctokit({
      repos: {
        getBranch: vi.fn(async () => ({ data: { commit: { sha: "head_sha_x" } } })),
        listTags: vi.fn(async () => ({ data: [{ name: "v1.0.0", commit: { sha: "old_sha" } }] })),
        getCommit: vi.fn(async () => ({ data: { commit: { committer: { date: "2026-04-01T12:00:00Z" } } } })),
        compareCommits: vi.fn(async () => ({ data: { commits: [{ commit: { message: "fix: a" } }] } })),
        listCommits: vi.fn(async () => ({ data: [] })),
        getContent: vi.fn(async () => {
          const e: any = new Error("Not Found"); e.status = 404; throw e;
        }),
      },
      checks: { listForRef: vi.fn(async () => ({ data: { check_runs: [] } })) },
    });
    const linear = {
      createIssue: vi.fn(async () => ({ issue: Promise.resolve({ identifier: "BEC-150" }) })),
    };
    const sched = createReleaseManagerScheduler({
      config: cfg, db, octokit, linear: linear as any, repoUrl,
      isLicensed: () => true, slack: undefined,
    });
    await sched.tick();
    expect(linear.createIssue).toHaveBeenCalledTimes(1);
    const rows = await db.select().from(releaseDecisions);
    expect(rows[0].reason).toBe("qa_no_workflow");
  });

  it("retry counter: 3 consecutive dispatch failures → permanent skip with qa_dispatch_error", async () => {
    const cfg = ReleaseManagerConfigSchema.parse(qaConfig);
    const octokit = makeMockOctokit({
      repos: {
        getBranch: vi.fn(async () => ({ data: { commit: { sha: "head_sha_x" } } })),
        listTags: vi.fn(async () => ({ data: [{ name: "v1.0.0", commit: { sha: "old_sha" } }] })),
        getCommit: vi.fn(async () => ({ data: { commit: { committer: { date: "2026-04-01T12:00:00Z" } } } })),
        compareCommits: vi.fn(async () => ({ data: { commits: [{ commit: { message: "fix: a" } }] } })),
        listCommits: vi.fn(async () => ({ data: [] })),
        getContent: vi.fn(async () => ({ data: { type: "file" } })),
      },
      actions: {
        createWorkflowDispatch: vi.fn(async () => {
          const e: any = new Error("Server Error"); e.status = 502; throw e;
        }),
        listWorkflowRuns: vi.fn(async () => ({ data: { workflow_runs: [] } })),
      },
      checks: { listForRef: vi.fn(async () => ({ data: { check_runs: [] } })) },
    });
    const sched = createReleaseManagerScheduler({
      config: cfg, db, octokit, linear: { createIssue: vi.fn() } as any, repoUrl,
      isLicensed: () => true, slack: undefined,
    });
    await sched.tick();
    await sched.tick();
    await sched.tick();
    const rows = await db.select().from(releaseDecisions).orderBy(releaseDecisions.decidedAt);
    expect(rows.length).toBe(3);
    expect(rows[2].reason).toBe("qa_dispatch_error");
    expect(rows[2].decision).toBe("skip");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BEC-139: fire-pending retry sweep
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a mock octokit for fire-pending sweep tests.
 * Overrides makeMockOctokit defaults: listTags→v1.0.1, compareCommits→empty,
 * createRelease throws by default, git.getRef succeeds by default.
 */
function makeFirePendingOctokit(over: {
  createRelease?: (input: any) => Promise<any>;
  getRef?: (input: any) => Promise<any>;
} = {}) {
  return makeMockOctokit({
    repos: {
      listTags: vi.fn(async () => ({ data: [{ name: "v1.0.1", commit: { sha: "head_sha" } }] })),
      compareCommits: vi.fn(async () => ({ data: { commits: [] } })),
      createRelease: vi.fn(over.createRelease ?? (async () => { throw new Error("createRelease failed"); })),
    },
    git: {
      getRef: vi.fn(over.getRef ?? (async () => ({ data: { object: { sha: "head_sha" } } }))),
    },
  });
}

describe("createReleaseManagerScheduler — BEC-139 fire-pending retry sweep", () => {
  const paths: string[] = [];
  let db: any;
  const repoUrl = "https://github.com/org/repo";
  const branch = "main";

  // Use a high threshold so the main tick always skips; sweep tests own the rows.
  const sweepConfig = ReleaseManagerConfigSchema.parse({
    enabled: true,
    triggers: { mergedPRsSince: 100 },
    slackChannel: "#releases",
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

  it("AC1: release_create_failed path writes fire-pending row, not an immediate skip", async () => {
    // Tick where createRef succeeds but createRelease fails — must write fire-pending.
    const octokit = makeMockOctokit({
      repos: {
        createRelease: vi.fn(async () => { throw new Error("GitHub 500"); }),
      },
    });

    const cfg = ReleaseManagerConfigSchema.parse({ enabled: true, triggers: { mergedPRsSince: 1 } });
    const sched = createReleaseManagerScheduler({ config: cfg, db, octokit, repoUrl, isLicensed: () => true, slack: undefined });
    await sched.tick();

    const rows = await db.select().from(releaseDecisions);
    expect(rows).toHaveLength(1);
    expect(rows[0].decision).toBe("fire-pending");
    expect(rows[0].reason).toBe("release_create_failed");
    expect(rows[0].firedTag).toMatch(/^v1\.0\.1$/);
    expect(rows[0].attemptCount).toBe(1);
  });

  it("AC1: 3 sweep attempts all fail → skip with release_create_failed_after_retries, releasePartialEvent audited", async () => {
    // Pre-seed a fire-pending row representing the initial failure (attemptCount=1).
    await db.insert(releaseDecisions).values({
      id: "rd_fp",
      repoUrl,
      branch,
      decidedAt: new Date(Date.now() - 7200_000),
      decision: "fire-pending",
      reason: "release_create_failed",
      triggerStateJson: JSON.stringify({ mergedCommitsSinceLastTag: 2 }),
      proposedVersion: "v1.0.1",
      firedTag: "v1.0.1",
      firedSha: "head_sha",
      attemptCount: 1,
    });

    const octokit = makeFirePendingOctokit(); // createRelease always throws

    const sched = createReleaseManagerScheduler({
      config: sweepConfig, db, octokit, repoUrl, isLicensed: () => true, slack: undefined,
    });

    // Tick 2: attemptCount 1→2 (still fire-pending)
    await sched.tick();
    const afterTick2 = await db.select().from(releaseDecisions).where(eq(releaseDecisions.id, "rd_fp"));
    expect(afterTick2[0].decision).toBe("fire-pending");
    expect(afterTick2[0].attemptCount).toBe(2);

    // Tick 3: attemptCount 2→3 — exhausted, write new skip row
    await sched.tick();
    const allRows = await db.select().from(releaseDecisions).orderBy(desc(releaseDecisions.decidedAt));
    const skipRow = allRows.find((r: any) => r.reason === "release_create_failed_after_retries");
    expect(skipRow).toBeDefined();
    expect(skipRow!.decision).toBe("skip");
    expect(skipRow!.firedTag).toBe("v1.0.1");
    expect(skipRow!.attemptCount).toBe(3);

    // releasePartialEvent must have been written to the audit table.
    const audits = await db.select().from(auditEvents).where(eq(auditEvents.eventType, "release.partial"));
    expect(audits.length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(audits[0].payload).tag).toBe("v1.0.1");
    expect(JSON.parse(audits[0].payload).attemptCount).toBe(3);

    // Regression guard: tick 4+ must NOT produce another skip row or audit event
    // (the exhausted fire-pending row must be outside the sweep filter after stamp).
    await sched.tick();
    const skipRowsAfterTick4 = await db
      .select()
      .from(releaseDecisions)
      .where(eq(releaseDecisions.reason, "release_create_failed_after_retries"));
    expect(skipRowsAfterTick4).toHaveLength(1);
    const auditsAfterTick4 = await db.select().from(auditEvents).where(eq(auditEvents.eventType, "release.partial"));
    expect(auditsAfterTick4).toHaveLength(1);
  });

  it("AC2: sweep retry succeeds → fire-pending row updated to fire, releaseFiredEvent audited, Slack posts", async () => {
    // Pre-seed a fire-pending row.
    await db.insert(releaseDecisions).values({
      id: "rd_fp2",
      repoUrl,
      branch,
      decidedAt: new Date(Date.now() - 3600_000),
      decision: "fire-pending",
      reason: "release_create_failed",
      triggerStateJson: JSON.stringify({ mergedCommitsSinceLastTag: 2 }),
      proposedVersion: "v1.0.1",
      firedTag: "v1.0.1",
      firedSha: "head_sha",
      attemptCount: 1,
    });

    const octokit = makeFirePendingOctokit({
      createRelease: async () => ({
        data: { html_url: "https://github.com/org/repo/releases/tag/v1.0.1" },
      }),
    });

    const slackMock = { postMessage: vi.fn(async () => true) };
    const sched = createReleaseManagerScheduler({
      config: sweepConfig, db, octokit, repoUrl, isLicensed: () => true, slack: slackMock,
    });

    await sched.tick();

    // Row must now be decision="fire".
    const updated = await db.select().from(releaseDecisions).where(eq(releaseDecisions.id, "rd_fp2"));
    expect(updated[0].decision).toBe("fire");

    // releaseFiredEvent must appear in audit_events.
    const audits = await db.select().from(auditEvents).where(eq(auditEvents.eventType, "release.fired"));
    expect(audits.length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(audits[0].payload).tag).toBe("v1.0.1");

    // Slack was posted at least once with the retry-success message.
    expect(slackMock.postMessage).toHaveBeenCalled();
    const retrySuccessCall = (slackMock.postMessage as any).mock.calls.find(
      (c: any[]) => /retry succeeded/i.test(c[1]),
    );
    expect(retrySuccessCall, "expected a Slack post containing 'retry succeeded'").toBeDefined();
  });

  it("AC3: fire-pending row with matching tag does NOT trigger manualTagDetected", async () => {
    // Seed an old successful fire (v1.0.0) and a newer fire-pending (v1.0.1).
    // GH reports v1.0.1 as the latest tag. Without the fix, state.ts would see
    // lastFiredTag=v1.0.0 (fire-only query) and flag a manual tag detection.
    await db.insert(releaseDecisions).values({
      id: "rd_old_fire",
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
      id: "rd_fp3",
      repoUrl,
      branch,
      decidedAt: new Date(Date.now() - 3600_000),
      decision: "fire-pending",
      reason: "release_create_failed",
      triggerStateJson: JSON.stringify({ mergedCommitsSinceLastTag: 2 }),
      proposedVersion: "v1.0.1",
      firedTag: "v1.0.1",
      firedSha: "head_sha",
      attemptCount: 1,
    });

    const octokit = makeFirePendingOctokit(); // listTags returns v1.0.1, createRelease throws

    const sched = createReleaseManagerScheduler({
      config: sweepConfig, db, octokit, repoUrl, isLicensed: () => true, slack: undefined,
    });
    await sched.tick();

    // If manualTagDetected had fired, a skip row with reason="manual_tag_detected" would appear.
    const allRows = await db.select().from(releaseDecisions);
    const manualRows = allRows.filter((r: any) => r.reason === "manual_tag_detected");
    expect(manualRows).toHaveLength(0);

    // The sweep should have incremented attemptCount to 2 (not exhausted yet).
    const fp = await db.select().from(releaseDecisions).where(eq(releaseDecisions.id, "rd_fp3"));
    expect(fp[0].attemptCount).toBe(2);
  });
});
