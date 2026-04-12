/**
 * Auto-merge decision logic tests — BEC-49
 *
 * Tests the four auto-merge outcomes in the pipeline runner:
 *   1. autoMerge: true, small diff, no blocking findings → mergePRViaCli called
 *   2. autoMerge: true, diff exceeds autoMergeMaxLines → merge skipped
 *   3. autoMerge: true, blocking findings → merge skipped
 *   4. autoMerge: false or not set → merge not attempted
 *
 * Uses the same mock strategy as e2e-pipeline.test.ts: mocks git operations
 * and executor at the module level, then drives the pipeline through the
 * webhook handler to exercise the full runner code path.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "node:crypto";
import { Hono } from "hono";
import { createDb } from "../db/client.js";
import { PipelineRunner, matchesAnyPattern } from "../pipeline/runner.js";
import { createWebhookHandler } from "../webhook/handler.js";
import { pipelineRuns } from "../db/schema.js";
import { eq } from "drizzle-orm";
import type {
  Notifier,
  PipelineRun,
  PipelineConfig,
  RepoConfig,
  HandoffArtifact,
  ReviewFinding,
} from "../types.js";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// vi.hoisted ensures these are available when vi.mock factories run (which
// are hoisted above all other code by Vitest).
const { mockMergePRViaCli, mockGetDiffLineCount, mockGetChangedFiles } = vi.hoisted(() => ({
  mockMergePRViaCli: vi.fn().mockResolvedValue(true),
  mockGetDiffLineCount: vi.fn().mockResolvedValue(50),
  mockGetChangedFiles: vi.fn().mockResolvedValue(["src/feature.ts"]),
}));

let mockReviewFindings: ReviewFinding[] | undefined;

function makeHandoffArtifact(
  runId: string,
  issueId: string,
  stage: string,
  reviewFindings?: ReviewFinding[],
): HandoffArtifact {
  return {
    runId,
    issueId,
    stage,
    timestamp: new Date().toISOString(),
    summary: `Completed ${stage} stage successfully`,
    filesChanged: ["src/feature.ts"],
    approach: `Standard ${stage} approach`,
    context: {
      issueIntent: "Add user search functionality",
      constraints: ["Must not break existing tests"],
      assumptions: ["Input is sanitised upstream"],
      ...(reviewFindings ? { reviewFindings } : {}),
    },
    tokenBudget: { contextTokensUsed: 150, recommendedMaxTurns: 5 },
  };
}

vi.mock("../executor/executor.js", () => ({
  executeStage: vi.fn().mockImplementation(
    async ({ runId, issueId, stage, db }: {
      runId: string;
      issueId: string;
      stage: string;
      db: any;
    }) => {
      const { nanoid } = await import("nanoid");
      const { stageRuns: stageRunsTable } = await import("../db/schema.js");
      const { eq: drizzleEq } = await import("drizzle-orm");
      const stageRunId = nanoid();
      await db.insert(stageRunsTable).values({
        id: stageRunId,
        pipelineRunId: runId,
        stage,
        status: "running",
      });
      await db
        .update(stageRunsTable)
        .set({
          status: "completed",
          completedAt: new Date(),
          inputTokens: 200,
          outputTokens: 100,
          turns: 2,
          handoffArtifact: JSON.stringify(makeHandoffArtifact(runId, issueId, stage, mockReviewFindings)),
        })
        .where(drizzleEq(stageRunsTable.id, stageRunId));

      return {
        status: "completed",
        inputTokens: 200,
        outputTokens: 100,
        turns: 2,
        handoffArtifact: makeHandoffArtifact(runId, issueId, stage, mockReviewFindings),
        handoffIsStructured: true,
      };
    },
  ),
}));

vi.mock("../repo/git.js", () => ({
  cloneRepo: vi.fn().mockResolvedValue(undefined),
  createWorktree: vi.fn().mockResolvedValue("/tmp/auto-merge-test-worktree"),
  createWorktreeFromRemote: vi.fn().mockResolvedValue("/tmp/auto-merge-test-worktree"),
  deleteWorktree: vi.fn().mockResolvedValue(undefined),
  pushBranch: vi.fn().mockResolvedValue(undefined),
  pushBranchForce: vi.fn().mockResolvedValue(undefined),
  // Pure function — provide real implementation so push-strategy logic works correctly
  choosePushStrategy: (branch: string, rebaseConflict: boolean) => {
    if (rebaseConflict || branch.startsWith("agent/")) return "force-with-lease";
    return "standard";
  },
  rebaseBranch: vi.fn().mockResolvedValue({ success: true, hasConflicts: false }),
  abortRebase: vi.fn().mockResolvedValue(undefined),
  autoCommitChanges: vi.fn().mockResolvedValue(false),
  getAgentCommits: vi.fn().mockResolvedValue([]),
  createPRViaCli: vi
    .fn()
    .mockResolvedValue("https://github.com/test/repo/pull/42"),
  mergePRViaCli: mockMergePRViaCli,
  getDiffLineCount: mockGetDiffLineCount,
  getChangedFiles: mockGetChangedFiles,
  checkDuplicateBranch: vi.fn().mockResolvedValue(null),
  cleanupWorktrees: vi.fn().mockResolvedValue([]),
  branchName: vi
    .fn()
    .mockImplementation(
      (identifier: string, slug: string) => `agent/${identifier}-${slug}`,
    ),
  gitExecSafe: vi.fn().mockResolvedValue(""),
  gitExecRaw: vi.fn().mockResolvedValue(""),
  gitExec: vi.fn().mockResolvedValue(""),
}));

vi.mock("../repo/tech-stack.js", () => ({
  detectTechStack: vi.fn().mockResolvedValue({
    languages: ["typescript"],
    frameworks: [],
    buildSystems: ["pnpm"],
  }),
}));

vi.mock("../repo/devcontainer.js", () => ({
  shouldUseDevcontainer: vi.fn().mockResolvedValue(false),
  devcontainerUp: vi.fn().mockResolvedValue(undefined),
  devcontainerDown: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../pm/coordination.js", () => ({
  upsertActiveWork: vi.fn().mockResolvedValue(undefined),
  removeActiveWork: vi.fn().mockResolvedValue(undefined),
  checkFileOverlap: vi.fn().mockResolvedValue({ hasOverlap: false, overlappingFiles: [], conflictingRunIds: [] }),
  getModifiedFiles: vi.fn().mockResolvedValue([]),
}));

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const WEBHOOK_SECRET = "test-auto-merge-secret";

function signPayload(body: string): string {
  return createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
}

let issueCounter = 0;

function buildPayload(identifier?: string): string {
  const id = identifier ?? `AM-${++issueCounter}`;
  return JSON.stringify({
    action: "update",
    type: "Issue",
    data: {
      id: `issue-uuid-${id}`,
      identifier: id,
      title: "Auto-merge test issue",
      description: "Test auto-merge logic",
      priority: 2,
      state: { id: "state-todo-uuid", name: "Todo" },
      teamId: "team-am",
      labels: [{ name: "auto-implement" }],
    },
    updatedFrom: { stateId: "state-backlog-uuid" },
  });
}

async function postWebhook(
  app: Hono,
  body: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const sig = signPayload(body);
  const res = await app.fetch(
    new Request("http://localhost/webhooks/linear", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Linear-Signature": sig,
      },
      body,
    }),
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function waitForPipeline(
  db: Awaited<ReturnType<typeof createDb>>,
  issueId: string,
  timeoutMs = 8_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await (db as any)
      .select()
      .from(pipelineRuns)
      .where(eq(pipelineRuns.issueId, issueId));
    if (rows.length > 0) {
      const run = rows[0] as Record<string, unknown>;
      if (run.status === "completed" || run.status === "failed" || run.status === "aborted") {
        return run;
      }
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Pipeline for issue ${issueId} did not complete within ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// Test configs
// ---------------------------------------------------------------------------

const REPO_CONFIG: RepoConfig = {
  url: "https://github.com/test/test-repo.git",
  defaultBranch: "main",
  testCommand: "pnpm test",
  buildCommand: "pnpm build",
};

function makePipelineConfig(overrides: Partial<PipelineConfig> = {}): PipelineConfig {
  return {
    name: "Auto Implement",
    stages: ["triage", "implement"],
    retry: { maxAttempts: 0, strategy: "fail-fast" },
    review: { requiredApprovals: 0 },
    prStrategy: "ready",
    validateHandoffs: false,
    ralphIterations: 0,
    reviewFixIterations: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Auto-merge decision logic", () => {
  let db: Awaited<ReturnType<typeof createDb>>;
  let notifier: Notifier;
  let humanReviewCalls: Array<{ run: PipelineRun; prUrl: string; reason: string }>;

  beforeEach(async () => {
    mockMergePRViaCli.mockClear().mockResolvedValue(true);
    mockGetDiffLineCount.mockClear().mockResolvedValue(50);
    mockGetChangedFiles.mockClear().mockResolvedValue(["src/feature.ts"]);
    mockReviewFindings = undefined;
    humanReviewCalls = [];

    db = await createDb({ driver: "sqlite", connectionString: ":memory:" });
    notifier = {
      onPipelineStart: vi.fn(async () => {}),
      onStageComplete: vi.fn(async () => {}),
      onPipelineComplete: vi.fn(async () => {}),
      onPipelineFailed: vi.fn(async () => {}),
      onHumanReviewNeeded: vi.fn(async (run, prUrl, reason) => {
        humanReviewCalls.push({ run, prUrl, reason });
      }),
    };
  });

  function buildApp(pipelineConfig: PipelineConfig): Hono {
    const runner = new PipelineRunner({
      db,
      notifier,
      concurrency: 2,
      agentRunDir: "/tmp/auto-merge-agent-runs",
      repoCloneDir: "/tmp/auto-merge-repos",
    });

    const app = new Hono();
    const webhookApp = createWebhookHandler({
      webhookSecret: WEBHOOK_SECRET,
      runner,
      pipelineConfigs: { "auto-implement": pipelineConfig },
      repoConfigs: { "team-am": REPO_CONFIG },
    });
    app.route("/", webhookApp);
    return app;
  }

  // 1. autoMerge: true, small diff, no blocking findings -> merge called
  it("auto-merges when enabled, diff is small, and no blocking findings", async () => {
    const config = makePipelineConfig({ autoMerge: true, autoMergeMaxLines: 200 });
    const app = buildApp(config);
    const issueId = `AM-${++issueCounter}`;
    const body = buildPayload(issueId);

    await postWebhook(app, body);
    const run = await waitForPipeline(db, issueId);

    expect(run.status).toBe("completed");
    expect(mockMergePRViaCli).toHaveBeenCalled();
    expect(humanReviewCalls).toHaveLength(0);
  });

  // 2. autoMerge: true, diff exceeds autoMergeMaxLines -> merge skipped
  it("skips auto-merge when diff exceeds autoMergeMaxLines", async () => {
    mockGetDiffLineCount.mockResolvedValue(500);
    const config = makePipelineConfig({ autoMerge: true, autoMergeMaxLines: 200 });
    const app = buildApp(config);
    const issueId = `AM-${++issueCounter}`;
    const body = buildPayload(issueId);

    await postWebhook(app, body);
    const run = await waitForPipeline(db, issueId);

    expect(run.status).toBe("completed");
    expect(mockMergePRViaCli).not.toHaveBeenCalled();
    expect(humanReviewCalls).toHaveLength(1);
    expect(humanReviewCalls[0].reason).toMatch(/Diff too large/);
  });

  // 3. autoMerge: true, blocking findings -> merge skipped
  it("skips auto-merge when blocking review findings exist", async () => {
    mockReviewFindings = [
      {
        severity: "blocking" as const,
        file: "src/feature.ts",
        line: 10,
        category: "security",
        description: "SQL injection vulnerability",
        fix: "Use parameterized queries",
      },
    ];
    const config = makePipelineConfig({ autoMerge: true, autoMergeMaxLines: 200 });
    const app = buildApp(config);
    const issueId = `AM-${++issueCounter}`;
    const body = buildPayload(issueId);

    await postWebhook(app, body);
    const run = await waitForPipeline(db, issueId);

    expect(run.status).toBe("completed");
    expect(mockMergePRViaCli).not.toHaveBeenCalled();
    expect(humanReviewCalls).toHaveLength(1);
    expect(humanReviewCalls[0].reason).toMatch(/blocking finding/);
  });

  // 4. autoMerge: false -> merge not attempted
  it("does not attempt merge when autoMerge is false", async () => {
    const config = makePipelineConfig({ autoMerge: false });
    const app = buildApp(config);
    const issueId = `AM-${++issueCounter}`;
    const body = buildPayload(issueId);

    await postWebhook(app, body);
    const run = await waitForPipeline(db, issueId);

    expect(run.status).toBe("completed");
    expect(mockMergePRViaCli).not.toHaveBeenCalled();
    expect(mockGetDiffLineCount).not.toHaveBeenCalled();
  });

  // 4b. autoMerge not set -> merge not attempted
  it("does not attempt merge when autoMerge is not set", async () => {
    const config = makePipelineConfig(); // no autoMerge property
    const app = buildApp(config);
    const issueId = `AM-${++issueCounter}`;
    const body = buildPayload(issueId);

    await postWebhook(app, body);
    const run = await waitForPipeline(db, issueId);

    expect(run.status).toBe("completed");
    expect(mockMergePRViaCli).not.toHaveBeenCalled();
    expect(mockGetDiffLineCount).not.toHaveBeenCalled();
  });

  // Edge case: uses default autoMergeMaxLines of 200
  it("uses default autoMergeMaxLines of 200 when not specified", async () => {
    mockGetDiffLineCount.mockResolvedValue(199);
    const config = makePipelineConfig({ autoMerge: true }); // no autoMergeMaxLines
    const app = buildApp(config);
    const issueId = `AM-${++issueCounter}`;
    const body = buildPayload(issueId);

    await postWebhook(app, body);
    const run = await waitForPipeline(db, issueId);

    expect(run.status).toBe("completed");
    expect(mockMergePRViaCli).toHaveBeenCalled();
  });

  // 5. autoMergeExcludePatterns: changed file matches pattern -> merge skipped
  it("skips auto-merge when a changed file matches an exclusion pattern", async () => {
    mockGetChangedFiles.mockResolvedValue(["db/migrations/0001_initial.sql", "src/feature.ts"]);
    const config = makePipelineConfig({
      autoMerge: true,
      autoMergeExcludePatterns: ["**/migrations/**"],
    });
    const app = buildApp(config);
    const issueId = `AM-${++issueCounter}`;
    const body = buildPayload(issueId);

    await postWebhook(app, body);
    const run = await waitForPipeline(db, issueId);

    expect(run.status).toBe("completed");
    expect(mockMergePRViaCli).not.toHaveBeenCalled();
    expect(humanReviewCalls).toHaveLength(1);
    expect(humanReviewCalls[0].reason).toMatch(/exclusion pattern/);
    expect(run.autoMerged).toBeFalsy();
    expect(run.autoMergeReason).toMatch(/exclusion pattern/);
  });

  // 6. autoMergeExcludePatterns: no changed file matches -> merge proceeds
  it("merges when changed files do not match exclusion patterns", async () => {
    mockGetChangedFiles.mockResolvedValue(["src/feature.ts", "src/utils.ts"]);
    const config = makePipelineConfig({
      autoMerge: true,
      autoMergeExcludePatterns: ["**/migrations/**", "infra/**"],
    });
    const app = buildApp(config);
    const issueId = `AM-${++issueCounter}`;
    const body = buildPayload(issueId);

    await postWebhook(app, body);
    const run = await waitForPipeline(db, issueId);

    expect(run.status).toBe("completed");
    expect(mockMergePRViaCli).toHaveBeenCalled();
    expect(humanReviewCalls).toHaveLength(0);
  });

  // 7. Audit log: autoMerged and autoMergeReason are persisted to DB
  it("persists autoMerged=true and reason to DB on successful auto-merge", async () => {
    const config = makePipelineConfig({ autoMerge: true });
    const app = buildApp(config);
    const issueId = `AM-${++issueCounter}`;
    const body = buildPayload(issueId);

    await postWebhook(app, body);
    const run = await waitForPipeline(db, issueId);

    expect(run.status).toBe("completed");
    expect(mockMergePRViaCli).toHaveBeenCalled();
    expect(run.autoMerged).toBeTruthy();
    expect(run.autoMergeReason).toMatch(/auto-merged successfully/);
  });

  // 8. Audit log: autoMerged=false and reason stored when merge is skipped
  it("persists autoMerged=false and skip reason to DB when diff is too large", async () => {
    mockGetDiffLineCount.mockResolvedValue(500);
    const config = makePipelineConfig({ autoMerge: true, autoMergeMaxLines: 200 });
    const app = buildApp(config);
    const issueId = `AM-${++issueCounter}`;
    const body = buildPayload(issueId);

    await postWebhook(app, body);
    const run = await waitForPipeline(db, issueId);

    expect(run.status).toBe("completed");
    expect(mockMergePRViaCli).not.toHaveBeenCalled();
    expect(run.autoMerged).toBeFalsy();
    expect(run.autoMergeReason).toMatch(/Diff too large/);
  });
});

// ---------------------------------------------------------------------------
// Unit tests for matchesAnyPattern helper
// ---------------------------------------------------------------------------

describe("matchesAnyPattern", () => {
  it("matches simple filename pattern", () => {
    expect(matchesAnyPattern("src/foo.ts", ["**/*.ts"])).toBe(true);
    expect(matchesAnyPattern("src/foo.js", ["**/*.ts"])).toBe(false);
  });

  it("matches ** glob across multiple path segments", () => {
    expect(matchesAnyPattern("db/migrations/0001_init.sql", ["**/migrations/**"])).toBe(true);
    expect(matchesAnyPattern("src/feature.ts", ["**/migrations/**"])).toBe(false);
  });

  it("matches prefix wildcard", () => {
    expect(matchesAnyPattern("infra/terraform/main.tf", ["infra/**"])).toBe(true);
    expect(matchesAnyPattern("src/infra.ts", ["infra/**"])).toBe(false);
  });

  it("returns false for empty patterns array", () => {
    expect(matchesAnyPattern("src/anything.ts", [])).toBe(false);
  });

  it("matches any pattern in the list", () => {
    expect(
      matchesAnyPattern("src/db/schema.sql", ["**/migrations/**", "**/*.sql", "infra/**"])
    ).toBe(true);
  });

  it("handles ? single-character wildcard", () => {
    expect(matchesAnyPattern("src/foo.ts", ["src/f?o.ts"])).toBe(true);
    expect(matchesAnyPattern("src/fooo.ts", ["src/f?o.ts"])).toBe(false);
  });
});
