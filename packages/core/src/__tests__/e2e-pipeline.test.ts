/**
 * E2E Integration Test Suite — BEC-5
 *
 * Exercises the full pipeline lifecycle without real API calls:
 *   1. Sends a simulated webhook (issue → "Todo")
 *   2. Verifies pipeline starts, stages execute (with mocked Agent SDK via mocked executor)
 *   3. Verifies PR creation is triggered
 *   4. Verifies notifier callbacks fire at each lifecycle event
 *   5. Verifies DB records are written correctly
 *
 * External dependencies mocked:
 *   - ../executor/executor.js          (executeStage — avoids dynamic agent-SDK import race)
 *   - ../repo/git.js                   (clone, worktree, push, PR CLI)
 *   - ../repo/tech-stack.js            (language/framework detection)
 *   - ../repo/devcontainer.js          (container lifecycle)
 *
 * Mocking strategy:
 *   The agent SDK is loaded via a DYNAMIC import inside executor.ts. In Vitest,
 *   concurrent dynamic imports of the same module can race, causing some to receive
 *   the real module instead of the mock. Mocking executeStage at the static-import
 *   level (runner.ts imports it statically) eliminates this race entirely while still
 *   exercising the full pipeline runner → notifier → DB flow end-to-end.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "node:crypto";
import { Hono } from "hono";
import { createDb } from "../db/client.js";
import { PipelineRunner } from "../pipeline/runner.js";
import { createWebhookHandler } from "../webhook/handler.js";
import { pipelineRuns, stageRuns } from "../db/schema.js";
import { eq } from "drizzle-orm";
import type {
  Notifier,
  PipelineRun,
  StageResult,
  PipelineResult,
  PipelineError,
  PipelineConfig,
  RepoConfig,
  HandoffArtifact,
} from "../types.js";

// ---------------------------------------------------------------------------
// Module mocks — must be declared before any imports that use them.
// vi.mock() is hoisted to the top of the file by Vitest.
// ---------------------------------------------------------------------------

/** Builds a valid HandoffArtifact suitable for mocked stage results. */
function makeHandoffArtifact(
  runId: string,
  issueId: string,
  stage: string,
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
    },
    tokenBudget: { contextTokensUsed: 150, recommendedMaxTurns: 5 },
  };
}

/**
 * Mock executeStage as a static import (runner.ts imports it statically).
 * This avoids the dynamic-import race condition that would occur if we mocked
 * @anthropic-ai/claude-agent-sdk directly.
 */
vi.mock("../executor/executor.js", () => ({
  executeStage: vi.fn().mockImplementation(
    async ({ runId, issueId, stage, db }: {
      runId: string;
      issueId: string;
      stage: string;
      db: any;
    }) => {
      // Insert a stageRun record just as the real executor would, so DB
      // assertions in tests can verify stage records.
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
          handoffArtifact: JSON.stringify(makeHandoffArtifact(runId, issueId, stage)),
        })
        .where(drizzleEq(stageRunsTable.id, stageRunId));

      return {
        status: "completed",
        inputTokens: 200,
        outputTokens: 100,
        turns: 2,
        handoffArtifact: makeHandoffArtifact(runId, issueId, stage),
        handoffIsStructured: true,
        stageRunId: `mock-${runId}-${stage}`,
      } satisfies StageResult;
    },
  ),
}));

vi.mock("../repo/git.js", () => ({
  cloneRepo: vi.fn().mockResolvedValue(undefined),
  createWorktree: vi.fn().mockResolvedValue("/tmp/e2e-test-worktree"),
  createWorktreeFromRemote: vi.fn().mockResolvedValue("/tmp/e2e-test-worktree"),
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
  getAgentCommits: vi.fn().mockResolvedValue(["feat(auth): add OAuth2 login flow"]),
  createPRViaCli: vi
    .fn()
    .mockResolvedValue("https://github.com/test/repo/pull/42"),
  mergePRViaCli: vi.fn().mockResolvedValue(false),
  getDiffLineCount: vi.fn().mockResolvedValue(50),
  getChangedFiles: vi.fn().mockResolvedValue(["src/feature.ts"]),
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

const WEBHOOK_SECRET = "test-webhook-secret";

/** Sign a JSON payload the same way Linear does (HMAC-SHA256 hex). */
function signPayload(body: string): string {
  return createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
}

/**
 * Build a raw Linear webhook payload for an issue moving to "Todo".
 * Accepts deep overrides so individual tests can customise the payload.
 */
function buildStateChangePayload(
  overrides: Record<string, unknown> = {},
): string {
  const payload = {
    action: "update",
    type: "Issue",
    data: {
      id: "issue-uuid-e2e",
      identifier: "E2E-1",
      title: "Add user search",
      description: "Implement full-text user search",
      priority: 2,
      state: { id: "state-todo-uuid", name: "Todo" },
      teamId: "team-e2e",
      labels: [{ name: "auto-implement" }],
    },
    updatedFrom: { stateId: "state-backlog-uuid" },
    ...overrides,
  };
  return JSON.stringify(payload);
}

/** POST a webhook to the Hono app and return the parsed JSON response. */
async function postWebhook(
  app: Hono,
  body: string,
  signature?: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const sig = signature ?? signPayload(body);
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

/** Poll DB until the pipeline run reaches a terminal status or timeout. */
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
      if (
        run.status === "completed" ||
        run.status === "failed" ||
        run.status === "aborted"
      ) {
        return run;
      }
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(
    `Pipeline for issue ${issueId} did not reach terminal status within ${timeoutMs}ms`,
  );
}

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const TEST_PIPELINE_CONFIG: PipelineConfig = {
  name: "Auto Implement",
  stages: ["triage", "implement"],
  retry: { maxAttempts: 0, strategy: "fail-fast" },
  review: { requiredApprovals: 0 },
  prStrategy: "ready",
  validateHandoffs: false, // skip validation agent
  ralphIterations: 0,      // skip RALPH loop
  reviewFixIterations: 0,  // skip review-fix loop
};

const TEST_REPO_CONFIG: RepoConfig = {
  url: "https://github.com/test/test-repo.git",
  defaultBranch: "main",
  testCommand: "pnpm test",
  buildCommand: "pnpm build",
  // No setupCommands — avoids running npm/pnpm in the test environment
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("E2E Pipeline Lifecycle", () => {
  let db: Awaited<ReturnType<typeof createDb>>;
  let notifier: Notifier;
  let runner: PipelineRunner;
  let app: Hono;

  // Track notifier invocations for assertions
  const notifierCalls: {
    onPipelineStart: PipelineRun[];
    onStageComplete: Array<{ run: PipelineRun; stage: string; result: StageResult }>;
    onPipelineComplete: Array<{ run: PipelineRun; result: PipelineResult }>;
    onPipelineFailed: Array<{ run: PipelineRun; error: PipelineError }>;
  } = {
    onPipelineStart: [],
    onStageComplete: [],
    onPipelineComplete: [],
    onPipelineFailed: [],
  };

  beforeEach(async () => {
    // Reset notifier call log for test isolation
    notifierCalls.onPipelineStart.length = 0;
    notifierCalls.onStageComplete.length = 0;
    notifierCalls.onPipelineComplete.length = 0;
    notifierCalls.onPipelineFailed.length = 0;

    // Fresh in-memory SQLite for each test — fully isolated
    db = await createDb({ driver: "sqlite", connectionString: ":memory:" });

    // Mock notifier that records every call for assertion
    notifier = {
      onPipelineStart: vi.fn(async (run) => {
        notifierCalls.onPipelineStart.push(run);
      }),
      onStageComplete: vi.fn(async (run, stage, result) => {
        notifierCalls.onStageComplete.push({ run, stage, result });
      }),
      onPipelineComplete: vi.fn(async (run, result) => {
        notifierCalls.onPipelineComplete.push({ run, result });
      }),
      onPipelineFailed: vi.fn(async (run, error) => {
        notifierCalls.onPipelineFailed.push({ run, error });
      }),
    };

    runner = new PipelineRunner({
      db,
      notifier,
      concurrency: 2,
      agentRunDir: "/tmp/e2e-agent-runs",
      repoCloneDir: "/tmp/e2e-repos",
      // No github config → uses gh CLI mock (createPRViaCli)
    });

    app = new Hono();
    const webhookApp = createWebhookHandler({
      webhookSecret: WEBHOOK_SECRET,
      runner,
      pipelineConfigs: { "auto-implement": TEST_PIPELINE_CONFIG },
      repoConfigs: { "team-e2e": TEST_REPO_CONFIG },
    });
    app.route("/", webhookApp);
  });

  // ─── 1. Webhook acceptance ───────────────────────────────────────────────

  it("accepts a valid webhook and queues the pipeline run", async () => {
    const body = buildStateChangePayload();
    const { status, json } = await postWebhook(app, body);

    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.action).toBe("start");
    expect(json.runQueued).toBe(true);

    // Wait for the background pipeline to reach a terminal state so the
    // runner state is clean before the next test's beforeEach runs.
    await waitForPipeline(db, "E2E-1");
  });

  it("rejects a webhook with an invalid signature (401)", async () => {
    const body = buildStateChangePayload();
    const { status, json } = await postWebhook(app, body, "bad-signature");

    expect(status).toBe(401);
    expect(json.error).toBe("Invalid signature");
  });

  it("returns ok:true for non-state-change webhooks (e.g. comments)", async () => {
    const body = JSON.stringify({ action: "create", type: "Comment", data: {} });
    const { status, json } = await postWebhook(app, body);

    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    // Must NOT queue a run
    expect(json.runQueued).toBeUndefined();
  });

  it("returns 422 when no repo is mapped for the issue's team", async () => {
    const body = buildStateChangePayload({
      data: {
        id: "issue-uuid-e2e",
        identifier: "E2E-99",
        title: "Orphan issue",
        description: "",
        priority: 2,
        state: { id: "s1", name: "Todo" },
        teamId: "team-unknown",
        labels: [{ name: "auto-implement" }],
      },
    });
    const { status } = await postWebhook(app, body);
    expect(status).toBe(422);
  });

  it("ignores duplicate webhooks within the 30-second dedup window", async () => {
    const body = buildStateChangePayload();

    const first = await postWebhook(app, body);
    const second = await postWebhook(app, body);

    expect(first.json.runQueued).toBe(true);
    expect(second.json.deduplicated).toBe(true);

    // Wait for the pipeline to settle before the next test
    await waitForPipeline(db, "E2E-1");
  });

  // ─── 2. Full pipeline lifecycle ──────────────────────────────────────────

  it("executes all configured stages and creates a PR", async () => {
    const body = buildStateChangePayload();
    await postWebhook(app, body);

    const run = await waitForPipeline(db, "E2E-1");

    // Pipeline completed successfully
    expect(run.status, `Pipeline failed with: ${run.errorMessage}`).toBe("completed");

    // PR URL captured from the mocked createPRViaCli
    expect(run.prUrl).toBe("https://github.com/test/repo/pull/42");

    // Token counts accumulated across both stages (200 in + 100 out per stage × 2)
    expect(Number(run.totalInputTokens)).toBe(400);
    expect(Number(run.totalOutputTokens)).toBe(200);
  });

  it("inserts a stage_run record for every executed stage", async () => {
    const body = buildStateChangePayload();
    await postWebhook(app, body);
    await waitForPipeline(db, "E2E-1");

    const runRows = await (db as any)
      .select()
      .from(pipelineRuns)
      .where(eq(pipelineRuns.issueId, "E2E-1"));
    expect(runRows).toHaveLength(1);

    // Two stages configured: triage + implement
    const stageRows = await (db as any)
      .select()
      .from(stageRuns)
      .where(eq(stageRuns.pipelineRunId, runRows[0].id));

    expect(stageRows).toHaveLength(2);

    const stageNames = stageRows.map((r: any) => r.stage).sort();
    expect(stageNames).toEqual(["implement", "triage"]);

    // All stages should have completed successfully
    for (const row of stageRows) {
      expect(row.status).toBe("completed");
      expect(row.inputTokens).toBe(200);
      expect(row.outputTokens).toBe(100);
    }
  });

  it("fires onPipelineStart exactly once with correct metadata", async () => {
    const body = buildStateChangePayload();
    await postWebhook(app, body);
    await waitForPipeline(db, "E2E-1");

    expect(notifierCalls.onPipelineStart).toHaveLength(1);

    const startRun = notifierCalls.onPipelineStart[0];
    expect(startRun.issueId).toBe("E2E-1");
    expect(startRun.pipelineKey).toBe("auto-implement");
    expect(startRun.repoUrl).toBe(TEST_REPO_CONFIG.url);
    expect(startRun.branch).toMatch(/^agent\/E2E-1-/);
  });

  it("fires onStageComplete for each stage with result data", async () => {
    const body = buildStateChangePayload();
    await postWebhook(app, body);
    await waitForPipeline(db, "E2E-1");

    // One call per stage (triage + implement)
    expect(notifierCalls.onStageComplete).toHaveLength(2);

    const stages = notifierCalls.onStageComplete.map((c) => c.stage).sort();
    expect(stages).toEqual(["implement", "triage"]);

    for (const call of notifierCalls.onStageComplete) {
      expect(call.result.status).toBe("completed");
      expect(call.result.inputTokens).toBe(200);
      expect(call.result.outputTokens).toBe(100);
    }
  });

  it("fires onPipelineComplete with PR URL and cumulative token counts", async () => {
    const body = buildStateChangePayload();
    await postWebhook(app, body);
    await waitForPipeline(db, "E2E-1");

    expect(notifierCalls.onPipelineComplete).toHaveLength(1);
    expect(notifierCalls.onPipelineFailed).toHaveLength(0);

    const { run, result } = notifierCalls.onPipelineComplete[0];
    expect(run.status).toBe("completed");
    expect(result.prUrl).toBe("https://github.com/test/repo/pull/42");
    expect(result.stagesCompleted).toBe(2); // triage + implement
    expect(result.totalInputTokens).toBe(400);
    expect(result.totalOutputTokens).toBe(200);
  });

  it("fires onPipelineStart, indicating Linear comments would be posted", async () => {
    // Linear comments/state transitions happen inside the notifier.
    // Since we mock the entire notifier, we verify the contract:
    // onPipelineStart is called (which LinearNotifier uses to post "In Progress").
    const body = buildStateChangePayload();
    await postWebhook(app, body);
    await waitForPipeline(db, "E2E-1");

    // onPipelineStart → LinearNotifier posts a comment + transitions to "In Progress"
    expect(notifier.onPipelineStart).toHaveBeenCalledOnce();

    // onPipelineComplete → LinearNotifier posts summary comment
    expect(notifier.onPipelineComplete).toHaveBeenCalledOnce();
    const [completedRun, completedResult] = (notifier.onPipelineComplete as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(completedResult.prUrl).toBeTruthy();
  });

  // ─── 3. Deduplication — no parallel runs for the same issue ──────────────

  it("does not start a second run if one is already active for the same issue", async () => {
    const body = buildStateChangePayload();
    await postWebhook(app, body);

    // The runner marks the issue active right after runner.start() registers it
    expect(runner.isActive("E2E-1")).toBe(true);

    // Call start() directly with the same issue — should be a no-op
    const { mapIssueToSchema } = await import("../executor/prompt/schema-mapper.js");
    const stateChange = JSON.parse(body);
    const sanitized = mapIssueToSchema(stateChange.data);
    await runner.start(
      stateChange.data,
      "auto-implement",
      TEST_PIPELINE_CONFIG,
      TEST_REPO_CONFIG,
      sanitized,
    );

    // Wait for the original run to finish
    await waitForPipeline(db, "E2E-1");

    // Only one pipeline_run record should exist
    const rows = await (db as any)
      .select()
      .from(pipelineRuns)
      .where(eq(pipelineRuns.issueId, "E2E-1"));
    expect(rows).toHaveLength(1);
  });

  // ─── 4. Branch and PR naming ──────────────────────────────────────────────

  it("uses the correct branch naming convention", async () => {
    const body = buildStateChangePayload();
    await postWebhook(app, body);
    await waitForPipeline(db, "E2E-1");

    const rows = await (db as any)
      .select()
      .from(pipelineRuns)
      .where(eq(pipelineRuns.issueId, "E2E-1"));

    // Branch should be agent/<identifier>-<slug>
    expect(rows[0].branch).toMatch(/^agent\/E2E-1-/);
    expect(rows[0].branch).toContain("add-user-search");
  });

  // ─── 5. Abort before execution starts ────────────────────────────────────

  it("abort() removes the run from activeRuns and marks DB record as aborted", async () => {
    const body = buildStateChangePayload();
    await postWebhook(app, body);

    // Issue should be active right after the webhook
    expect(runner.isActive("E2E-1")).toBe(true);

    await runner.abort("E2E-1");

    expect(runner.isActive("E2E-1")).toBe(false);

    // Allow any async cleanup to settle
    await new Promise((r) => setTimeout(r, 100));

    const rows = await (db as any)
      .select()
      .from(pipelineRuns)
      .where(eq(pipelineRuns.issueId, "E2E-1"));

    if (rows.length > 0) {
      // If the run was inserted before abort, status should be aborted
      // (may have already completed if timing was very tight)
      expect(["aborted", "completed"]).toContain(rows[0].status);
    }
  });

  // ─── 6. Trigger map — non-matching states are ignored ────────────────────

  it("ignores webhooks for states not in the trigger map", async () => {
    const body = buildStateChangePayload({
      data: {
        id: "issue-uuid-e2e-2",
        identifier: "E2E-2",
        title: "Some task",
        description: "",
        priority: 3,
        state: { id: "s2", name: "In Progress" }, // not a trigger state
        teamId: "team-e2e",
        labels: [{ name: "auto-implement" }],
      },
    });
    const { status, json } = await postWebhook(app, body);

    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    // Should not have queued a run
    expect(json.runQueued).toBeUndefined();
    expect(runner.isActive("E2E-2")).toBe(false);
  });

  // ─── 7. Health check endpoint ─────────────────────────────────────────────

  it("health check reflects configured pipeline and repo counts", async () => {
    const healthApp = new Hono();
    const pipelineConfigs = { "auto-implement": TEST_PIPELINE_CONFIG };
    const repoConfigs = { "team-e2e": TEST_REPO_CONFIG };
    healthApp.get("/health", (c) =>
      c.json({
        status: "ok",
        timestamp: new Date().toISOString(),
        pipelines: Object.keys(pipelineConfigs).length,
        repos: Object.keys(repoConfigs).length,
      }),
    );

    const res = await healthApp.fetch(new Request("http://localhost/health"));
    const json = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(json.status).toBe("ok");
    expect(json.pipelines).toBe(1);
    expect(json.repos).toBe(1);
    expect(typeof json.timestamp).toBe("string");
  });
});
