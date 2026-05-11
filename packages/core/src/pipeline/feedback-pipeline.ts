import type {
  PipelineConfig,
  RepoConfig,
  HandoffArtifact,
  Notifier,
  PipelineRun,
  StageType,
  SanitizedIssue,
  ReviewFeedbackContext,
} from "../types.js";
import type { AnyDb } from "../db/client.js";
import { pipelineRuns } from "../db/schema.js";
import { executeStage } from "../executor/executor.js";
import { getStopSignal } from "./control-signals.js";
import {
  cloneRepo,
  createWorktreeFromRemote,
  deleteWorktree,
  pushBranch,
  pushBranchForce,
  choosePushStrategy,
  rebaseBranch,
  abortRebase,
  autoCommitChanges,
} from "../repo/git.js";
import {
  createGitHubClient,
  rerequestPRReview,
  type GitHubConfig,
} from "../repo/github.js";
import { buildAuthenticatedUrl, type GitLabConfig } from "../repo/gitlab.js";
import { parseRepoUrl } from "../repo/config.js";
import type { ReviewFeedbackComment } from "../webhook/github-handler.js";
import { detectTechStack } from "../repo/tech-stack.js";
import {
  shouldUseDevcontainer,
  devcontainerUp,
  devcontainerDown,
  type DevcontainerSession,
} from "../repo/devcontainer.js";
import type { WorkQueue } from "./queue.js";
import {
  withBranchLock,
  type LockAdapter,
} from "./distributed-lock.js";
import {
  upsertActiveWork,
  removeActiveWork,
  getModifiedFiles,
} from "../pm/coordination.js";
import { eq } from "drizzle-orm";
import { createLogger, runWithLogContext } from "../logger.js";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { nanoid } from "nanoid";

const execFileAsync = promisify(execFileCb);

// ---------------------------------------------------------------------------
// Module-level constants
// ---------------------------------------------------------------------------

/** Run type identifier for review-feedback pipeline runs. */
const FEEDBACK_RUN_TYPE = "review-feedback" as const;

/** Stage name for the implement step in feedback pipelines. */
const FEEDBACK_IMPL_STAGE: StageType = "implement";

/**
 * Stages skipped by the feedback pipeline.
 * Feedback runs operate on an existing PR branch, so setup stages are not needed.
 */
const FEEDBACK_SKIP_STAGES = new Set<StageType>(["triage", "reproduce", "await-approval"]);

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

/**
 * Commit any uncommitted agent changes and mark the run as auto-committed.
 * No-op if the working tree is clean.
 */
async function applyAutoCommit(
  worktreePath: string,
  issueId: string,
  branch: string,
  run: PipelineRun,
): Promise<void> {
  if (await autoCommitChanges(worktreePath, issueId, branch)) {
    run.autoCommitted = true;
  }
}

/**
 * Map webhook-shaped `ReviewFeedbackComment[]` (the wire format we receive
 * from GitHub) into the `ReviewFeedbackContext` that the implement template
 * expects when handling PR review feedback.
 *
 * Routes the implement stage into the dedicated review-feedback prompt path
 * (templates.ts:233-253) — "address review comments on existing branch, push
 * to same branch, do NOT create a new PR" — instead of falling through to
 * the standard "create branch and implement issue from scratch" prompt.
 *
 * `createdAt` is not captured by the GitHub webhook handler today, so the
 * mapped comments use an empty string. The template only renders this for
 * display; an empty value is harmless.
 */
export function buildReviewFeedbackContext(
  prUrl: string,
  prBranch: string,
  comments: ReviewFeedbackComment[],
): ReviewFeedbackContext {
  return {
    prUrl,
    prBranch,
    comments: comments.map((c) => ({
      author: c.author,
      body: c.body,
      file: c.filePath,
      line: c.lineNumber,
      createdAt: "",
    })),
  };
}

/**
 * All dependencies required by executeFeedbackPipeline.
 *
 * PipelineRunner.startFeedback() constructs this context from its own
 * instance fields and passes it through to the extracted function so the
 * implementation can live outside the class while still accessing the same
 * shared state (queues, locks, notifier, config).
 *
 * @param db              - AnyDb instance (SQLite or Postgres)
 * @param notifier        - Composite notifier for Linear/Slack/Discord events
 * @param repoCloneDir    - Base directory for bare repository clones
 * @param agentRunDir     - Base directory for per-run agent worktrees
 * @param githubConfig    - Optional GitHub App credentials (re-request review)
 * @param gitlabConfig    - Optional GitLab credentials (authenticated clone URL)
 * @param pushQueue       - Concurrency-1 queue serialising push operations
 * @param lockAdapter     - Distributed branch lock adapter
 * @param prLockTimeoutMs - Max wait time (ms) for the distributed branch lock
 * @param budgetAlertedRuns - Mutable set of runIds that already fired 80% alert
 * @param checkTokenBudget  - Bound method: checks/enforces the token budget
 * @param failPipeline      - Bound method: marks run as failed and notifies
 * @param injectAgentConfig - Bound method: writes CLAUDE.md into worktree
 */
export interface FeedbackPipelineContext {
  db: AnyDb;
  notifier: Notifier;
  repoCloneDir: string;
  agentRunDir: string;
  githubConfig?: GitHubConfig;
  gitlabConfig?: GitLabConfig;
  pushQueue: WorkQueue;
  lockAdapter: LockAdapter;
  prLockTimeoutMs: number;
  budgetAlertedRuns: Set<string>;
  checkTokenBudget(
    db: AnyDb,
    runId: string,
    run: PipelineRun,
    config: PipelineConfig,
    stage: string,
  ): Promise<boolean>;
  failPipeline(
    db: AnyDb,
    runId: string,
    run: PipelineRun,
    stage: string,
    errorMsg: string,
    retriesExhausted: boolean,
  ): Promise<void>;
  injectAgentConfig(worktreePath: string): Promise<void>;
  /**
   * Operator-initiated stop. Mirrors the main pipeline's path so feedback
   * runs honour cancel/graceful signals. Passes the prUrl so the per-PR
   * rate-limit slot is freed immediately rather than waiting on the queue's
   * `finally` block.
   */
  markRunCancelled(
    db: AnyDb,
    runId: string,
    run: PipelineRun,
    mode: "cancel" | "graceful",
    feedbackPrUrl?: string,
  ): Promise<void>;
}

/**
 * Execute a review-feedback pipeline run.
 *
 * Key differences from executePipeline():
 *  - Checks out the EXISTING PR branch (not a new one).
 *  - Skips triage, reproduce, await-approval stages.
 *  - Does NOT create a new PR — pushes to the same branch.
 *  - Optionally re-requests review via GitHub App after push.
 *  - Feedback comment context is injected into the implement stage prompt.
 *
 * @param ctx              - All dependencies (db, notifier, queues, config, etc.)
 * @param runId            - Unique ID for this pipeline run
 * @param run              - In-memory PipelineRun state object
 * @param config           - Pipeline configuration (stages, maxTokens, etc.)
 * @param repoConfig       - Repository configuration (URL, provider, etc.)
 * @param sanitizedIssue   - Sanitized issue data for prompt construction
 * @param branch           - Existing PR branch to check out and push to
 * @param prUrl            - URL of the pull request being addressed
 * @param prNumber         - PR number (required for re-requesting review)
 * @param feedbackComments - Raw feedback comments from the GitHub webhook
 * @param rerequestReview  - Whether to re-request review after pushing
 */
export async function executeFeedbackPipeline(
  ctx: FeedbackPipelineContext,
  runId: string,
  run: PipelineRun,
  config: PipelineConfig,
  repoConfig: RepoConfig,
  sanitizedIssue: SanitizedIssue,
  branch: string,
  prUrl: string,
  prNumber: number | undefined,
  feedbackComments: ReviewFeedbackComment[],
  rerequestReview: boolean,
): Promise<void> {
  const { db } = ctx;
  const runLog = createLogger({
    component: "FeedbackPipeline",
    runId,
    issueId: run.issueId,
  });

  let worktreePath: string | undefined;
  let devcontainerSession: DevcontainerSession | undefined;
  // Track the current stage so the catch block can report a meaningful name
  // rather than the fallback "unknown" string. Declared outside try/catch
  // so it remains accessible in the catch block scope.
  let currentStage: string = "unknown";

  await db
    .update(pipelineRuns)
    .set({ status: "running" })
    .where(eq(pipelineRuns.id, runId));
  run.status = "running";

  await upsertActiveWork(db, {
    runId,
    issueId: sanitizedIssue.id,
    stage: "implement",
  });

  await ctx.notifier.onPipelineStart(run);

  try {
    // -----------------------------------------------------------------------
    // Set up worktree from existing remote branch
    // -----------------------------------------------------------------------
    const repoDir = `${ctx.repoCloneDir}/${sanitizedIssue.slug}`;
    const cloneUrl =
      repoConfig.provider === "gitlab" && ctx.gitlabConfig
        ? buildAuthenticatedUrl(repoConfig.url, ctx.gitlabConfig)
        : repoConfig.url;
    const logUrl = cloneUrl.replace(/:\/\/[^@]+@/, "://[redacted]@");
    runLog.info({ repoUrl: logUrl, repoDir }, "feedback: cloning/fetching repository");
    await cloneRepo(cloneUrl, repoDir);

    runLog.info({ branch }, "feedback: creating worktree from existing remote branch");
    worktreePath = await createWorktreeFromRemote(
      repoDir,
      runId,
      branch,
      ctx.agentRunDir,
    );
    runLog.info({ worktreePath }, "feedback: worktree created");

    // Devcontainer (if configured)
    const useDevcontainer = await shouldUseDevcontainer(
      worktreePath,
      repoConfig.devcontainer,
    );
    if (useDevcontainer) {
      runLog.info("feedback: starting devcontainer");
      devcontainerSession = await devcontainerUp(
        worktreePath,
        repoConfig.devcontainer,
      );
    }

    await ctx.injectAgentConfig(worktreePath);

    if (repoConfig.setupCommands) {
      for (const cmdArgs of repoConfig.setupCommands) {
        const [command, ...args] = cmdArgs;
        runLog.info({ command, args }, "feedback: running setup command");
        try {
          await execFileAsync(command, args, { cwd: worktreePath });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          runLog.error({ command, args, err }, "feedback: setup command failed");
          throw new Error(
            `Setup command failed: ${command} ${args.join(" ")} — ${msg}`,
          );
        }
      }
    }

    const techStack = await detectTechStack(worktreePath);
    runLog.info(
      {
        languages: techStack.languages,
        frameworks: techStack.frameworks,
        buildSystems: techStack.buildSystems,
      },
      "feedback: tech stack detected",
    );

    // -----------------------------------------------------------------------
    // Build review-feedback context for the implement stage. This routes the
    // implement template into its dedicated review-feedback branch
    // ("address comments on existing branch, push to same branch") instead
    // of the standard "create new branch + implement from scratch" path,
    // which is wrong for PR-comment triggered runs.
    // -----------------------------------------------------------------------
    const reviewFeedback = buildReviewFeedbackContext(
      prUrl,
      branch,
      feedbackComments,
    );

    // -----------------------------------------------------------------------
    // Execute pipeline stages — skip triage, reproduce, await-approval
    // -----------------------------------------------------------------------
    const stagesToRun = config.stages.filter((s) => !FEEDBACK_SKIP_STAGES.has(s));

    runLog.info({ stages: stagesToRun }, "feedback: starting pipeline stages");

    let handoff: HandoffArtifact | undefined;
    let allModifiedFiles: string[] = [];

    for (const stage of stagesToRun) {
      const stageType = stage as StageType;
      currentStage = stage;
      runLog.info({ stage: stageType }, "feedback: executing stage");

      // Operator stop check (graceful path) — mirrors the main pipeline at
      // runner.ts ~L840. Mid-stream cancel surfaces as result.status below.
      const preStageStopSignal = getStopSignal(runId);
      if (preStageStopSignal) {
        runLog.info(
          { stage: stageType, mode: preStageStopSignal },
          "feedback: stop requested — aborting remaining stages",
        );
        await ctx.markRunCancelled(db, runId, run, preStageStopSignal, prUrl);
        return;
      }

      await upsertActiveWork(db, {
        runId,
        issueId: sanitizedIssue.id,
        stage: stageType,
        filesModified: allModifiedFiles.length > 0 ? allModifiedFiles : undefined,
      });

      // Only the implement stage uses reviewFeedback; the test/review stages
      // get their context from the implement stage's handoff.
      const stageReviewFeedback =
        stageType === FEEDBACK_IMPL_STAGE ? reviewFeedback : undefined;

      const result = await executeStage({
        runId,
        issueId: sanitizedIssue.id,
        stage: stageType,
        sanitizedIssue,
        repoConfig,
        handoff,
        workdir: worktreePath,
        db: ctx.db,
        techStack,
        devcontainerSession,
        reviewFeedback: stageReviewFeedback,
        stageModels: config.stageModels,
      });

      // Mid-stream cancel: AbortController inside consumeAgentStream fired
      // and the executor returned status="cancelled". Without this branch
      // the loop would fall through to `if (result.status === "failed")` —
      // which doesn't match — and continue to the next stage with an
      // undefined handoff, eventually pushing partial work.
      if (result.status === "cancelled") {
        const mode = getStopSignal(runId) ?? "cancel";
        runLog.info({ stage: stageType, mode }, "feedback: stage cancelled by operator");
        await ctx.markRunCancelled(db, runId, run, mode, prUrl);
        return;
      }

      run.totalInputTokens += result.inputTokens;
      run.totalOutputTokens += result.outputTokens;

      if (await ctx.checkTokenBudget(db, runId, run, config, stage)) return;

      await ctx.notifier.onStageComplete(run, stage, result);

      if (result.status === "failed") {
        const errorMsg = result.errorMessage ?? "Stage failed";
        await ctx.failPipeline(db, runId, run, stage, errorMsg, false);
        return;
      }

      handoff = result.handoffArtifact;

      // worktreePath is guaranteed to be set at this point — createWorktreeFromRemote
      // succeeded earlier in the try block; a failure there throws before we reach the loop.
      await applyAutoCommit(worktreePath!, sanitizedIssue.id, branch, run);

      // Update the in-memory file list only; the next stage's pre-loop upsertActiveWork
      // call will persist the accumulated list. This avoids a redundant intermediate write
      // that would be immediately overwritten when the next stage begins.
      if (worktreePath) {
        const freshFiles = await getModifiedFiles(worktreePath);
        if (freshFiles.length > 0) {
          allModifiedFiles = freshFiles;
        }
      }
    }

    // -----------------------------------------------------------------------
    // Push to existing branch — no new PR
    // -----------------------------------------------------------------------
    await ctx.pushQueue.enqueue(async () => {
      await withBranchLock(
        ctx.lockAdapter,
        branch,
        ctx.prLockTimeoutMs,
        async () => {
          const wtPath = worktreePath!;

          await applyAutoCommit(wtPath, sanitizedIssue.id, branch, run);

          runLog.info(
            { defaultBranch: repoConfig.defaultBranch },
            "feedback push: rebasing before push",
          );
          const rebaseResult = await rebaseBranch(wtPath, repoConfig.defaultBranch);

          // rebaseBranch guarantees: success=false AND hasConflicts=true means
          // merge conflicts exist; success=false AND hasConflicts=false means
          // an unrelated git error — the outer catch block handles that.
          const feedbackHasConflicts = !rebaseResult.success && rebaseResult.hasConflicts;
          if (feedbackHasConflicts) {
            runLog.warn(
              "feedback push: rebase conflicts — force-pushing for human review",
            );
            await abortRebase(wtPath);
            await pushBranchForce(wtPath, branch);
            await ctx.notifier.onHumanReviewNeeded?.(
              run,
              prUrl,
              "Merge conflicts in feedback run — please resolve manually",
            );
          } else {
            const feedbackPushStrategy = choosePushStrategy(branch, false);
            if (feedbackPushStrategy === "force-with-lease") {
              runLog.info(
                { branch },
                "feedback push: force-with-lease push for agent branch",
              );
              await pushBranchForce(wtPath, branch);
            } else {
              await pushBranch(wtPath, branch);
            }
          }

          runLog.info({ prUrl }, "feedback: pushed to existing PR branch");

          // Re-request review via GitHub App if configured
          if (rerequestReview && ctx.githubConfig && prNumber) {
            try {
              const { owner, repo } = parseRepoUrl(repoConfig.url);
              const octokit = await createGitHubClient(ctx.githubConfig);
              const reRequested = await rerequestPRReview(
                octokit,
                owner,
                repo,
                prNumber,
              );
              if (reRequested) {
                runLog.info({ prUrl, prNumber }, "feedback: re-requested review");
              } else {
                runLog.info(
                  { prUrl, prNumber },
                  "feedback: no existing reviewers to re-request",
                );
              }
            } catch (reviewErr) {
              runLog.error({ err: reviewErr }, "feedback: failed to re-request review");
            }
          }
        },
      );
    });

    await db
      .update(pipelineRuns)
      .set({
        status: "completed",
        completedAt: new Date(),
        totalInputTokens: run.totalInputTokens,
        totalOutputTokens: run.totalOutputTokens,
        prUrl,
        autoCommitted: run.autoCommitted ?? null,
      })
      .where(eq(pipelineRuns.id, runId));
    run.status = "completed";

    runLog.info(
      {
        prUrl,
        totalInputTokens: run.totalInputTokens,
        totalOutputTokens: run.totalOutputTokens,
        autoCommitted: run.autoCommitted ?? false,
      },
      "feedback pipeline completed",
    );

    await ctx.notifier.onPipelineComplete(run, {
      prUrl,
      totalInputTokens: run.totalInputTokens,
      totalOutputTokens: run.totalOutputTokens,
      stagesCompleted: stagesToRun.length,
      autoMerged: false,
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    runLog.error({ err: error }, "feedback pipeline failed with unexpected error");
    await ctx.failPipeline(db, runId, run, currentStage, errorMsg, true);
  } finally {
    ctx.budgetAlertedRuns.delete(runId);
    await removeActiveWork(db, runId);
    if (devcontainerSession) {
      try {
        await devcontainerDown(devcontainerSession);
      } catch {
        // Ignore cleanup errors
      }
    }
    // Feedback runs don't pause — always clean up worktree on completion or failure.
    // Cast to string because failPipeline mutates run.status at runtime beyond the initial type.
    const feedbackStatus = run.status as string;
    if (worktreePath && (feedbackStatus === "completed" || feedbackStatus === "failed")) {
      try {
        await deleteWorktree(worktreePath);
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Orchestration layer — used by PipelineRunner.startFeedback()
// ---------------------------------------------------------------------------

/**
 * Minimal issue reference required by the feedback pipeline orchestration.
 * Structural subset of LinearIssue; passing a full LinearIssue is valid.
 */
export type FeedbackIssueRef = { identifier: string; title: string };

/**
 * Extended context for orchestrating a feedback pipeline run.
 * Adds the state-management dependencies that startFeedbackPipeline needs
 * on top of the execution dependencies in FeedbackPipelineContext.
 *
 * @param activeFeedbackRuns - Mutable map of in-flight feedback runs (prUrl → runId) for rate-limiting
 * @param queue              - Main execution queue from PipelineRunner
 * @param buildPipelineRun   - Factory that constructs an in-memory PipelineRun from issue/config data
 */
export interface FeedbackStartContext extends FeedbackPipelineContext {
  activeFeedbackRuns: Map<string, string>;
  queue: WorkQueue;
  buildPipelineRun(
    runId: string,
    issue: FeedbackIssueRef,
    pipelineKey: string,
    repoConfig: RepoConfig,
    branch: string,
  ): PipelineRun;
}

const setupLog = createLogger({ component: "FeedbackPipeline" });

/**
 * Orchestrate a review-feedback pipeline run.
 *
 * Handles the setup phase that wraps executeFeedbackPipeline:
 *  - Rate-limit check (one run per PR at a time).
 *  - DB record insertion (status = "queued").
 *  - In-memory PipelineRun construction.
 *  - Enqueue execution via the main work queue.
 *
 * PipelineRunner.startFeedback() is a thin wrapper that delegates here,
 * passing its instance state through FeedbackStartContext.
 *
 * @param ctx    - Runner-level dependencies (db, notifier, queues, locks, etc.)
 * @param params - Issue / PR / feedback data for this run
 */
export async function startFeedbackPipeline(
  ctx: FeedbackStartContext,
  params: {
    issue: FeedbackIssueRef;
    pipelineKey: string;
    pipelineConfig: PipelineConfig;
    repoConfig: RepoConfig;
    sanitizedIssue: SanitizedIssue;
    branch: string;
    prUrl: string;
    prNumber?: number;
    parentRunId?: string;
    feedbackComments: ReviewFeedbackComment[];
    rerequestReview?: boolean;
  },
): Promise<void> {
  const {
    issue,
    pipelineKey,
    pipelineConfig,
    repoConfig,
    sanitizedIssue,
    branch,
    prUrl,
    prNumber,
    parentRunId,
    feedbackComments,
    rerequestReview = false,
  } = params;

  const { db } = ctx;

  setupLog.info(
    { issueId: issue.identifier, pipeline: pipelineKey, prUrl },
    "startFeedbackPipeline() called",
  );

  // Rate-limit: one feedback run per PR at a time
  if (ctx.activeFeedbackRuns.has(prUrl)) {
    setupLog.info({ prUrl }, "feedback run already active for this PR — skipping");
    return;
  }

  const runId = nanoid();
  const runLog = createLogger({
    component: "FeedbackPipeline",
    runId,
    issueId: issue.identifier,
  });

  // Copy linearTeamId from the parent run (if any) for spend-cap accounting.
  let linearTeamId: string | null = null;
  if (parentRunId) {
    const parentRows = await db
      .select({ linearTeamId: pipelineRuns.linearTeamId })
      .from(pipelineRuns)
      .where(eq(pipelineRuns.id, parentRunId))
      .limit(1);
    linearTeamId = parentRows[0]?.linearTeamId ?? null;
  }

  runLog.info({ branch, prUrl }, "inserting feedback run into DB");
  await db.insert(pipelineRuns).values({
    id: runId,
    issueId: issue.identifier,
    issueTitle: issue.title,
    pipelineKey,
    repoUrl: repoConfig.url,
    branch,
    status: "queued",
    prUrl,
    runType: FEEDBACK_RUN_TYPE,
    parentRunId: parentRunId ?? null,
    feedbackContext: JSON.stringify(feedbackComments),
    linearTeamId,
  });

  const run = ctx.buildPipelineRun(runId, issue, pipelineKey, repoConfig, branch);
  run.prUrl = prUrl;
  run.runType = FEEDBACK_RUN_TYPE;
  run.feedbackContext = JSON.stringify(feedbackComments);

  // Register in activeFeedbackRuns BEFORE enqueue so rate-limit check works immediately.
  ctx.activeFeedbackRuns.set(prUrl, runId);

  ctx.queue
    .enqueue(async () => {
      if (!ctx.activeFeedbackRuns.has(prUrl)) return; // was cancelled

      runLog.info("executing feedback pipeline");
      try {
        await runWithLogContext({ runId, issueId: issue.identifier }, () =>
          executeFeedbackPipeline(
            ctx,
            runId,
            run,
            pipelineConfig,
            repoConfig,
            sanitizedIssue,
            branch,
            prUrl,
            prNumber,
            feedbackComments,
            rerequestReview,
          ),
        );
      } catch (err) {
        runLog.error({ err }, "feedback pipeline execution failed");
      } finally {
        ctx.activeFeedbackRuns.delete(prUrl);
      }
    })
    .catch((err) => {
      runLog.error({ err }, "feedback queue execution failed");
      ctx.activeFeedbackRuns.delete(prUrl);
    });
}
