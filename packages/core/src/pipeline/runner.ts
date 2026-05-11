import type {
  PipelineConfig,
  RepoConfig,
  HandoffArtifact,
  Notifier,
  PipelineRun,
  StageType,
  SanitizedIssue,
  DailyTokenSummary,
  PipelineRunStatus,
  ReviewFinding,
} from "../types.js";
import type { Db, AnyDb } from "../db/client.js";
import { pipelineRuns, stageRuns, reviewModelRuns } from "../db/schema.js";
import {
  formatPRCostSummary,
  type StageCostBreakdown,
} from "./cost-summary.js";
import { executeStage } from "../executor/executor.js";
import { validateHandoff } from "../executor/validate.js";
import { isFeatureLicensed } from "../license.js";
import { checkRequirements, buildRalphContext } from "../executor/ralph.js";
import { computeEffectiveRalphIterations } from "./runner-ralph-helpers.js";
import { checkTestQuality } from "../executor/test-quality.js";
import { buildDeepReviewContext } from "../executor/deep-review.js";
import { runReviewProviders } from "./review-providers-runner.js";
import { postFanoutCommentsToPR } from "../executor/review/post-fanout-comments.js";
import type { ReviewModelRun } from "../executor/review/review-provider.js";
import { extractHandoff } from "../executor/extract-handoff.js";
import { DEFAULT_AGENT_CLAUDE_MD } from "../executor/agent-config.js";
import { generatePRDescription } from "./pr-description.js";
import { maybePostChangeSummary } from "./pr-change-summary.js";
import { access, writeFile, appendFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFileCb);
import {
  cloneRepo,
  createWorktree,
  deleteWorktree,
  pushBranch,
  pushBranchForce,
  choosePushStrategy,
  rebaseBranch,
  abortRebase,
  autoCommitChanges,
  getAgentCommits,
  createPRViaCli,
  mergePRViaCli,
  getDiffLineCount,
  getChangedFiles,
  checkDuplicateBranch,
  branchName,
  pruneWorktreesInRepoDirs,
} from "../repo/git.js";
import {
  addPRComment,
  createGitHubClient,
  createPR,
  prHasCommentStartingWith,
  type GitHubConfig,
} from "../repo/github.js";
import {
  createMR,
  buildAuthenticatedUrl,
  type GitLabConfig,
} from "../repo/gitlab.js";
import { parseRepoUrl, parseGitLabUrl } from "../repo/config.js";
import type { ReviewFeedbackComment } from "../webhook/github-handler.js";
import { detectTechStack } from "../repo/tech-stack.js";
import {
  shouldUseDevcontainer,
  devcontainerUp,
  devcontainerDown,
  type DevcontainerSession,
} from "../repo/devcontainer.js";
import { createQueue, type WorkQueue } from "./queue.js";
import {
  withBranchLock,
  createBranchLockAdapter,
  type LockAdapter,
} from "./distributed-lock.js";
import {
  upsertActiveWork,
  removeActiveWork,
  checkFileOverlap,
  getModifiedFiles,
} from "../pm/coordination.js";
import { eq, and, or, sql, gte, lt, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import { createLogger, runWithLogContext } from "../logger.js";
import { isTransientError, MAX_TRANSIENT_RETRIES } from "./error-classifier.js";
import { evaluatePolicyGates } from "../policy/evaluate.js";
import { buildReviewerRequest, verifyApprovalsReceived } from "../policy/index.js";
import { logAuditEvent, policyReviewersRequestedEvent, reviewFanoutFallbackUsedEvent } from "../audit/index.js";
import { matchesAnyPattern } from "../util/glob.js";
import {
  startFeedbackPipeline,
  type FeedbackStartContext,
} from "./feedback-pipeline.js";

// Re-export from extracted module so existing callers (including tests) still
// find buildReviewFeedbackContext at pipeline/runner.js without changing their
// import paths.
export { buildReviewFeedbackContext } from "./feedback-pipeline.js";

// Module-level logger (no runId yet — used for pre-run messages)
const log = createLogger({ component: "PipelineRunner" });

export interface PipelineRunnerConfig {
  db: Db;
  notifier: Notifier;
  concurrency?: number; // default 3
  agentRunDir?: string; // default $HOME/data/runs
  repoCloneDir?: string; // default $HOME/work/repos
  github?: GitHubConfig; // optional — PR creation skipped if not provided
  gitlab?: GitLabConfig; // optional — GitLab MR creation
  /**
   * Maximum time (ms) to wait for the distributed branch lock before failing
   * the pipeline.  Defaults to 120 000 ms (2 minutes).
   */
  prLockTimeoutMs?: number;
}

// Simplified issue type from webhook
export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string;
  labels: Array<{ name: string }>;
  priority: number;
  teamId: string;
  projectId?: string;
}

export class PipelineRunner {
  private queue: WorkQueue;
  /** Push queue: concurrency=1 serialises push+PR creation within this process.
   *  The distributed branch lock (withBranchLock) extends this to multiple
   *  instances so they don't race on PR creation for the same branch. */
  private pushQueue: WorkQueue;
  private db: Db;
  private notifier: Notifier;
  private activeRuns = new Map<string, string>(); // issueId -> runId
  private budgetAlertedRuns = new Set<string>(); // runIds that have already sent 80% alert
  /** PR URL -> runId for in-flight review-feedback runs (rate-limit gate). */
  private activeFeedbackRuns = new Map<string, string>(); // prUrl -> runId
  private agentRunDir: string;
  private repoCloneDir: string;
  private githubConfig?: GitHubConfig;
  private gitlabConfig?: GitLabConfig;
  private lockAdapter: LockAdapter;
  private prLockTimeoutMs: number;

  constructor(config: PipelineRunnerConfig) {
    this.db = config.db;
    this.notifier = config.notifier;
    this.queue = createQueue(config.concurrency ?? 3);
    this.pushQueue = createQueue(1);
    this.agentRunDir = config.agentRunDir ?? join(homedir(), "data", "runs");
    this.repoCloneDir = config.repoCloneDir ?? join(homedir(), "work", "repos");
    this.githubConfig = config.github;
    this.gitlabConfig = config.gitlab;
    this.lockAdapter = createBranchLockAdapter(config.db as AnyDb);
    this.prLockTimeoutMs = config.prLockTimeoutMs ?? 120_000;
  }

  async start(
    issue: LinearIssue,
    pipelineKey: string,
    pipelineConfig: PipelineConfig,
    repoConfig: RepoConfig,
    sanitizedIssue: SanitizedIssue,
    linearTeamId: string | null = null,
  ): Promise<void> {
    log.info({ issueId: issue.identifier, pipeline: pipelineKey }, "start() called");

    if (this.activeRuns.has(issue.identifier)) {
      log.info({ issueId: issue.identifier }, "already active, skipping duplicate");
      return;
    }

    // Check for existing remote branch (issue already has a PR/branch)
    const existingBranch = await checkDuplicateBranch(repoConfig.url, issue.identifier);
    if (existingBranch) {
      log.info(
        { issueId: issue.identifier, existingBranch },
        "skipping — remote branch already exists for this issue",
      );
      return;
    }

    const runId = nanoid();
    const branch = branchName(issue.identifier, sanitizedIssue.slug);
    const db = this.db as AnyDb;
    const runLog = createLogger({ component: "PipelineRunner", runId, issueId: issue.identifier });

    runLog.info({ branch }, "inserting run into DB");
    await db
      .insert(pipelineRuns)
      .values({
        id: runId,
        issueId: issue.identifier,
        issueTitle: issue.title,
        pipelineKey,
        repoUrl: repoConfig.url,
        branch,
        status: "queued",
        linearTeamId,
      });
    runLog.info({ branch }, "run queued");

    const run = this.buildPipelineRun(
      runId,
      issue,
      pipelineKey,
      repoConfig,
      branch,
    );

    // Set activeRuns BEFORE enqueue so abort() can cancel while queued
    this.activeRuns.set(issue.identifier, runId);

    this.queue.enqueue(async () => {
      // Check if aborted while waiting in queue
      if (!this.activeRuns.has(issue.identifier)) return;

      runLog.info("executing pipeline");
      try {
        await runWithLogContext({ runId, issueId: issue.identifier }, () =>
          this.executePipeline(
            runId,
            run,
            pipelineConfig,
            repoConfig,
            sanitizedIssue,
            branch,
          )
        );
      } catch (err) {
        runLog.error({ err }, "pipeline execution failed");
      } finally {
        this.activeRuns.delete(issue.identifier);
      }
    }).catch((err) => {
      runLog.error({ err }, "queue execution failed");
      this.activeRuns.delete(issue.identifier);
    });
  }

  async resume(issueId: string): Promise<void> {
    const resumeLog = createLogger({ component: "PipelineRunner", issueId });

    // If already active in memory (edge case: paused but not yet flushed from activeRuns),
    // just update the DB status and let the existing execution continue.
    const existingRunId = this.activeRuns.get(issueId);
    if (existingRunId) {
      resumeLog.info({ runId: existingRunId }, "resume() called for in-memory active run — updating DB status");
      const db = this.db as AnyDb;
      await db
        .update(pipelineRuns)
        .set({ status: "running" })
        .where(eq(pipelineRuns.id, existingRunId));
      return;
    }

    // Look up a paused run in the DB for this issue
    const db = this.db as AnyDb;
    const rows = await db
      .select()
      .from(pipelineRuns)
      .where(
        and(
          eq(pipelineRuns.issueId, issueId),
          eq(pipelineRuns.status, "paused"),
        ),
      )
      .limit(1);

    if (rows.length === 0) {
      resumeLog.info("resume() called but no paused run found in DB — no-op");
      return;
    }

    const pausedRun = rows[0];
    const runId = pausedRun.id;
    const runLog = createLogger({ component: "PipelineRunner", runId, issueId });

    // Claim the slot immediately to prevent concurrent resume() calls
    this.activeRuns.set(issueId, runId);

    // Validate that the run has a full resume payload (saved at await-approval)
    if (pausedRun.currentStageIndex == null || !pausedRun.resumePayload) {
      runLog.error(
        "resume payload missing — cannot resume pipeline; marking as failed",
      );
      await db
        .update(pipelineRuns)
        .set({
          status: "failed",
          completedAt: new Date(),
          errorMessage: "Resume payload missing — cannot resume pipeline execution",
        })
        .where(eq(pipelineRuns.id, runId));
      this.activeRuns.delete(issueId);
      return;
    }

    let payload: {
      handoff: HandoffArtifact | null;
      pipelineConfig: PipelineConfig;
      repoConfig: RepoConfig;
      sanitizedIssue: SanitizedIssue;
      worktreePath: string;
    };

    try {
      payload = JSON.parse(pausedRun.resumePayload);
    } catch {
      runLog.error("resume payload is invalid JSON — failing run");
      await db
        .update(pipelineRuns)
        .set({
          status: "failed",
          completedAt: new Date(),
          errorMessage: "Invalid resume payload — cannot resume",
        })
        .where(eq(pipelineRuns.id, runId));
      this.activeRuns.delete(issueId);
      return;
    }

    const { handoff, pipelineConfig, repoConfig, sanitizedIssue, worktreePath } = payload;

    // Structural validation of deserialized payload
    if (
      typeof worktreePath !== "string" ||
      !pipelineConfig?.stages ||
      !sanitizedIssue?.id
    ) {
      runLog.error("resume payload has invalid structure — failing run");
      await db
        .update(pipelineRuns)
        .set({
          status: "failed",
          completedAt: new Date(),
          errorMessage: "Invalid resume payload structure — cannot resume",
        })
        .where(eq(pipelineRuns.id, runId));
      this.activeRuns.delete(issueId);
      return;
    }

    // Path containment check — worktreePath must be within agentRunDir
    const resolvedPath = resolve(worktreePath); // canonicalize — collapses .. segments
    if (!resolvedPath.startsWith(this.agentRunDir)) {
      runLog.error({ worktreePath, agentRunDir: this.agentRunDir }, "resume: worktreePath outside agentRunDir — failing run");
      await db
        .update(pipelineRuns)
        .set({
          status: "failed",
          completedAt: new Date(),
          errorMessage: `Worktree path ${worktreePath} is outside agent run directory — cannot resume`,
        })
        .where(eq(pipelineRuns.id, runId));
      this.activeRuns.delete(issueId);
      return;
    }

    // Verify the preserved worktree still exists on disk
    try {
      await access(worktreePath);
    } catch {
      runLog.error({ worktreePath }, "resume: worktree no longer exists on disk — failing run");
      await db
        .update(pipelineRuns)
        .set({
          status: "failed",
          completedAt: new Date(),
          errorMessage: `Worktree no longer exists at ${worktreePath} — cannot resume`,
        })
        .where(eq(pipelineRuns.id, runId));
      this.activeRuns.delete(issueId);
      return;
    }

    // Rebuild the PipelineRun in-memory object from the DB row.
    // retryCount must be carried forward so failPipeline can enforce the retry limit.
    const run: PipelineRun & { retryCount?: number } = {
      id: runId,
      issueId: pausedRun.issueId,
      issueTitle: pausedRun.issueTitle,
      pipelineKey: pausedRun.pipelineKey,
      repoUrl: pausedRun.repoUrl,
      branch: pausedRun.branch,
      status: "running",
      startedAt: pausedRun.startedAt ?? new Date(),
      totalInputTokens: pausedRun.totalInputTokens ?? 0,
      totalOutputTokens: pausedRun.totalOutputTokens ?? 0,
      retryCount: (pausedRun as any).retryCount ?? 0,
    };

    // Validate branch is present
    if (!pausedRun.branch) {
      runLog.error("resume: branch is null — failing run");
      await db
        .update(pipelineRuns)
        .set({
          status: "failed",
          completedAt: new Date(),
          errorMessage: "Branch is null — cannot resume pipeline",
        })
        .where(eq(pipelineRuns.id, runId));
      this.activeRuns.delete(issueId);
      return;
    }

    runLog.info(
      { stageIndex: pausedRun.currentStageIndex, worktreePath },
      "resuming pipeline — re-queuing execution from stage after await-approval",
    );

    this.queue.enqueue(async () => {
      if (!this.activeRuns.has(issueId)) return;

      try {
        await runWithLogContext({ runId, issueId }, () =>
          this.executePipeline(
            runId,
            run,
            pipelineConfig,
            repoConfig,
            sanitizedIssue,
            pausedRun.branch,
            {
              startStageIndex: pausedRun.currentStageIndex!,
              worktreePath,
              initialHandoff: handoff ?? undefined,
            },
          )
        );
      } catch (err) {
        runLog.error({ err }, "resume: pipeline execution failed");
      } finally {
        this.activeRuns.delete(issueId);
      }
    }).catch((err) => {
      runLog.error({ err }, "resume: queue execution failed");
      this.activeRuns.delete(issueId);
    });
  }

  async pause(issueId: string): Promise<void> {
    const runId = this.activeRuns.get(issueId);
    if (!runId) return;
    const db = this.db as AnyDb;
    await db
      .update(pipelineRuns)
      .set({ status: "paused" })
      .where(eq(pipelineRuns.id, runId));
  }

  async abort(issueId: string): Promise<void> {
    const runId = this.activeRuns.get(issueId);
    if (!runId) return;
    const db = this.db as AnyDb;
    await removeActiveWork(db, runId);
    await db
      .update(pipelineRuns)
      .set({ status: "aborted", completedAt: new Date() })
      .where(eq(pipelineRuns.id, runId));
    this.activeRuns.delete(issueId);
  }

  isActive(issueId: string): boolean {
    return this.activeRuns.has(issueId);
  }

  /** Returns true if a review-feedback run is already in progress for the given PR URL. */
  isActiveFeedback(prUrl: string): boolean {
    return this.activeFeedbackRuns.has(prUrl);
  }

  /**
   * Start a review-feedback pipeline run triggered by a PR review comment.
   *
   * Thin wrapper — all orchestration logic (rate-limiting, DB insert, queue
   * management) and execution are delegated to feedback-pipeline.ts.
   * See startFeedbackPipeline() for full documentation.
   */
  async startFeedback(params: {
    issue: LinearIssue;
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
  }): Promise<void> {
    const ctx: FeedbackStartContext = {
      db: this.db as AnyDb,
      notifier: this.notifier,
      repoCloneDir: this.repoCloneDir,
      agentRunDir: this.agentRunDir,
      githubConfig: this.githubConfig,
      gitlabConfig: this.gitlabConfig,
      pushQueue: this.pushQueue,
      lockAdapter: this.lockAdapter,
      prLockTimeoutMs: this.prLockTimeoutMs,
      budgetAlertedRuns: this.budgetAlertedRuns,
      checkTokenBudget: this.checkTokenBudget.bind(this),
      failPipeline: this.failPipeline.bind(this),
      injectAgentConfig: this.injectAgentConfig.bind(this),
      activeFeedbackRuns: this.activeFeedbackRuns,
      queue: this.queue,
      buildPipelineRun: this.buildPipelineRun.bind(this),
    };
    return startFeedbackPipeline(ctx, params);
  }

  /**
   * Inject the framework's CLAUDE.md into the worktree if the repo doesn't
   * already have one. Claude Code automatically reads CLAUDE.md from the
   * working directory, so this establishes coding standards for every stage.
   */
  private async injectAgentConfig(worktreePath: string): Promise<void> {
    const claudeMdPath = join(worktreePath, "CLAUDE.md");
    try {
      // wx flag = exclusive create — fails with EEXIST if file exists (atomic, no TOCTOU)
      await writeFile(claudeMdPath, DEFAULT_AGENT_CLAUDE_MD, { flag: "wx" });
      await appendFile(join(worktreePath, ".git", "info", "exclude"), "\nCLAUDE.md\n");
      log.info({ worktreePath }, "injected CLAUDE.md into worktree");
    } catch (e: any) {
      if (e?.code === "EEXIST") return; // repo already has a CLAUDE.md — respect it
      log.warn({ err: e }, "failed to inject CLAUDE.md — agent will run without it");
    }
  }

  private async executePipeline(
    runId: string,
    run: PipelineRun,
    config: PipelineConfig,
    repoConfig: RepoConfig,
    sanitizedIssue: SanitizedIssue,
    branch: string,
    resumeOptions?: {
      /** Index in config.stages of the await-approval stage we are resuming after. */
      startStageIndex: number;
      /** Preserved worktree path from before the pause. */
      worktreePath: string;
      /** Handoff artifact from the last completed stage before the pause. */
      initialHandoff: HandoffArtifact | undefined;
    },
  ): Promise<void> {
    const db = this.db as AnyDb;
    const runLog = createLogger({ component: "PipelineRunner", runId, issueId: run.issueId });

    let handoff: HandoffArtifact | undefined;
    let worktreePath: string | undefined;
    let devcontainerSession: DevcontainerSession | undefined;

    if (resumeOptions) {
      // -----------------------------------------------------------------------
      // Resuming from a paused state — re-use the preserved worktree and skip
      // all setup steps (clone, worktree creation, devcontainer, CLAUDE.md).
      // -----------------------------------------------------------------------
      worktreePath = resumeOptions.worktreePath;
      handoff = resumeOptions.initialHandoff;

      runLog.info(
        { worktreePath, startStageIndex: resumeOptions.startStageIndex },
        "resuming from preserved worktree",
      );

      await db
        .update(pipelineRuns)
        .set({ status: "running" })
        .where(eq(pipelineRuns.id, runId));
      run.status = "running";

      // Register resumed run in coordination table
      await upsertActiveWork(db, {
        runId,
        issueId: run.issueId,
        stage: config.stages[resumeOptions.startStageIndex + 1] ?? "unknown",
      });
    } else {
      // -----------------------------------------------------------------------
      // Fresh pipeline start — clone, create worktree, run setup.
      // -----------------------------------------------------------------------
      await db
        .update(pipelineRuns)
        .set({ status: "running" })
        .where(eq(pipelineRuns.id, runId));
      run.status = "running";

      // Register this run in the coordination table so other agents can see it
      await upsertActiveWork(db, {
        runId,
        issueId: run.issueId,
        stage: config.stages[0] as string,
      });

      runLog.info("notifying pipeline start");
      await this.notifier.onPipelineStart(run);
    }

    // Track last stage index for resume context on unexpected errors
    let lastStageIndex = 0;

    try {
      if (!resumeOptions) {
        // ---------------------------------------------------------------
        // Fresh start — clone repository, create worktree, run setup.
        // ---------------------------------------------------------------
        const repoDir = `${this.repoCloneDir}/${sanitizedIssue.slug}`;
        // Inject credentials for GitLab private repos
        const cloneUrl = (repoConfig.provider === "gitlab" && this.gitlabConfig)
          ? buildAuthenticatedUrl(repoConfig.url, this.gitlabConfig)
          : repoConfig.url;
        const logUrl = cloneUrl.replace(/:\/\/[^@]+@/, "://[redacted]@");
        runLog.info({ repoUrl: logUrl, repoDir }, "cloning repository");
        await cloneRepo(cloneUrl, repoDir);
        runLog.info("clone complete, creating worktree");

        worktreePath = await createWorktree(
          repoDir,
          runId,
          branch,
          this.agentRunDir,
        );
        runLog.info({ worktreePath }, "worktree created");

        // Devcontainer setup (if configured and detected)
        const useDevcontainer = await shouldUseDevcontainer(worktreePath, repoConfig.devcontainer);
        if (useDevcontainer) {
          runLog.info("starting devcontainer");
          devcontainerSession = await devcontainerUp(worktreePath, repoConfig.devcontainer);
        }

        // Inject agent CLAUDE.md into worktree (if not already present)
        await this.injectAgentConfig(worktreePath);

        // Run setup commands — each is [command, ...args] (no shell parsing)
        if (repoConfig.setupCommands) {
          for (const cmdArgs of repoConfig.setupCommands) {
            const [command, ...args] = cmdArgs;
            runLog.info({ command, args }, "running setup command");
            try {
              await execFileAsync(command, args, { cwd: worktreePath });
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              runLog.error({ command, args, err }, "setup command failed");
              throw new Error(`Setup command failed: ${command} ${args.join(" ")} — ${msg}`);
            }
          }
        }
      }

      // Detect tech stack for MCP/plugin resolution.
      // worktreePath is guaranteed to be set by either the fresh-start block or resumeOptions.
      if (!worktreePath) {
        throw new Error("worktreePath not set after setup — this should not happen");
      }
      const techStack = await detectTechStack(worktreePath);
      runLog.info(
        {
          languages: techStack.languages,
          frameworks: techStack.frameworks,
          buildSystems: techStack.buildSystems,
        },
        "tech stack detected",
      );

      // Determine which stages to execute:
      // - Fresh start: all configured stages in order.
      // - Resume after await-approval: only stages after the paused index.
      const stagesToRun = resumeOptions
        ? config.stages.slice(resumeOptions.startStageIndex + 1)
        : config.stages;

      // Track cumulative files modified across all stages for coordination
      let allModifiedFiles: string[] = [];

      // Track the most recent review stage_run id so the deep-review fanout
      // can persist its `review_model_runs` rows against the right stage row.
      // Updated after every executeStage("review", ...) call across the main
      // stage loop, the review-fix loop, and the deep-review loop.
      let lastReviewStageRunId = "";

      // Fanout runs captured from the deep-review block (BEC-134). The PR
      // doesn't exist yet when fanout runs, so we hold the runs in-memory
      // and post one labeled comment per non-agentic run AFTER PR creation.
      let pendingFanoutRuns: ReviewModelRun[] = [];

      // Track RALPH satisfaction state across the pipeline for draft PR decision
      let ralphSatisfied = true;
      let ralphGaps: string[] = [];
      let ralphSuggestions: string[] = [];
      // urateam#108: distinguish "RALPH ran successfully and found N gaps"
      // (ralphSatisfied=false, ralphGaps populated) from "RALPH check agent
      // itself failed" (ralphSatisfied=false, ralphEvaluationFailed=true).
      // These produce different PR-body / comment / notifier copy so reviewers
      // don't waste time hunting for a non-existent failed requirement.
      let ralphEvaluationFailed = false;
      let ralphEvaluationError: string | undefined;
      const effectiveRalphIterations = computeEffectiveRalphIterations(
        run,
        config.ralphIterations,
        isFeatureLicensed("deep-review"),
      );
      const ralphIterations = effectiveRalphIterations;

      // Execute each stage
      runLog.info({ stages: stagesToRun }, "starting pipeline stages");
      for (const stage of stagesToRun) {
        const stageType = stage as StageType;
        lastStageIndex = config.stages.indexOf(stage);
        runLog.info({ stage: stageType }, "executing stage");

        if (stageType === "await-approval") {
          // Save the full resume context so resume() can re-attach the worktree
          // and continue from the next stage with the correct handoff artifact.
          const stageIndex = config.stages.indexOf(stage);
          const resumePayload = JSON.stringify({
            handoff: handoff ?? null,
            pipelineConfig: config,
            repoConfig,
            sanitizedIssue,
            worktreePath: worktreePath!,
          });
          await db
            .update(pipelineRuns)
            .set({
              status: "paused",
              currentStageIndex: stageIndex,
              resumePayload,
            })
            .where(eq(pipelineRuns.id, runId));
          run.status = "paused";
          runLog.info({ stageIndex }, "pipeline paused at await-approval — resume context saved");
          await this.notifier.onHumanReviewNeeded?.(
            run,
            "",
            "Pipeline paused at await-approval stage — human approval required",
          );
          return;
        }

        // Before stage: announce current stage and check for file overlaps with
        // other active runs so agents are aware of each other's work.
        await upsertActiveWork(db, {
          runId,
          issueId: sanitizedIssue.id,
          stage: stageType,
          filesModified: allModifiedFiles.length > 0 ? allModifiedFiles : undefined,
        });

        if (allModifiedFiles.length > 0) {
          const overlap = await checkFileOverlap(db, runId, allModifiedFiles);
          if (overlap.hasOverlap) {
            runLog.warn(
              {
                stage: stageType,
                overlappingFiles: overlap.overlappingFiles,
                conflictingRunIds: overlap.conflictingRunIds,
              },
              "file overlap detected with other active runs — proceeding with awareness",
            );
          }
        }

        let result = await executeStage({
          runId,
          issueId: sanitizedIssue.id,
          stage: stageType,
          sanitizedIssue,
          repoConfig,
          handoff,
          workdir: worktreePath,
          db: this.db,
          techStack,
          devcontainerSession,
          stageModels: config.stageModels,
        });

        // BEC-134: track the most recent review stage_run id so fanout
        // persistence can reuse it.
        if (stageType === "review") {
          lastReviewStageRunId = result.stageRunId;
        }

        // RALPH loop for implement stage — iteratively harden against requirements.
        // Tokens are tracked via a flag to prevent double-counting at the outer
        // accumulation point (line ~389). RALPH skips the retry block since it
        // handles its own re-execution internally.
        let ralphRan = false;
        if (
          stageType === "implement" &&
          ralphIterations > 0 &&
          result.status === "completed" &&
          result.handoffArtifact
        ) {
          ralphRan = true;
          ralphSatisfied = false; // will be set to true only if RALPH passes
          // Accumulate initial implement tokens
          run.totalInputTokens += result.inputTokens;
          run.totalOutputTokens += result.outputTokens;

          for (let iteration = 1; iteration <= ralphIterations; iteration++) {
            const handoffResult = await extractHandoff(
              "", // extractHandoff reads git diff from worktree, no agent output needed
              runId,
              sanitizedIssue.id,
              stage,
              worktreePath,
              // Full ref form (extractHandoff doesn't prepend `origin/`).
              `origin/${repoConfig.defaultBranch}`,
            );

            runLog.info({ iteration, maxIterations: ralphIterations }, "RALPH: checking requirements");
            const check = await checkRequirements(sanitizedIssue, handoffResult, worktreePath);

            if (check.satisfied) {
              runLog.info({ iteration }, "RALPH: all requirements satisfied");
              ralphSatisfied = true;
              ralphGaps = [];
              ralphSuggestions = [];
              break;
            }

            // Eval-failure path: the check agent itself broke (no parseable
            // output, threw, or exhausted turns). We have NO evidence about
            // gap status; surface that to the human via the PR draft note
            // and skip re-implement (retry on the same conditions almost
            // never recovers, and burns tokens). See urateam#108.
            if (check.evaluationFailed) {
              runLog.warn(
                { iteration, evaluationError: check.evaluationError },
                "RALPH: evaluation failed — drafting PR with eval-failure note instead of re-implementing",
              );
              ralphSatisfied = false;
              ralphEvaluationFailed = true;
              ralphEvaluationError = check.evaluationError;
              ralphGaps = [];
              ralphSuggestions = [];
              break;
            }

            // Track the latest gaps for PR comments if loop exhausts
            ralphGaps = check.gaps;
            ralphSuggestions = check.suggestions;

            // Don't re-implement on the last iteration — no check slot left
            if (iteration === ralphIterations) {
              runLog.warn(
                { iteration, gaps: check.gaps.length },
                "RALPH: gaps remain after final check — skipping re-implement (no verification slot)",
              );
              break;
            }

            runLog.info(
              { iteration, gaps: check.gaps.length, suggestions: check.suggestions.length },
              "RALPH: gaps found, re-running implement",
            );

            const ralphContext = buildRalphContext(iteration, check, handoffResult.artifact);

            result = await executeStage({
              runId,
              issueId: sanitizedIssue.id,
              stage: stageType,
              sanitizedIssue,
              repoConfig,
              handoff,
              workdir: worktreePath,
              db: this.db,
              techStack,
              devcontainerSession,
              ralphContext,
              stageModels: config.stageModels,
            });

            // Accumulate each RALPH iteration's tokens
            run.totalInputTokens += result.inputTokens;
            run.totalOutputTokens += result.outputTokens;

            // Budget check inside RALPH loop
            if (await this.checkTokenBudget(db, runId, run, config, stage)) return;

            if (result.status === "failed") {
              runLog.error({ iteration }, "RALPH: implement failed during iteration");
              break;
            }
          }

          if (!ralphSatisfied) {
            runLog.warn(
              { gaps: ralphGaps.length, iterations: ralphIterations },
              "RALPH: requirements NOT satisfied after all iterations — PR will be created as draft",
            );
          }
        }

        // Retry logic — skip if RALPH already handled re-execution for implement
        if (
          !ralphRan &&
          result.status === "failed" &&
          config.retry.strategy !== "fail-fast"
        ) {
          for (let attempt = 0; attempt < config.retry.maxAttempts; attempt++) {
            if (config.retry.strategy === "fix-and-retry") {
              runLog.warn(
                {
                  stage: stageType,
                  attempt: attempt + 1,
                  maxAttempts: config.retry.maxAttempts,
                  prevError: result.errorMessage ?? "stage failed",
                },
                "stage failed — restarting (urateam#121)",
              );
              run.stageRetries ??= {};
              run.stageRetries[stageType] = (run.stageRetries[stageType] ?? 0) + 1;
              result = await executeStage({
                runId,
                issueId: sanitizedIssue.id,
                stage: stageType,
                sanitizedIssue,
                repoConfig,
                handoff: result.handoffArtifact ?? handoff,
                workdir: worktreePath,
                db: this.db,
                techStack,
                devcontainerSession,
                stageModels: config.stageModels,
              });
              if (result.status === "completed") break;
            } else if (config.retry.strategy === "escalate") {
              break;
            }
          }
        }

        // RALPH handles its own token accumulation; skip for non-RALPH stages
        if (!ralphRan) {
          run.totalInputTokens += result.inputTokens;
          run.totalOutputTokens += result.outputTokens;
        }

        // Budget check after stage token accumulation
        if (await this.checkTokenBudget(db, runId, run, config, stage)) return;

        await this.notifier.onStageComplete(run, stage, result);

        if (result.status === "failed") {
          const errorMsg = result.errorMessage ?? "Stage failed";

          if (config.retry.strategy === "fail-fast") {
            await this.failPipeline(db, runId, run, stage, errorMsg, false, {
              worktreePath,
              currentStageIndex: config.stages.indexOf(stage),
              handoff,
              pipelineConfig: config,
              repoConfig,
              sanitizedIssue,
            });
            return;
          }

          await this.failPipeline(db, runId, run, stage, errorMsg, true, {
            worktreePath,
            currentStageIndex: config.stages.indexOf(stage),
            handoff,
            pipelineConfig: config,
            repoConfig,
            sanitizedIssue,
          });
          return;
        }

        // === false (not !result.handoffIsStructured) to exclude undefined (failed stages)
        if (result.status === "completed" && result.handoffIsStructured === false) {
          runLog.error(
            { stage },
            "stage completed but produced no structured handoff — downstream stages will have reduced context",
          );
        }

        // Validate handoff before passing to next stage
        // Skip validation on the final stage — no downstream stage depends on this handoff
        const isLastStage = config.stages.indexOf(stage) === config.stages.length - 1;
        if (
          result.status === "completed" &&
          result.handoffArtifact &&
          config.validateHandoffs !== false &&
          !isLastStage
        ) {
          runLog.info({ stage }, "validating handoff");
          let validationPassed = false;
          const validation = await validateHandoff(
            stage,
            {
              artifact: result.handoffArtifact,
              structured: result.handoffIsStructured ?? false,
            },
            sanitizedIssue,
            repoConfig,
            worktreePath,
          );
          validationPassed = validation.valid;

          let lastValidationIssues = validation.issues;
          if (!validationPassed) {
            runLog.error(
              { stage, validationIssues: validation.issues },
              "handoff validation failed",
            );

            // Retry with the last known-good handoff (not the failed artifact)
            if (config.retry.strategy === "fix-and-retry") {
              for (let attempt = 0; attempt < config.retry.maxAttempts; attempt++) {
                result = await executeStage({
                  runId,
                  issueId: sanitizedIssue.id,
                  stage: stageType,
                  sanitizedIssue,
                  repoConfig,
                  handoff, // last known-good handoff, not the failed artifact
                  workdir: worktreePath,
                  db: this.db,
                  techStack,
                  devcontainerSession,
                  stageModels: config.stageModels,
                });
                if (result.status === "completed" && result.handoffArtifact) {
                  const retryValidation = await validateHandoff(
                    stage,
                    {
                      artifact: result.handoffArtifact,
                      structured: result.handoffIsStructured ?? false,
                    },
                    sanitizedIssue,
                    repoConfig,
                    worktreePath,
                  );
                  if (retryValidation.valid) {
                    validationPassed = true;
                    break;
                  }
                  lastValidationIssues = retryValidation.issues;
                  runLog.error(
                    { stage, attempt: attempt + 1, validationIssues: retryValidation.issues },
                    "retry handoff validation still failed",
                  );
                }
              }
            }

            // If validation never passed, fail the pipeline
            if (!validationPassed) {
              const errorMsg = `Handoff validation failed for stage ${stage}: ${lastValidationIssues.join("; ")}`;
              await this.failPipeline(db, runId, run, stage, errorMsg, true, {
                worktreePath,
                currentStageIndex: config.stages.indexOf(stage),
                handoff,
                pipelineConfig: config,
                repoConfig,
                sanitizedIssue,
              });
              return;
            }
          } else {
            runLog.info({ stage }, "handoff validation passed");
          }
        }

        // Test quality gate: after the test stage completes, scan new/modified test
        // files for trivial-only assertions and inject findings into the handoff so
        // the review stage (and developers) are aware of low-quality tests.
        if (
          stageType === "test" &&
          result.status === "completed" &&
          result.handoffArtifact &&
          worktreePath
        ) {
          try {
            const qualityResult = await checkTestQuality(
              result.handoffArtifact.filesChanged,
              worktreePath,
            );
            if (qualityResult.violations.length > 0) {
              result.handoffArtifact.context.reviewFindings = [
                ...(result.handoffArtifact.context.reviewFindings ?? []),
                ...qualityResult.violations,
              ];
              runLog.warn(
                { violationCount: qualityResult.violations.length },
                "test-quality: low-quality test assertions detected — violations added to handoff",
              );
            }
          } catch (err) {
            // Fail-open: don't block the pipeline on quality check failure
            runLog.error(
              { err: err instanceof Error ? err.message : String(err) },
              "test-quality: check failed — skipping (fail-open)",
            );
          }
        }

        handoff = result.handoffArtifact;

        // Auto-commit any uncommitted changes after each stage.
        // Track as a quality metric — the agent should always commit its own work.
        if (worktreePath) {
          const didAutoCommit = await autoCommitChanges(worktreePath, sanitizedIssue.id, branch);
          if (didAutoCommit) {
            run.autoCommitted = true;
            runLog.warn(
              { stage, issueId: sanitizedIssue.id },
              "quality-metric: auto-commit triggered — agent did not commit its work",
            );
            if (config.failOnAutoCommit) {
              await this.failPipeline(
                db, runId, run, stage,
                `Agent did not commit its work after the ${stage} stage — auto-commit triggered (failOnAutoCommit is enabled)`,
                false,
                {
                  worktreePath,
                  currentStageIndex: config.stages.indexOf(stage),
                  handoff,
                  pipelineConfig: config,
                  repoConfig,
                  sanitizedIssue,
                },
              );
              return;
            }
          }
        }

        // After stage completes: update coordination with actual files modified
        // so other agents can check for overlaps before starting their next stage.
        if (worktreePath) {
          const freshFiles = await getModifiedFiles(worktreePath);
          if (freshFiles.length > 0) {
            allModifiedFiles = freshFiles;
            await upsertActiveWork(db, {
              runId,
              issueId: sanitizedIssue.id,
              stage: stageType,
              filesModified: allModifiedFiles,
            });
          }
        }
      }

      // Review-fix loop: if the last configured stage is "review" and it found
      // blocking issues, re-run the pipeline's own stages (implement, test, review)
      // to fix them. WARNING: This compounds with RALPH loops — worst case is
      // reviewFixIterations × (1 + ralphIterations) implement runs per fix cycle.
      const reviewFixIterations = config.reviewFixIterations ?? 1;
      const lastStage = config.stages[config.stages.length - 1];
      const hasBlockingFindings =
        Array.isArray(handoff?.context?.reviewFindings) &&
        handoff!.context.reviewFindings.some((f) => f.severity === "blocking");

      if (lastStage === "review" && reviewFixIterations > 0 && hasBlockingFindings) {
        // Only re-run stages the pipeline actually uses (not hardcoded implement/test/review)
        const fixStages = config.stages.filter(
          (s) => s === "implement" || s === "test" || s === "review",
        ) as StageType[];

        for (let rfIteration = 1; rfIteration <= reviewFixIterations; rfIteration++) {
          const blockingCount = handoff!.context.reviewFindings!.filter(
            (f) => f.severity === "blocking",
          ).length;
          runLog.info(
            { rfIteration, maxIterations: reviewFixIterations, blockingFindings: blockingCount },
            "review-fix loop: re-running stages to address blocking findings",
          );

          for (const fixStage of fixStages) {
            runLog.info({ stage: fixStage, rfIteration }, "review-fix: executing stage");

            const fixResult = await executeStage({
              runId,
              issueId: sanitizedIssue.id,
              stage: fixStage,
              sanitizedIssue,
              repoConfig,
              handoff,
              workdir: worktreePath,
              db: this.db,
              techStack,
              devcontainerSession,
              stageModels: config.stageModels,
            });

            // BEC-134: track latest review stage_run id for fanout persistence.
            if (fixStage === "review") {
              lastReviewStageRunId = fixResult.stageRunId;
            }

            run.totalInputTokens += fixResult.inputTokens;
            run.totalOutputTokens += fixResult.outputTokens;

            if (await this.checkTokenBudget(db, runId, run, config, fixStage)) return;

            await this.notifier.onStageComplete(run, fixStage, fixResult);

            if (fixResult.status === "failed") {
              runLog.error({ stage: fixStage, rfIteration }, "review-fix: stage failed");
              await this.failPipeline(
                db, runId, run, fixStage,
                `review-fix iteration ${rfIteration}: ${fixResult.errorMessage ?? "Stage failed"}`,
                true,
                {
                  worktreePath,
                  currentStageIndex: config.stages.indexOf(fixStage),
                  handoff,
                  pipelineConfig: config,
                  repoConfig,
                  sanitizedIssue,
                },
              );
              return;
            }

            // Validate handoff (same as main stage loop)
            if (fixResult.handoffArtifact && config.validateHandoffs === true) {
              const validation = await validateHandoff(
                fixStage,
                { artifact: fixResult.handoffArtifact, structured: fixResult.handoffIsStructured ?? false },
                sanitizedIssue,
                repoConfig,
                worktreePath,
              );
              if (!validation.valid) {
                runLog.warn({ stage: fixStage, rfIteration, issues: validation.issues }, "review-fix: handoff validation failed");
              }
            }

            handoff = fixResult.handoffArtifact;

            // Re-run RALPH after review-fix implement so that ralphSatisfied reflects
            // the final code state, not just the initial implement's state. This prevents:
            // (a) false-positive ready status when re-implement introduces a regression, and
            // (b) unnecessary draft when re-implement actually fixes the gaps.
            if (fixStage === "implement" && ralphIterations > 0 && fixResult.status === "completed" && fixResult.handoffArtifact) {
              const rfHandoffResult = await extractHandoff(
                "", // extractHandoff reads git diff from worktree, no agent output needed
                runId,
                sanitizedIssue.id,
                fixStage,
                worktreePath,
                // Full ref form (extractHandoff doesn't prepend `origin/`).
                `origin/${repoConfig.defaultBranch}`,
              );
              runLog.info({ rfIteration }, "RALPH: re-checking requirements after review-fix implement");
              const rfCheck = await checkRequirements(sanitizedIssue, rfHandoffResult, worktreePath);
              ralphSatisfied = rfCheck.satisfied;
              if (rfCheck.evaluationFailed) {
                ralphEvaluationFailed = true;
                ralphEvaluationError = rfCheck.evaluationError;
                ralphGaps = [];
                ralphSuggestions = [];
                runLog.warn(
                  { rfIteration, evaluationError: rfCheck.evaluationError },
                  "RALPH: re-check evaluation failed — drafting PR with eval-failure note (urateam#108)",
                );
              } else {
                // Reset in case a prior iteration's eval failed but this
                // re-check ran cleanly.
                ralphEvaluationFailed = false;
                ralphEvaluationError = undefined;
                ralphGaps = rfCheck.gaps;
                ralphSuggestions = rfCheck.suggestions;
                if (rfCheck.satisfied) {
                  runLog.info({ rfIteration }, "RALPH: requirements satisfied after review-fix implement");
                } else {
                  runLog.warn(
                    { rfIteration, gaps: rfCheck.gaps.length },
                    "RALPH: requirements NOT satisfied after review-fix implement — PR may be created as draft",
                  );
                }
              }
            }

            // Update coordination table with latest file changes from review-fix stage
            if (handoff?.filesChanged?.length) {
              allModifiedFiles = handoff.filesChanged;
              await upsertActiveWork(db, {
                runId,
                issueId: sanitizedIssue.id,
                stage: "implement",
                filesModified: allModifiedFiles,
              });
            }
          }

          // Check if blocking findings are resolved (Array.isArray guard prevents
          // false "resolved" when review agent omits reviewFindings entirely)
          const stillBlocking =
            Array.isArray(handoff?.context?.reviewFindings) &&
            handoff!.context.reviewFindings.some((f) => f.severity === "blocking");

          if (!stillBlocking) {
            runLog.info({ rfIteration }, "review-fix loop: all blocking findings resolved");
            break;
          }

          if (rfIteration === reviewFixIterations) {
            runLog.warn(
              { rfIteration, blockingFindings: handoff?.context?.reviewFindings?.filter((f) => f.severity === "blocking").length },
              "review-fix loop: max iterations reached — PR will be created as draft with remaining findings",
            );
          }
        }
      }

      // unresolvedBlockingFindings will be recomputed after deep review loop

      // Deep review loop: after the review-fix loop resolves blocking findings,
      // run 3 parallel sub-agents (reuse, quality, efficiency) to harden code
      // quality. Configurable via deepReviewPasses (default 0/disabled) and
      // maxDeepReviewPasses (hard cap, default 3).
      const effectiveDeepReviewPasses = isFeatureLicensed("deep-review")
        ? config.deepReviewPasses ?? 0
        : 0;
      const deepReviewPasses = effectiveDeepReviewPasses;
      const maxDeepReviewPasses = config.maxDeepReviewPasses ?? 3;
      const hasReview = config.stages.includes("review");
      const hasImplement = config.stages.includes("implement");

      if (deepReviewPasses > 0 && hasReview && hasImplement) {
        // Cap deep review iterations against maxReviewPasses
        const passLimit = Math.min(deepReviewPasses, maxDeepReviewPasses);

        let previousFindingsCount = Infinity;

        for (let drPass = 1; drPass <= passLimit; drPass++) {
          if (!handoff) {
            runLog.info({ drPass }, "deep review: no handoff available, skipping");
            break;
          }

          runLog.info({ drPass, passLimit }, "deep review: running review providers");

          // Gate fanout to drPass===1 by passing an empty env on subsequent
          // passes — getEnabledProviders then returns only the agentic provider.
          // BEC-134: associate review_model_runs rows with the most recent
          // review stage_run row (from the main stage loop or review-fix loop).
          // PR doesn't exist yet here, so prNumber stays null; the runner posts
          // fanout PR comments after PR creation using `pendingFanoutRuns`.
          const reviewCtx = {
            runId,
            stageRunId: lastReviewStageRunId,
            workdir: worktreePath,
            handoff,
            baseRef: repoConfig.defaultBranch ?? "main",
            prNumber: null,
          };
          const reviewResult = await runReviewProviders(reviewCtx, {
            env: drPass === 1 ? process.env : ({} as NodeJS.ProcessEnv),
            db: this.db as AnyDb,
          });

          // BEC-134: capture fanout (non-agentic) runs from the first deep-review
          // pass for posting to the PR after creation. Subsequent passes have an
          // empty env (agentic-only), so no fanout runs to capture there.
          if (drPass === 1) {
            pendingFanoutRuns = reviewResult.allRuns.filter(
              (r) => r.providerId !== "agentic",
            );
          }

          const deepResult = {
            findings: reviewResult.agenticFindings,
            inputTokens: reviewResult.totalInputTokens,
            outputTokens: reviewResult.totalOutputTokens,
          };

          run.totalInputTokens += deepResult.inputTokens;
          run.totalOutputTokens += deepResult.outputTokens;

          if (await this.checkTokenBudget(db, runId, run, config, "review")) return;

          const findingsCount = deepResult.findings.length;
          runLog.info(
            { drPass, findings: findingsCount, previousFindings: previousFindingsCount },
            "deep review: sub-agents complete",
          );

          // Convergence: stop when no findings or count didn't change
          if (findingsCount === 0) {
            runLog.info({ drPass }, "deep review: no findings — converged");
            break;
          }
          if (findingsCount >= previousFindingsCount) {
            runLog.info(
              { drPass, findingsCount, previousFindingsCount },
              "deep review: findings count did not decrease — stopping to prevent loop",
            );
            break;
          }
          previousFindingsCount = findingsCount;

          // Re-run implement stage with deep review context. The agentic
          // review provider already converts DeepReviewFinding -> ReviewFinding
          // and encodes the source agent as `category = "<agent>:<category>"`;
          // recover it here so the context prompt groups findings correctly.
          const deepFindingsForContext = deepResult.findings.map((f) => {
            const colon = f.category.indexOf(":");
            const prefix = colon > 0 ? f.category.slice(0, colon) : "quality";
            const agent: "reuse" | "quality" | "efficiency" =
              prefix === "reuse" || prefix === "efficiency" ? prefix : "quality";
            return {
              agent,
              severity: f.severity,
              file: f.file,
              line: f.line,
              category: colon > 0 ? f.category.slice(colon + 1) : f.category,
              description: f.description,
              fix: f.fix,
            };
          });
          const deepReviewContext = buildDeepReviewContext(drPass, deepFindingsForContext, handoff);
          runLog.info({ drPass }, "deep review: re-running implement stage");

          const drImplementResult = await executeStage({
            runId,
            issueId: sanitizedIssue.id,
            stage: "implement",
            sanitizedIssue,
            repoConfig,
            handoff,
            workdir: worktreePath,
            db: this.db,
            techStack,
            devcontainerSession,
            ralphContext: deepReviewContext,
            stageModels: config.stageModels,
          });

          run.totalInputTokens += drImplementResult.inputTokens;
          run.totalOutputTokens += drImplementResult.outputTokens;

          if (await this.checkTokenBudget(db, runId, run, config, "implement")) return;
          await this.notifier.onStageComplete(run, "implement", drImplementResult);

          if (drImplementResult.status === "failed") {
            runLog.error({ drPass }, "deep review: implement stage failed");
            await this.failPipeline(
              db, runId, run, "implement",
              `deep-review pass ${drPass}: ${drImplementResult.errorMessage ?? "implement failed"}`,
              true,
              {
                worktreePath,
                currentStageIndex: config.stages.indexOf("implement"),
                handoff,
                pipelineConfig: config,
                repoConfig,
                sanitizedIssue,
              },
            );
            return;
          }

          handoff = drImplementResult.handoffArtifact;

          // Re-run review stage to verify fixes
          runLog.info({ drPass }, "deep review: re-running review stage");
          const drReviewResult = await executeStage({
            runId,
            issueId: sanitizedIssue.id,
            stage: "review",
            sanitizedIssue,
            repoConfig,
            handoff,
            workdir: worktreePath,
            db: this.db,
            techStack,
            devcontainerSession,
            stageModels: config.stageModels,
          });

          // BEC-134: refresh latest review stage_run id for any subsequent
          // fanout persistence inside this loop.
          lastReviewStageRunId = drReviewResult.stageRunId;

          run.totalInputTokens += drReviewResult.inputTokens;
          run.totalOutputTokens += drReviewResult.outputTokens;

          if (await this.checkTokenBudget(db, runId, run, config, "review")) return;
          await this.notifier.onStageComplete(run, "review", drReviewResult);

          if (drReviewResult.status === "failed") {
            runLog.error({ drPass }, "deep review: review stage failed");
            await this.failPipeline(
              db, runId, run, "review",
              `deep-review pass ${drPass}: ${drReviewResult.errorMessage ?? "review failed"}`,
              true,
              {
                worktreePath,
                currentStageIndex: config.stages.indexOf("review"),
                handoff,
                pipelineConfig: config,
                repoConfig,
                sanitizedIssue,
              },
            );
            return;
          }

          handoff = drReviewResult.handoffArtifact;

          // Merge deep review findings into handoff context so downstream logic
          // (e.g. auto-merge gate) can see them as standard ReviewFindings.
          if (handoff && deepResult.findings.length > 0) {
            // deepResult.findings is already ReviewFinding[] (the agentic
            // provider wrapper performs the conversion before returning).
            const existingFindings = handoff.context.reviewFindings ?? [];
            handoff = {
              ...handoff,
              context: {
                ...handoff.context,
                reviewFindings: [...existingFindings, ...deepResult.findings],
              },
            };
          }
        }
      }

      // Determine if PR should be draft based on unresolved issues.
      // Computed AFTER all loops (RALPH, review-fix, deep review) so it reflects final state.
      const unresolvedBlockingFindings: ReviewFinding[] =
        Array.isArray(handoff?.context?.reviewFindings)
          ? handoff!.context.reviewFindings.filter((f) => f.severity === "blocking")
          : [];
      let shouldDraft = !ralphSatisfied || unresolvedBlockingFindings.length > 0;

      // Org-policy guardrails (Enterprise feature): path blocklist + per-issue
      // cost cap. When a gate fires with no override label, the PR is forced
      // to draft and blocking findings are surfaced in the draft PR comment.
      if (isFeatureLicensed("org-policy") && config.policy) {
        try {
          const wtPathForPolicy = worktreePath!;
          const changedFiles = await getChangedFiles(
            wtPathForPolicy,
            repoConfig.defaultBranch,
          );
          const tokensUsed = run.totalInputTokens + run.totalOutputTokens;
          // The runner's sanitizedIssue uses a plain `labels: string[]`; wrap
          // it to match the Linear-SDK shape that `hasOverrideLabel` expects.
          const issueForGate = {
            id: sanitizedIssue.id,
            labels: async () => ({
              nodes: sanitizedIssue.labels.map((name) => ({ name })),
            }),
          };
          // Defensive: if a path blocklist is configured and getChangedFiles returned
          // no files, treat this as "could not evaluate" and force draft rather than
          // fail-open. getChangedFiles is fail-open (logs warn on git error, returns
          // []), so we can't distinguish a broken git call from an empty-diff run here.
          // False-positive rate is low because an empty diff should never reach this
          // point anyway (the pipeline would have failed earlier).
          if (changedFiles.length === 0 && config.policy.pathBlocklist.length > 0) {
            runLog.warn("policy: path blocklist configured but no changed files detected — forcing draft as defensive measure");
            shouldDraft = true;
            unresolvedBlockingFindings.push({
              severity: "blocking",
              file: "(policy)",
              line: 0,
              category: "policy-error",
              description: "Path policy blocklist could not be evaluated (git diff returned no files). Review the diff manually before merging.",
              fix: "Verify the diff manually and merge once path policy is confirmed satisfied.",
            } as any);
          }

          const gateResult = await evaluatePolicyGates({
            db: this.db as AnyDb,
            runId: run.id,
            issue: issueForGate,
            policy: config.policy,
            changedFiles,
            tokensUsed,
            stage: "all-stages",
          });
          if (gateResult.shouldDraft) {
            shouldDraft = true;
            for (const v of gateResult.violations) {
              unresolvedBlockingFindings.push({
                severity: "blocking",
                file: (v.payload.path as string | undefined) ?? "(policy)",
                line: 0,
                category: `policy-${v.gate}`,
                description: v.detail,
                fix:
                  v.gate === "path"
                    ? `Remove changes to this path, or add the \`${config.policy.overrideLabel}\` label to bypass.`
                    : `Reduce token usage, or add the \`${config.policy.overrideLabel}\` label to bypass.`,
              });
            }
            runLog.warn(
              {
                issueId: sanitizedIssue.id,
                violations: gateResult.violations.length,
              },
              "org-policy: gate fired — forcing draft PR",
            );
          } else if (gateResult.overrideActive && gateResult.violations.length > 0) {
            runLog.info(
              {
                issueId: sanitizedIssue.id,
                violations: gateResult.violations.length,
                overrideLabel: config.policy.overrideLabel,
              },
              "org-policy: gate fired but override label present — proceeding",
            );
          }

        } catch (policyErr) {
          // Fail-open on unexpected errors — policy is advisory, not a hard
          // block on the pipeline. Still log for operators.
          runLog.warn(
            { err: policyErr },
            "org-policy: gate evaluation failed — skipping",
          );
        }
      }

      // All stages complete — push branch and create PR.
      // The push queue (concurrency=1) serialises within this process.
      // withBranchLock extends that serialisation across multiple server instances
      // via a DB advisory lock (Postgres) so they can't race on PR creation for
      // the same branch.  If the lock cannot be acquired within prLockTimeoutMs,
      // the pipeline fails with a LockTimeoutError.
      let prUrl = "";
      let autoMerged = false;

      await this.pushQueue.enqueue(async () => {
        await withBranchLock(
          this.lockAdapter,
          branch,
          this.prLockTimeoutMs,
          async () => {
        const wtPath = worktreePath!;

        // 0. Auto-commit any uncommitted changes (safety net for agent not committing).
        // Track as a quality metric; fail if failOnAutoCommit is configured.
        const pushQueueAutoCommit = await autoCommitChanges(wtPath, sanitizedIssue.id, branch);
        if (pushQueueAutoCommit) {
          run.autoCommitted = true;
          runLog.warn(
            { issueId: sanitizedIssue.id },
            "quality-metric: push-queue auto-commit triggered — agent did not commit its work",
          );
          if (config.failOnAutoCommit) {
            const autoCommitMsg =
              "Agent did not commit its work before the push stage — auto-commit triggered (failOnAutoCommit is enabled)";
            await this.failPipeline(db, runId, run, "push", autoCommitMsg, true, {
              worktreePath: wtPath,
              currentStageIndex: lastStageIndex,
              handoff,
              pipelineConfig: config,
              repoConfig,
              sanitizedIssue,
            });
            // Throw to exit the push-queue callback; outer catch will detect the
            // already-failed status and skip double-calling failPipeline.
            throw new Error(autoCommitMsg);
          }
        }

        // 1. Rebase before push
        runLog.info({ defaultBranch: repoConfig.defaultBranch }, "push queue: rebasing before push");
        const rebaseResult = await rebaseBranch(wtPath, repoConfig.defaultBranch);

        let rebaseConflict = false;
        if (!rebaseResult.success) {
          if (!rebaseResult.hasConflicts) {
            runLog.warn("push queue: rebase failed (not a conflict) — pushing without rebase");
          } else {
            runLog.warn("push queue: rebase conflicts detected, running implement pass to resolve");

            const resolveResult = await executeStage({
              runId,
              issueId: sanitizedIssue.id,
              stage: "implement" as StageType,
              sanitizedIssue,
              repoConfig,
              handoff,
              workdir: wtPath,
              db: this.db,
              techStack,
              devcontainerSession,
              mergeConflictContext: { defaultBranch: repoConfig.defaultBranch },
              stageModels: config.stageModels,
            });

            run.totalInputTokens += resolveResult.inputTokens;
            run.totalOutputTokens += resolveResult.outputTokens;

            if (resolveResult.status !== "completed") {
              runLog.warn("push queue: conflict resolution failed — aborting rebase and force-pushing for human review");
              await abortRebase(wtPath);
              rebaseConflict = true;
            } else {
              runLog.info("push queue: conflict resolution succeeded");
            }
          }
        }

        // 2. Push
        // Agent branches (agent/*) are exclusively pipeline-owned — no human commits expected.
        // Using --force-with-lease allows a retry run to overwrite a stale remote branch from
        // a previously failed run, while still protecting against concurrent pushes from
        // another pipeline instance targeting the same branch.
        const pushStrategy = choosePushStrategy(branch, rebaseConflict);
        if (pushStrategy === "force-with-lease") {
          runLog.info(
            { branch, rebaseConflict },
            "push queue: force-with-lease push (agent branch or rebase conflict)",
          );
          await pushBranchForce(wtPath, branch);
        } else {
          await pushBranch(wtPath, branch);
        }

        // 3. Create PR/MR
        const agentCommits = await getAgentCommits(wtPath, repoConfig.defaultBranch);
        const prBody = generatePRDescription({
          handoff,
          issueId: sanitizedIssue.id,
          shouldDraft,
          ralphSatisfied,
          ralphGaps,
          ralphEvaluationFailed,
          ralphEvaluationError,
          unresolvedBlockingFindings,
          agentCommits,
        });
        const isGitLab = repoConfig.provider === "gitlab";

        // Mandatory reviewer request (enterprise feature 4.6). Only non-null
        // when the org-policy feature is licensed and the pipeline config
        // specifies mandatoryReviewers.
        const reviewerRequest = isFeatureLicensed("org-policy")
          ? buildReviewerRequest(config.policy)
          : null;

        if (isGitLab && this.gitlabConfig) {
          // GitLab — create MR via REST API
          try {
            const { projectPath } = parseGitLabUrl(repoConfig.url);
            prUrl = await createMR(this.gitlabConfig, {
              projectPath,
              sourceBranch: branch,
              targetBranch: repoConfig.defaultBranch,
              title: sanitizedIssue.title,
              description: prBody,
              reviewers: reviewerRequest?.users,
              teamReviewers: reviewerRequest?.teams,
            });
            run.prUrl = prUrl;
            runLog.info({ prUrl }, "MR created via GitLab API");
          } catch (mrError) {
            runLog.error({ err: mrError }, "MR creation via GitLab API failed");
          }
        } else if (!isGitLab && this.githubConfig) {
          // GitHub App — use Octokit API
          try {
            const { owner, repo } = parseRepoUrl(repoConfig.url);
            const octokit = await createGitHubClient(this.githubConfig);
            prUrl = await createPR(octokit, {
              owner,
              repo,
              branch,
              base: repoConfig.defaultBranch,
              title: sanitizedIssue.title,
              body: prBody,
              draft: shouldDraft,
              reviewers: reviewerRequest?.users,
              teamReviewers: reviewerRequest?.teams,
            });
            run.prUrl = prUrl;
          } catch (prError) {
            runLog.error({ err: prError }, "PR creation via GitHub App failed");
          }
        } else {
          // No provider-specific config — use gh CLI
          runLog.info("creating PR via gh CLI");
          const { owner: ghOwner } = (() => {
            try {
              return parseRepoUrl(repoConfig.url);
            } catch {
              return { owner: undefined as string | undefined };
            }
          })();
          prUrl = await createPRViaCli({
            worktreePath: wtPath,
            branch,
            base: repoConfig.defaultBranch,
            title: sanitizedIssue.title,
            body: prBody,
            draft: shouldDraft,
            reviewers: reviewerRequest?.users,
            teamReviewers: reviewerRequest?.teams,
            owner: ghOwner,
          });
          if (prUrl) {
            run.prUrl = prUrl;
            runLog.info({ prUrl }, "PR created");
          }
        }

        // Audit: reviewers requested (enterprise feature 4.6)
        if (reviewerRequest && prUrl) {
          void logAuditEvent(
            this.db as AnyDb,
            policyReviewersRequestedEvent({
              runId: run.id,
              prUrl,
              users: reviewerRequest.users,
              teams: reviewerRequest.teams,
            }),
          );
        }

        // BEC-134: Post fanout (per-model) review comments on the PR. Best-effort —
        // failures never block the pipeline. Requires the GitHub App for Octokit
        // access; the gh-CLI/GitLab paths skip this (parity gap accepted for v1).
        if (
          prUrl &&
          pendingFanoutRuns.length > 0 &&
          !isGitLab &&
          this.githubConfig
        ) {
          const fanoutPrNumberMatch = prUrl.match(/\/pull\/(\d+)/);
          const fanoutPrNumber = fanoutPrNumberMatch
            ? parseInt(fanoutPrNumberMatch[1]!, 10)
            : null;
          if (fanoutPrNumber !== null) {
            try {
              const { owner: fanoutOwner, repo: fanoutRepo } = parseRepoUrl(
                repoConfig.url,
              );
              const fanoutOctokit = await createGitHubClient(this.githubConfig);
              const fanoutResult = await postFanoutCommentsToPR(
                fanoutOctokit,
                fanoutOwner,
                fanoutRepo,
                fanoutPrNumber,
                pendingFanoutRuns,
              );
              runLog.info(
                { prNumber: fanoutPrNumber, count: pendingFanoutRuns.length, fallbackCount: fanoutResult.fallbackCount, suppressedEmptyCount: fanoutResult.suppressedEmptyCount },
                "fanout: posted per-model PR comments",
              );
              if (fanoutResult.fallbackCount > 0) {
                const fallbackModels = pendingFanoutRuns
                  .filter((r) => r.rawOutput !== undefined)
                  .map((r) => r.modelId);
                void logAuditEvent(
                  this.db as AnyDb,
                  reviewFanoutFallbackUsedEvent({
                    runId,
                    prNumber: fanoutPrNumber,
                    fallbackModels,
                  }),
                );
              }
            } catch (err) {
              runLog.warn(
                { err: err instanceof Error ? err.message : String(err) },
                "fanout: post-fanout-comments failed — continuing",
              );
            }
          }
        }

        // 4. Flag for human review when conflicts could not be auto-resolved
        if (rebaseConflict && prUrl) {
          runLog.warn({ prUrl }, "push queue: flagging PR for human review — unresolved merge conflicts");
          await this.notifier.onHumanReviewNeeded?.(
            run,
            prUrl,
            "Merge conflicts could not be automatically resolved — please resolve manually",
          );
        }

        // 5. Add PR comments for draft PRs explaining what needs work
        if (shouldDraft && prUrl) {
          runLog.info({ prUrl }, "draft PR: adding review comments with gaps and next steps");
          const commentParts: string[] = [];

          if (!ralphSatisfied && ralphEvaluationFailed) {
            // urateam#108: separate header + copy when the evaluator itself
            // crashed. The previous "Unmet Acceptance Criteria" header was a
            // lie — there were zero acceptance criteria checked, the agent
            // broke before it could check anything.
            commentParts.push("## RALPH Evaluation Error\n");
            commentParts.push(
              `The RALPH requirements-check agent failed to evaluate this PR. Human review is required to confirm all acceptance criteria are met.\n`,
            );
            commentParts.push(
              `**Reason:** ${ralphEvaluationError ?? "no detail captured"}\n`,
            );
            commentParts.push(
              "Common causes: agent exhausted its 6-turn cap on a complex spec, transient SDK error, or agent emitted no parseable JSON. Re-running the issue may succeed.",
            );
          } else if (!ralphSatisfied && ralphGaps.length > 0) {
            commentParts.push("## Unmet Acceptance Criteria (RALPH)\n");
            commentParts.push(`RALPH checked ${ralphIterations} time(s) and found the following gaps:\n`);
            for (const gap of ralphGaps) {
              commentParts.push(`- ${gap}`);
            }
            if (ralphSuggestions.length > 0) {
              commentParts.push("\n**Suggested next steps:**");
              for (const s of ralphSuggestions) {
                commentParts.push(`- ${s}`);
              }
            }
          }

          if (unresolvedBlockingFindings.length > 0) {
            commentParts.push("\n## Unresolved Blocking Review Findings\n");
            for (const f of unresolvedBlockingFindings) {
              commentParts.push(`- **[${f.category}]** \`${f.file}:${f.line}\` — ${f.description}\n  Fix: ${f.fix}`);
            }
          }

          commentParts.push("\n---\n*This is a draft PR because the pipeline could not fully satisfy all requirements. A human reviewer should address the gaps above, then mark the PR as ready for review.*");

          try {
            // Use gh CLI to add the comment (works for all providers)
            const { execFile: ef } = await import("node:child_process");
            await new Promise<void>((resolve) => {
              ef("gh", ["pr", "comment", prUrl, "--body", commentParts.join("\n")],
                { cwd: wtPath, timeout: 15_000 },
                (error, _stdout, stderr) => {
                  if (error) {
                    runLog.error({ err: stderr || error.message, prUrl }, "draft PR: failed to add gap comment");
                  }
                  resolve(); // non-fatal — PR is still created
                },
              );
            });
          } catch (commentErr) {
            runLog.warn({ err: commentErr }, "failed to add PR comment for draft — continuing");
          }

          // Notify for human review (urateam#108: don't claim "N unmet
          // criteria" when N is actually an evaluator-error count).
          const ralphSummary = ralphEvaluationFailed
            ? "RALPH evaluation failed"
            : `${ralphGaps.length} unmet acceptance criteria`;
          await this.notifier.onHumanReviewNeeded?.(
            run,
            prUrl,
            `Draft PR created — ${ralphSummary}, ${unresolvedBlockingFindings.length} blocking findings`,
          );
        }

        // 6. Auto-merge (skip drafts, unresolved conflicts, or GitLab)
        const maxLines = config.autoMergeMaxLines ?? 200;
        const isGitLabRepo = repoConfig.provider === "gitlab";
        if (config.autoMerge && prUrl && !rebaseConflict && !isGitLabRepo && !shouldDraft) {
          const diffLines = await getDiffLineCount(wtPath, repoConfig.defaultBranch);
          const lastHandoff = handoff;
          const hasBlockingFindings = lastHandoff?.context?.reviewFindings?.some(
            (f) => f.severity === "blocking",
          );

          // Check file exclusion patterns (e.g. migrations, infra changes require human review)
          const excludePatterns = config.autoMergeExcludePatterns ?? [];
          let excludedFile: string | undefined;
          if (excludePatterns.length > 0) {
            const changedFiles = await getChangedFiles(wtPath, repoConfig.defaultBranch);
            excludedFile = changedFiles.find((f) => matchesAnyPattern(f, excludePatterns));
          }

          let autoMergeReason: string | undefined;
          let shouldMerge = true;
          if (diffLines > maxLines) {
            autoMergeReason = `Diff too large (${diffLines} lines, max ${maxLines})`;
            shouldMerge = false;
          } else if (hasBlockingFindings) {
            autoMergeReason = "Blocking review findings detected";
            shouldMerge = false;
          } else if (excludedFile !== undefined) {
            autoMergeReason = `File matches exclusion pattern: ${excludedFile}`;
            shouldMerge = false;
          }

          // Mandatory reviewer gate (enterprise feature 4.6).
          //
          // Known limitation: the reviewer check requires an Octokit API
          // client (to call pulls.listReviews / teams.listMembersInOrg), so
          // it only fires when the GitHub App is configured. The `gh` CLI
          // fallback and GitLab paths skip this check — documented in the
          // plan as acceptable because production deployments use the App.
          if (shouldMerge && isFeatureLicensed("org-policy")) {
            const policyReviewerRequest = buildReviewerRequest(config.policy);
            if (policyReviewerRequest) {
              if (!this.githubConfig) {
                runLog.info(
                  "org-policy reviewer gate: no GitHub App configured, skipping reviewer approval check on auto-merge (gh CLI path has no API client)",
                );
              } else {
                const ownerRepoMatch = repoConfig.url.match(
                  /github\.com[:/]([^/]+)\/([^/.]+)/,
                );
                const owner = ownerRepoMatch?.[1];
                const repo = ownerRepoMatch?.[2];
                const prNumberMatch = prUrl?.match(/\/pull\/(\d+)/);
                const prNumber = prNumberMatch
                  ? parseInt(prNumberMatch[1]!, 10)
                  : undefined;

                if (owner && repo && prNumber) {
                  try {
                    const octokit = await createGitHubClient(this.githubConfig);
                    const check = await verifyApprovalsReceived(
                      octokit as any,
                      owner,
                      repo,
                      prNumber,
                      policyReviewerRequest,
                    );
                    if (!check.satisfied) {
                      shouldMerge = false;
                      autoMergeReason = `mandatory reviewers pending: users=${check.missingUsers.join(",") || "none"} teams=${check.missingTeams.join(",") || "none"}`;
                      runLog.info(
                        {
                          missingUsers: check.missingUsers,
                          missingTeams: check.missingTeams,
                        },
                        "auto-merge skipped: mandatory reviewers not yet approved",
                      );
                    }
                  } catch (err) {
                    runLog.warn(
                      { err },
                      "org-policy reviewer gate: verifyApprovalsReceived failed — skipping auto-merge to be safe",
                    );
                    shouldMerge = false;
                    autoMergeReason =
                      "mandatory reviewers check failed — requires manual verification";
                  }
                }
              }
            }
          }

          if (shouldMerge) {
            runLog.info({ diffLines, maxLines }, "auto-merge eligible, merging PR");
            autoMerged = await mergePRViaCli(wtPath, branch);
            if (autoMerged) {
              autoMergeReason = "PR auto-merged successfully";
              runLog.info({ prUrl }, "PR auto-merged");
            } else {
              autoMergeReason = "Auto-merge command failed";
              runLog.warn("auto-merge failed, sending human review alert");
              await this.notifier.onHumanReviewNeeded?.(run, prUrl, "Auto-merge failed — please merge manually");
            }
          } else {
            runLog.info({ diffLines, maxLines, hasBlockingFindings, excludedFile }, `skipping auto-merge: ${autoMergeReason}`);
            await this.notifier.onHumanReviewNeeded?.(run, prUrl, autoMergeReason!);
          }

          // Persist auto-merge decision to DB for audit log
          run.autoMerged = autoMerged;
          run.autoMergeReason = autoMergeReason;
        }
          }, // end withBranchLock fn
        ); // end withBranchLock
      }); // end pushQueue.enqueue

      await db
        .update(pipelineRuns)
        .set({
          status: "completed",
          completedAt: new Date(),
          totalInputTokens: run.totalInputTokens,
          totalOutputTokens: run.totalOutputTokens,
          prUrl: prUrl || null,
          autoMerged: run.autoMerged ?? null,
          autoMergeReason: run.autoMergeReason ?? null,
          autoCommitted: run.autoCommitted ?? null,
        })
        .where(eq(pipelineRuns.id, runId));
      run.status = "completed";

      const totalStageRetries = run.stageRetries
        ? Object.values(run.stageRetries).reduce((a, b) => a + b, 0)
        : 0;
      runLog.info(
        {
          prUrl: prUrl || undefined,
          autoMerged,
          autoCommitted: run.autoCommitted ?? false,
          totalInputTokens: run.totalInputTokens,
          totalOutputTokens: run.totalOutputTokens,
          ...(totalStageRetries > 0
            ? { stageRetries: run.stageRetries, totalStageRetries }
            : {}),
        },
        "pipeline completed",
      );
      await this.notifier.onPipelineComplete(run, {
        prUrl,
        totalInputTokens: run.totalInputTokens,
        totalOutputTokens: run.totalOutputTokens,
        stagesCompleted: config.stages.filter((s) => s !== "await-approval")
          .length,
        autoMerged,
      });

      // BEC-175: optional per-PR cost summary comment. Opt-in via
      // URATEAM_PR_COST_SUMMARY=true. Best-effort — failures never block
      // pipeline completion.
      if (
        process.env.URATEAM_PR_COST_SUMMARY === "true" &&
        prUrl &&
        repoConfig.provider !== "gitlab" &&
        this.githubConfig
      ) {
        try {
          const summaryPrMatch = prUrl.match(/\/pull\/(\d+)/);
          const summaryPrNumber = summaryPrMatch
            ? parseInt(summaryPrMatch[1]!, 10)
            : null;
          if (summaryPrNumber !== null) {
            const stages = await (this.db as AnyDb)
              .select()
              .from(stageRuns)
              .where(eq(stageRuns.pipelineRunId, runId));
            const stageIds = stages.map((s: { id: string }) => s.id);
            const modelRows =
              stageIds.length > 0
                ? await (this.db as AnyDb)
                    .select()
                    .from(reviewModelRuns)
                    .where(inArray(reviewModelRuns.stageRunId, stageIds))
                : [];
            const modelsByStage = new Map<
              string,
              Array<{ modelId: string; inputTokens: number; outputTokens: number }>
            >();
            for (const mr of modelRows) {
              const arr = modelsByStage.get(mr.stageRunId) ?? [];
              arr.push({
                modelId: mr.modelId,
                inputTokens: mr.inputTokens,
                outputTokens: mr.outputTokens,
              });
              modelsByStage.set(mr.stageRunId, arr);
            }
            const breakdown: StageCostBreakdown[] = stages.map((s: any) => ({
              stage: s.stage,
              inputTokens: s.inputTokens,
              outputTokens: s.outputTokens,
              cacheCreationInputTokens: s.cacheCreationInputTokens ?? 0,
              cacheReadInputTokens: s.cacheReadInputTokens ?? 0,
              modelRuns: modelsByStage.get(s.id),
            }));
            const body = formatPRCostSummary(breakdown, run.pipelineKey, {
              pipelineConfigs: { [run.pipelineKey]: config },
            });
            if (body) {
              const { owner: summaryOwner, repo: summaryRepo } = parseRepoUrl(
                repoConfig.url,
              );
              const summaryOctokit = await createGitHubClient(this.githubConfig);
              // Dedup: skip when a prior pipeline run on this PR already
              // posted a cost summary. We use the markdown header as the
              // sentinel so the check survives any token/dollar diff between
              // runs.
              const alreadyPosted = await prHasCommentStartingWith(
                summaryOctokit,
                summaryOwner,
                summaryRepo,
                summaryPrNumber,
                "🤖 **Pipeline cost summary**",
              );
              if (alreadyPosted) {
                runLog.info(
                  { prNumber: summaryPrNumber },
                  "BEC-175: cost summary already exists on PR — skipping",
                );
              } else {
                await addPRComment(
                  summaryOctokit,
                  summaryOwner,
                  summaryRepo,
                  summaryPrNumber,
                  body,
                );
                runLog.info(
                  { prNumber: summaryPrNumber },
                  "BEC-175: posted PR cost summary",
                );
              }
            }
          }
        } catch (err) {
          runLog.warn(
            { err: err instanceof Error ? err.message : String(err) },
            "BEC-175: PR cost summary post failed (non-fatal)",
          );
        }
      }

      // PR change-summary comment for review-feedback runs. Always-on (no env
      // flag) — a review-feedback run only exists because a human asked for
      // changes, so silent shipping is a bug.
      if (
        run.runType === "review-feedback" &&
        prUrl &&
        repoConfig.provider !== "gitlab" &&
        this.githubConfig
      ) {
        try {
          const summaryPrMatch = prUrl.match(/\/pull\/(\d+)/);
          const summaryPrNumber = summaryPrMatch
            ? parseInt(summaryPrMatch[1]!, 10)
            : null;
          const { owner: csOwner, repo: csRepo } = parseRepoUrl(repoConfig.url);
          const csOctokit = await createGitHubClient(this.githubConfig);
          await maybePostChangeSummary({
            run: {
              id: run.id,
              runType: run.runType,
              prUrl: run.prUrl,
              feedbackContext: run.feedbackContext ?? null,
              totalInputTokens: run.totalInputTokens,
              totalOutputTokens: run.totalOutputTokens,
            },
            handoff: handoff ?? null,
            prNumber: summaryPrNumber,
            owner: csOwner,
            repo: csRepo,
            octokit: csOctokit,
            postPRComment: addPRComment,
            dashboardBaseUrl: process.env.URATEAM_DASHBOARD_URL ?? "",
            logger: runLog,
          });
        } catch (err) {
          runLog.warn(
            { err: err instanceof Error ? err.message : String(err) },
            "PR change summary post failed (non-fatal)",
          );
        }
      }
    } catch (error) {
      // If failPipeline was already called inside the push queue (e.g. failOnAutoCommit
      // path), run.status will already be "failed" or "retriable". Skip to avoid
      // double-calling failPipeline with a misleading "unknown" stage.
      if ((run.status as string) !== "failed" && (run.status as string) !== "retriable") {
        const errorMsg = error instanceof Error ? error.message : String(error);
        runLog.error({ err: error }, "pipeline failed with unexpected error");
        await this.failPipeline(db, runId, run, "unknown", errorMsg, true, {
          worktreePath,
          currentStageIndex: lastStageIndex,
          handoff,
          pipelineConfig: config,
          repoConfig,
          sanitizedIssue,
        });
      }
    } finally {
      // Clean up budget tracking and active file tracking for this run
      this.budgetAlertedRuns.delete(runId);
      // Remove from coordination table — run is done (success or failure)
      await removeActiveWork(db, runId);
      // Clean up devcontainer first (before worktree removal)
      if (devcontainerSession) {
        try {
          await devcontainerDown(devcontainerSession);
        } catch {
          // Ignore cleanup errors
        }
      }
      const finalStatus = run.status as PipelineRunStatus;
      if (worktreePath && (finalStatus === "completed" || finalStatus === "failed")) {
        try {
          await deleteWorktree(worktreePath);
        } catch {
          // Ignore cleanup errors
        }
      }
    }
  }

  private async failPipeline(
    db: AnyDb,
    runId: string,
    run: PipelineRun,
    stage: string,
    errorMsg: string,
    retriesExhausted: boolean,
    context?: {
      worktreePath?: string;
      currentStageIndex?: number;
      handoff?: HandoffArtifact;
      pipelineConfig?: PipelineConfig;
      repoConfig?: RepoConfig;
      sanitizedIssue?: SanitizedIssue;
    },
  ): Promise<void> {
    const runLog = createLogger({ component: "PipelineRunner", runId, issueId: run.issueId });

    // Check if this is a transient error that can be retried
    const currentRetryCount = (run as any).retryCount ?? 0;
    if (
      isTransientError(errorMsg) &&
      currentRetryCount < MAX_TRANSIENT_RETRIES &&
      context?.worktreePath &&
      context.currentStageIndex != null &&
      context.pipelineConfig &&
      context.repoConfig &&
      context.sanitizedIssue
    ) {
      const resumePayload = JSON.stringify({
        handoff: context.handoff ?? null,
        pipelineConfig: context.pipelineConfig,
        repoConfig: context.repoConfig,
        sanitizedIssue: context.sanitizedIssue,
        worktreePath: context.worktreePath,
      });

      // Store currentStageIndex - 1 so the existing resume path's
      // `slice(startStageIndex + 1)` lands back on the failed stage.
      // (await-approval stores the completed stage index; we need to re-run the failed one.)
      // No floor clamp: -1 is valid when stage 0 fails, since slice(-1+1) = slice(0)
      // re-runs the full stage list. The await-approval path stores the completed
      // stage index; we store failedIndex - 1 so the same +1 offset re-runs the failed stage.
      const resumeStageIndex = (context.currentStageIndex ?? 0) - 1;

      await db
        .update(pipelineRuns)
        .set({
          status: "retriable",
          currentStageIndex: resumeStageIndex,
          resumePayload,
          retryCount: currentRetryCount + 1,
          errorMessage: errorMsg,
        })
        .where(eq(pipelineRuns.id, runId));
      run.status = "retriable" as any;

      runLog.warn(
        { stage, retryCount: currentRetryCount + 1, maxRetries: MAX_TRANSIENT_RETRIES },
        "transient failure — marked as retriable, worktree preserved",
      );
      return;
    }

    // Permanent failure — original behavior
    await db
      .update(pipelineRuns)
      .set({
        status: "failed",
        completedAt: new Date(),
        errorMessage: errorMsg,
      })
      .where(eq(pipelineRuns.id, runId));
    run.status = "failed";
    await this.notifier.onPipelineFailed(run, {
      stage,
      message: errorMsg,
      retriesExhausted,
    });
  }

  /**
   * Check token budget and send alert/fail as needed. Returns true if the budget
   * has been exceeded and the pipeline should abort.
   */
  private async checkTokenBudget(
    db: AnyDb,
    runId: string,
    run: PipelineRun,
    config: PipelineConfig,
    currentStage: string,
  ): Promise<boolean> {
    if (!config.maxTokens) return false;

    const totalUsed = run.totalInputTokens + run.totalOutputTokens;

    // One-time 80% threshold alert
    if (
      totalUsed >= config.maxTokens * 0.8 &&
      !this.budgetAlertedRuns.has(runId)
    ) {
      this.budgetAlertedRuns.add(runId);
      await this.notifier.onTokenBudgetAlert?.(run, totalUsed, config.maxTokens);
    }

    // Hard limit — fail the pipeline
    if (totalUsed >= config.maxTokens) {
      await this.failPipeline(
        db,
        runId,
        run,
        currentStage,
        `Token budget exceeded: ${totalUsed.toLocaleString()} used of ${config.maxTokens.toLocaleString()} max`,
        false,
      );
      return true;
    }

    return false;
  }

  /**
   * Recover pipeline runs that were interrupted by a previous server restart.
   *
   * Queries for any runs with status 'running' or 'queued' that are NOT
   * currently tracked in the in-memory activeRuns map (i.e. they belong to a
   * previous process). For each such run the method:
   *   1. Checks whether the worktree still exists on disk.
   *   2. Marks the run as 'failed' with a descriptive error message.
   *   3. Removes the corresponding active_work coordination row.
   *   4. Emits a structured warning log entry.
   *
   * After processing all stuck runs the method runs `git worktree prune` on
   * every repository clone directory to remove stale worktree administrative
   * entries that git still knows about.
   *
   * Call this once, early in the startup sequence, before the webhook server
   * begins accepting requests.
   */
  async recoverStuckRuns(): Promise<void> {
    const db = this.db as AnyDb;

    // Collect runIds that are actively managed by this process.
    const activeRunIds = new Set(this.activeRuns.values());

    // Find all runs that were left in a non-terminal state.
    const stuckRuns = await db
      .select()
      .from(pipelineRuns)
      .where(
        or(
          eq(pipelineRuns.status, "running"),
          eq(pipelineRuns.status, "queued"),
        ),
      );

    // Only recover runs older than 5 minutes to avoid killing legitimately
    // running pipelines during rolling updates or concurrent starts.
    const minAgeMs = 5 * 60 * 1000;
    const cutoff = Date.now() - minAgeMs;

    await Promise.all(
      stuckRuns
        .filter((run: (typeof stuckRuns)[number]) => {
          if (activeRunIds.has(run.id)) return false;
          const startedAt = run.startedAt instanceof Date
            ? run.startedAt.getTime()
            : Number(run.startedAt) * 1000;
          return startedAt < cutoff;
        })
        .map(async (run: (typeof stuckRuns)[number]) => {
          // The worktree path is deterministically derived from agentRunDir + runId.
          const expectedWorktreePath = join(this.agentRunDir, run.id, "worktree");

          let worktreeExists = false;
          try {
            await access(expectedWorktreePath);
            worktreeExists = true;
          } catch {
            // Worktree directory is gone — expected after a container restart.
          }

          const errorMsg = worktreeExists
            ? `Pipeline interrupted by server restart; worktree present at ${expectedWorktreePath}`
            : `Pipeline interrupted by server restart; worktree not found at ${expectedWorktreePath}`;

          log.warn(
            {
              runId: run.id,
              issueId: run.issueId,
              priorStatus: run.status,
              worktreeExists,
            },
            "recovering stuck pipeline run from previous restart",
          );

          await db
            .update(pipelineRuns)
            .set({
              status: "failed",
              errorMessage: errorMsg,
            })
            .where(eq(pipelineRuns.id, run.id));

          await removeActiveWork(db, run.id);
        }),
    );

    // Prune stale worktree administrative entries from every known repo clone.
    await this.pruneAllWorktreeRefs();
  }

  /**
   * Run `git worktree prune` on every repository directory found under
   * repoCloneDir. BEC-180: skips entries with no `.git/` (e.g. the BEC-174
   * `.agent-sweep/` parent dir) so they don't produce noisy ERROR logs.
   */
  private async pruneAllWorktreeRefs(): Promise<void> {
    await pruneWorktreesInRepoDirs(this.repoCloneDir);
  }

  /**
   * Query the DB for all runs on a given date and emit a DailyTokenSummary
   * notification. Defaults to today (UTC).
   */
  async sendDailyTokenSummary(date?: Date): Promise<void> {
    const target = date ?? new Date();
    const isoDate = target.toISOString().slice(0, 10);

    const dayStart = new Date(`${isoDate}T00:00:00Z`);
    const dayEnd = new Date(dayStart);
    dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

    const db = this.db as AnyDb;

    const rows = await db
      .select({
        totalIn: sql<number>`coalesce(sum(${pipelineRuns.totalInputTokens}), 0)`,
        totalOut: sql<number>`coalesce(sum(${pipelineRuns.totalOutputTokens}), 0)`,
        completed: sql<number>`coalesce(sum(case when ${pipelineRuns.status} = 'completed' then 1 else 0 end), 0)`,
        failed: sql<number>`coalesce(sum(case when ${pipelineRuns.status} = 'failed' then 1 else 0 end), 0)`,
      })
      .from(pipelineRuns)
      .where(
        and(
          gte(pipelineRuns.startedAt, dayStart),
          lt(pipelineRuns.startedAt, dayEnd),
        ),
      );

    const row = rows[0] ?? { totalIn: 0, totalOut: 0, completed: 0, failed: 0 };
    const summary: DailyTokenSummary = {
      date: isoDate,
      totalInputTokens: Number(row.totalIn),
      totalOutputTokens: Number(row.totalOut),
      runsCompleted: Number(row.completed),
      runsFailed: Number(row.failed),
    };

    await this.notifier.onDailyTokenSummary?.(summary);
  }

  private buildPipelineRun(
    runId: string,
    issue: LinearIssue,
    pipelineKey: string,
    repoConfig: RepoConfig,
    branch: string,
  ): PipelineRun {
    return {
      id: runId,
      issueId: issue.identifier,
      issueTitle: issue.title,
      pipelineKey,
      repoUrl: repoConfig.url,
      branch,
      status: "queued",
      startedAt: new Date(),
      totalInputTokens: 0,
      totalOutputTokens: 0,
    };
  }
}
