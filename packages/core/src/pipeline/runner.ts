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
  ResumePayload,
} from "../types.js";
import { ResumePayloadSchema } from "../types.js"; // value import — cannot be `import type`
import type { Db, AnyDb } from "../db/client.js";
import { pipelineRuns, stageRuns, reviewModelRuns } from "../db/schema.js";
import {
  formatPRCostSummary,
  type StageCostBreakdown,
} from "./cost-summary.js";
import { executeStage } from "../executor/executor.js";
import { validateHandoff, type ValidateRunMode } from "../executor/validate.js";
import { isFeatureLicensed } from "../license.js";
import { checkRequirements, buildRalphContext } from "../executor/ralph.js";
import { computeEffectiveRalphIterations } from "./runner-ralph-helpers.js";
import { checkTestQuality } from "../executor/test-quality.js";
import {
  buildDeepReviewContext,
  checkDeepReviewConvergence,
  buildFindingFingerprint,
  buildNonConvergenceDiagnostic,
} from "../executor/deep-review.js";
import { getStopSignal, requestStop, clearStopSignal, type StopMode } from "./control-signals.js";
import { setPmPaused } from "../pm/pause-state.js";
import { runReviewProviders } from "./review-providers-runner.js";
import { postFanoutCommentsToPR } from "../executor/review/post-fanout-comments.js";
import type { ReviewModelRun } from "../executor/review/review-provider.js";
import { extractHandoff } from "../executor/extract-handoff.js";
import { DEFAULT_AGENT_CLAUDE_MD } from "../executor/agent-config.js";
import { generatePRDescription, type TriageQualityMetric } from "./pr-description.js";
import { maybePostChangeSummary } from "./pr-change-summary.js";
import { access, writeFile, appendFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
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
  deleteRemoteBranch,
  branchName,
  createWorktreeFromRemote,
  pruneWorktreesInRepoDirs,
  gitExecSafe,
} from "../repo/git.js";
import { classifyExistingBranch } from "./branch-classifier.js";
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
  addMRComment,
  mergeMRWhenPipelineSucceeds,
  type GitLabConfig,
} from "../repo/gitlab.js";
import {
  buildBitbucketAuthenticatedUrl,
  createBitbucketPR,
  addBitbucketPRComment,
  mergeBitbucketPR,
  parseBitbucketUrl,
  type BitbucketConfig,
} from "../repo/bitbucket.js";
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
import { randomUUID } from "node:crypto";
import { isAgentSessionResumeEnabled, isAlwaysFreshStage } from "../executor/session-policy.js";
import { createLogger, runWithLogContext } from "../logger.js";
import { isTransientError, MAX_TRANSIENT_RETRIES } from "./error-classifier.js";
import { evaluatePolicyGates } from "../policy/evaluate.js";
import { buildReviewerRequest, verifyApprovalsReceived } from "../policy/index.js";
import {
  logAuditEvent,
  policyReviewersRequestedEvent,
  reviewFanoutFallbackUsedEvent,
  pipelineScratchFilesBlockedEvent,
  pipelineTypecheckFailedEvent,
  pipelineSpecVsImplFailedEvent,
  pipelineAutoDeepReviewBumpedEvent,
  pmTriageQualityScoreEvent,
  pipelineStaleBranchRecoveredEvent,
  pipelineSkippedExistingBranchEvent,
  agentSessionCreatedEvent,
} from "../audit/index.js";
import {
  computeAffectedFilesPredictionQuality,
  isTier6eDisabled,
} from "../pm/triage-prediction-quality.js";
import { getTriageResult } from "../pm/triage-results-store.js";
import { matchesAnyPattern } from "../util/glob.js";
import { findScratchFiles } from "./scratch-file-guard.js";
import { runTypecheck } from "./typecheck-gate.js";
import { checkSpecVsImpl } from "./spec-vs-impl-gate.js";
import {
  countNewPublicExports,
  shouldAutoDeepReview,
  DEFAULT_AUTO_DEEP_REVIEW_THRESHOLDS,
} from "./auto-deep-review.js";
import {
  startFeedbackPipeline,
  type FeedbackStartContext,
} from "./feedback-pipeline.js";
import { runSurgicalReviewFix } from "./run-surgical-review-fix.js";

// Re-export from extracted module so existing callers (including tests) still
// find buildReviewFeedbackContext at pipeline/runner.js without changing their
// import paths.
export { buildReviewFeedbackContext } from "./feedback-pipeline.js";

// Module-level logger (no runId yet — used for pre-run messages)
const log = createLogger({ component: "PipelineRunner" });

/**
 * Serialise a resume payload to the JSON string stored in
 * `pipeline_runs.resume_payload`.  Both the await-approval pause path and the
 * transient-failure retry path use this helper so their serialization stays in
 * sync with `ResumePayloadSchema` — a single place to update if the schema
 * evolves.
 */
function buildResumePayload(
  handoff: HandoffArtifact | null,
  pipelineConfig: PipelineConfig,
  repoConfig: RepoConfig,
  sanitizedIssue: SanitizedIssue,
  worktreePath: string,
  currentStageIndex: number,
): string {
  return JSON.stringify({
    handoff,
    pipelineConfig,
    repoConfig,
    sanitizedIssue,
    worktreePath,
    currentStageIndex,
  } satisfies ResumePayload);
}

export interface PipelineRunnerConfig {
  db: Db;
  notifier: Notifier;
  concurrency?: number; // default 3
  agentRunDir?: string; // default $HOME/data/runs
  repoCloneDir?: string; // default $HOME/work/repos
  github?: GitHubConfig; // optional — PR creation skipped if not provided
  gitlab?: GitLabConfig; // optional — GitLab MR creation
  bitbucket?: BitbucketConfig; // optional — Bitbucket PR creation
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
  private bitbucketConfig?: BitbucketConfig;
  private lockAdapter: LockAdapter;
  private prLockTimeoutMs: number;
  /** Memoised Octokit promise — created once per PipelineRunner instance. */
  private _octokitPromise?: ReturnType<typeof createGitHubClient>;

  constructor(config: PipelineRunnerConfig) {
    this.db = config.db;
    this.notifier = config.notifier;
    this.queue = createQueue(config.concurrency ?? 3);
    this.pushQueue = createQueue(1);
    this.agentRunDir = config.agentRunDir ?? join(homedir(), "data", "runs");
    this.repoCloneDir = config.repoCloneDir ?? join(homedir(), "work", "repos");
    this.githubConfig = config.github;
    this.gitlabConfig = config.gitlab;
    this.bitbucketConfig = config.bitbucket;
    this.lockAdapter = createBranchLockAdapter(config.db as AnyDb);
    this.prLockTimeoutMs = config.prLockTimeoutMs ?? 120_000;
  }

  /**
   * Lazy-memoised Octokit instance — created at most once per PipelineRunner.
   * Multiple concurrent callers share the same Promise so construction happens
   * exactly once even under parallel await.
   */
  private getOctokit(): ReturnType<typeof createGitHubClient> {
    if (!this._octokitPromise) {
      if (!this.githubConfig) throw new Error("githubConfig required for Octokit");
      this._octokitPromise = createGitHubClient(this.githubConfig);
    }
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return this._octokitPromise!;
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

    // Check for existing remote branch and classify its state (BEC-222).
    const existingBranch = await checkDuplicateBranch(repoConfig.url, issue.identifier);
    // Track whether we recovered a stale branch; if so emit audit event after
    // the runId is created.
    let staleBranchToAudit: string | undefined;

    if (existingBranch) {
      const db_ = this.db as AnyDb;
      const classification = await classifyExistingBranch(repoConfig, existingBranch, db_);

      if (classification.state === "active-run") {
        // A live run holds this branch — preserve existing skip behaviour.
        log.info(
          { issueId: issue.identifier, existingBranch, activeRunId: classification.runId },
          "skipping — active run already holds this branch",
        );
        await logAuditEvent(db_, pipelineSkippedExistingBranchEvent({
          issueId: issue.identifier,
          branch: existingBranch,
          reason: "active-run",
          activeRunId: classification.runId,
        }));
        return;
      }

      if (classification.state === "open-pr") {
        // An open PR already exists — the issue is in review.  Don't restart
        // from scratch; wait for a PR review comment to trigger feedback run.
        log.info(
          { issueId: issue.identifier, existingBranch, prNumber: classification.prNumber },
          "skipping — open PR already exists for this branch",
        );
        await logAuditEvent(db_, pipelineSkippedExistingBranchEvent({
          issueId: issue.identifier,
          branch: existingBranch,
          reason: "open-pr",
          prNumber: classification.prNumber,
        }));
        return;
      }

      // state === "stale": dead branch from a prior failed/cancelled run.
      // Delete it and proceed with a fresh pipeline start.
      log.info(
        { issueId: issue.identifier, existingBranch },
        "stale remote branch detected — deleting and retrying from scratch",
      );
      const cloneUrlForDelete = (repoConfig.provider === "gitlab" && this.gitlabConfig)
        ? buildAuthenticatedUrl(repoConfig.url, this.gitlabConfig)
        : (repoConfig.provider === "bitbucket" && this.bitbucketConfig)
          ? buildBitbucketAuthenticatedUrl(repoConfig.url, this.bitbucketConfig)
          : repoConfig.url;
      try {
        await deleteRemoteBranch(cloneUrlForDelete, existingBranch);
      } catch (err) {
        // Best-effort: if delete fails (e.g. auth not available for plain URL),
        // log and continue.  pushBranchForce will overwrite the stale branch
        // via --force-with-lease at push time.
        log.warn({ err, branch: existingBranch }, "deleteRemoteBranch failed — will overwrite via force-push");
      }
      staleBranchToAudit = existingBranch;
    }

    const runId = nanoid();
    // BEC-227: mint a per-run agent session UUID when the flag is on. The
    // first resumable stage opens its SDK session with this id; downstream
    // stages reuse it via `resume:`. Read env at call time so flipping the
    // var takes effect on the next pipeline run without a daemon restart.
    const agentSessionId = isAgentSessionResumeEnabled() ? randomUUID() : null;
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
        agentSessionId, // null when flag is off; UUID when BEC-227 is enabled
      });
    runLog.info({ branch }, "run queued");

    // Emit stale-branch recovery audit event now that we have a runId.
    if (staleBranchToAudit) {
      await logAuditEvent(db, pipelineStaleBranchRecoveredEvent({
        issueId: issue.identifier,
        branch: staleBranchToAudit,
        runId,
      }));
    }

    if (agentSessionId !== null) {
      void logAuditEvent(
        db,
        agentSessionCreatedEvent({
          runId,
          issueId: issue.identifier,
          sessionId: agentSessionId,
        }),
      );
    }

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
            undefined,
            agentSessionId,
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

    // Look up a paused or retriable run in the DB for this issue.
    // "paused" = awaiting approval; "retriable" = transient failure awaiting manual retry.
    const db = this.db as AnyDb;
    const rows = await db
      .select()
      .from(pipelineRuns)
      .where(
        and(
          eq(pipelineRuns.issueId, issueId),
          inArray(pipelineRuns.status, ["paused", "retriable"]),
        ),
      )
      .limit(1);

    if (rows.length === 0) {
      resumeLog.info("resume() called but no paused or retriable run found in DB — no-op");
      return;
    }

    const pausedRun = rows[0];
    const runId = pausedRun.id;
    const runLog = createLogger({ component: "PipelineRunner", runId, issueId });

    // Claim the slot immediately to prevent concurrent resume() calls
    this.activeRuns.set(issueId, runId);

    // For retriable runs: flip status to "paused" so the PM tick's
    // recoverRetriableRuns() won't find and double-recover this run while
    // execution is queued. The paused-run execution path is identical.
    if (pausedRun.status === "retriable") {
      await db
        .update(pipelineRuns)
        .set({ status: "paused" })
        .where(eq(pipelineRuns.id, runId));
    }

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

    // Parse and validate the resume payload using the Zod schema.
    // This replaces the former hand-rolled property-existence checks and catches
    // schema mismatches from older DB rows (e.g. missing handoff, wrong types)
    // before any git or executor operations run.
    //
    // BC: paused runs created before currentStageIndex was added to the payload
    // schema (BEC-192) only have it on the DB row. Inject it from the DB column
    // so those existing in-flight runs don't get falsely failed on first resume
    // after deploy.
    let parsed: ReturnType<typeof ResumePayloadSchema.safeParse>;
    try {
      const raw = JSON.parse(pausedRun.resumePayload) as Record<string, unknown>;
      if (raw.currentStageIndex === undefined && pausedRun.currentStageIndex != null) {
        raw.currentStageIndex = pausedRun.currentStageIndex;
      }
      parsed = ResumePayloadSchema.safeParse(raw);
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

    if (!parsed.success) {
      const zodErrors = parsed.error.issues
        .map((e) => `${e.path.join(".") || "(root)"}: ${e.message}`)
        .join("; ");
      runLog.error({ zodErrors }, "resume payload failed schema validation — failing run");
      await db
        .update(pipelineRuns)
        .set({
          status: "failed",
          completedAt: new Date(),
          errorMessage: `Invalid resume payload structure — cannot resume: ${zodErrors}`,
        })
        .where(eq(pipelineRuns.id, runId));
      this.activeRuns.delete(issueId);
      return;
    }

    const { handoff, pipelineConfig, repoConfig, sanitizedIssue, worktreePath, currentStageIndex } = parsed.data;

    // Path containment check — worktreePath must be within agentRunDir.
    // We append sep to agentRunDir before the startsWith check so that a
    // crafted path like /home/ura/data/runs-evil cannot slip past as a prefix match
    // of /home/ura/data/runs.  An exact match (resolvedPath === this.agentRunDir)
    // is also accepted for symmetry, even though real worktrees are always subdirs.
    const resolvedPath = resolve(worktreePath); // canonicalize — collapses .. segments
    const normalizedBase = this.agentRunDir.endsWith(sep)
      ? this.agentRunDir
      : this.agentRunDir + sep;
    if (!resolvedPath.startsWith(normalizedBase) && resolvedPath !== this.agentRunDir) {
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
      retryCount: pausedRun.retryCount ?? 0,
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
      { stageIndex: currentStageIndex, worktreePath },
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
              startStageIndex: currentStageIndex,
              worktreePath,
              initialHandoff: handoff ?? undefined,
              // BEC-227 — carry the per-run SDK session id across the
              // await-approval pause so the post-resume stages keep
              // talking to the same transcript.
              agentSessionId: pausedRun.agentSessionId ?? null,
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
    await this.cancelRunningStageRuns(db, runId);
    this.activeRuns.delete(issueId);
  }

  /**
   * Operator-initiated stop for a single run, addressed by runId.
   *
   * - `"cancel"` aborts the active Agent SDK stream immediately. The current
   *   stage exits with `status: "cancelled"`; the pipeline marks the run
   *   `cancelled` and returns without creating a PR.
   * - `"graceful"` lets the current stage complete, then skips remaining
   *   stages. Slower than cancel but leaves the worktree consistent.
   *
   * Idempotent. Returns the issueId resolved from the active map (or null if
   * the runId isn't currently active). The caller is responsible for emitting
   * the audit event since it knows the actor.
   */
  requestStop(runId: string, mode: StopMode): { issueId: string | null; mode: StopMode } {
    let issueId: string | null = null;
    for (const [iss, rid] of this.activeRuns) {
      if (rid === runId) {
        issueId = iss;
        break;
      }
    }
    const effective = requestStop(runId, mode);
    return { issueId, mode: effective };
  }

  /**
   * Halt the whole container's autonomous work:
   *  1. Pauses the PM Agent (BEC-170 mechanism) so no new runs get promoted.
   *  2. Sends a `"cancel"` signal to every active pipeline + feedback run.
   *
   * Returns the set of run ids that were cancelled — the caller emits the
   * audit event. Reversible: PM Agent can be unpaused via `/pm resume` and
   * individual runs can be re-triggered via the retry button. Cancelled runs
   * stay cancelled.
   */
  haltAll(): { cancelledRunIds: string[] } {
    setPmPaused(true);
    const cancelled = new Set<string>();
    for (const runId of this.activeRuns.values()) {
      requestStop(runId, "cancel");
      cancelled.add(runId);
    }
    for (const runId of this.activeFeedbackRuns.values()) {
      requestStop(runId, "cancel");
      cancelled.add(runId);
    }
    log.info(
      { count: cancelled.size, runIds: [...cancelled] },
      "haltAll: PM paused and cancel signals sent to active runs",
    );
    return { cancelledRunIds: [...cancelled] };
  }

  /**
   * Mark a run as cancelled in the DB and clean up bookkeeping. Shared by the
   * pre-stage graceful path and the mid-stream cancel path.
   *
   * For feedback-pipeline runs, pass `feedbackPrUrl` so the per-PR rate-limit
   * slot is freed immediately rather than waiting on the queue's `finally`
   * block. The queue's `finally` still fires (idempotent — Map.delete on a
   * missing key is a no-op), this just shortens the window during which a new
   * feedback comment on the same PR is rejected as "already active".
   */
  markRunCancelled(
    db: AnyDb,
    runId: string,
    run: PipelineRun,
    mode: StopMode,
    feedbackPrUrl?: string,
  ): Promise<void> {
    return this.markRunCancelledImpl(db, runId, run, mode, feedbackPrUrl);
  }

  private async markRunCancelledImpl(
    db: AnyDb,
    runId: string,
    run: PipelineRun,
    mode: StopMode,
    feedbackPrUrl?: string,
  ): Promise<void> {
    await removeActiveWork(db, runId);
    await db
      .update(pipelineRuns)
      .set({
        status: "cancelled",
        errorMessage: `cancelled by operator (${mode})`,
        completedAt: new Date(),
      })
      .where(eq(pipelineRuns.id, runId));
    await this.cancelRunningStageRuns(db, runId);
    run.status = "cancelled";
    this.activeRuns.delete(run.issueId);
    if (feedbackPrUrl) this.activeFeedbackRuns.delete(feedbackPrUrl);
    clearStopSignal(runId);
  }

  /**
   * BEC-250 — Cancel any stage_runs still in status='running' for the given
   * pipeline run. Called from every terminal-state transition so that orphaned
   * in-flight stage rows don't accumulate as permanent false positives in
   * dashboard / quality-observer queries.
   *
   * Idempotent: rows already in a terminal state are unaffected by the WHERE
   * clause. The PM sweep (sweepOrphanStageRuns) handles any that slip through
   * (e.g. process crash between the pipeline_run update and this call).
   */
  private async cancelRunningStageRuns(db: AnyDb, runId: string): Promise<void> {
    await (db as any)
      .update(stageRuns)
      .set({ status: "cancelled", completedAt: new Date() })
      .where(and(eq(stageRuns.pipelineRunId, runId), eq(stageRuns.status, "running")));
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
      bitbucketConfig: this.bitbucketConfig,
      pushQueue: this.pushQueue,
      lockAdapter: this.lockAdapter,
      prLockTimeoutMs: this.prLockTimeoutMs,
      budgetAlertedRuns: this.budgetAlertedRuns,
      checkTokenBudget: this.checkTokenBudget.bind(this),
      failPipeline: this.failPipeline.bind(this),
      injectAgentConfig: this.injectAgentConfig.bind(this),
      markRunCancelled: this.markRunCancelled.bind(this),
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
      /**
       * BEC-227 — per-run SDK session UUID carried across resume boundaries.
       * Null when the flag is off (or the original run was started before
       * BEC-227 was enabled). The resume path always re-reads it from the
       * paused pipeline_runs row so the same session id continues across
       * await-approval pauses.
       */
      agentSessionId: string | null;
    },
    /**
     * BEC-227 — per-run SDK session UUID minted at start(). Null when the
     * `URATEAM_ENABLE_AGENT_SESSION_RESUME` flag is off. On the resume path
     * this is ignored in favour of `resumeOptions.agentSessionId`.
     */
    agentSessionId: string | null = null,
  ): Promise<void> {
    const db = this.db as AnyDb;
    const runLog = createLogger({ component: "PipelineRunner", runId, issueId: run.issueId });

    // BEC-227 — resolve the session id from the resume path (preferred) or
    // the start() path. Tracks whether the first resumable stage in this run
    // has already opened the SDK session so subsequent stages switch from
    // `sessionId` (create) to `resume` (reuse). The flag stays scoped to a
    // single executePipeline() invocation: on resume after await-approval the
    // SDK session created in the pre-pause run has already been initiated, so
    // we start this second invocation with `hasInitiatedSession = true` —
    // every resumable stage uses the `resume:` shape, never re-creates the
    // session.
    const runAgentSessionId = resumeOptions
      ? resumeOptions.agentSessionId
      : agentSessionId;
    let hasInitiatedSession = !!resumeOptions;

    /**
     * Returns `true` for the first non-fresh stage in this run, flips the
     * `hasInitiatedSession` flag as a side effect. Always-fresh stages
     * (validate, ralph-check) never count as the first resumable stage —
     * they don't take a session id. Returns false when the flag is off
     * (`runAgentSessionId === null`).
     */
    const claimFirstResumableStage = (stage: string): boolean => {
      if (runAgentSessionId === null) return false;
      if (hasInitiatedSession) return false;
      if (isAlwaysFreshStage(stage)) return false;
      hasInitiatedSession = true;
      return true;
    };

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
        // Inject credentials for GitLab / Bitbucket private repos
        const cloneUrl = (repoConfig.provider === "gitlab" && this.gitlabConfig)
          ? buildAuthenticatedUrl(repoConfig.url, this.gitlabConfig)
          : (repoConfig.provider === "bitbucket" && this.bitbucketConfig)
            ? buildBitbucketAuthenticatedUrl(repoConfig.url, this.bitbucketConfig)
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

        // Operator stop check (graceful path) — fires between stages so the
        // previous stage's work is preserved. The "cancel" path is interrupted
        // mid-stream by the executor's AbortController and surfaces below as
        // result.status === "cancelled".
        const preStageStopSignal = getStopSignal(runId);
        if (preStageStopSignal) {
          runLog.info(
            { stage: stageType, mode: preStageStopSignal },
            "pipeline stop requested — aborting remaining stages",
          );
          await this.markRunCancelled(db, runId, run, preStageStopSignal);
          return;
        }

        if (stageType === "await-approval") {
          // Save the full resume context so resume() can re-attach the worktree
          // and continue from the next stage with the correct handoff artifact.
          const stageIndex = config.stages.indexOf(stage);
          const resumePayload = buildResumePayload(
            handoff ?? null,
            config,
            repoConfig,
            sanitizedIssue,
            worktreePath!,
            stageIndex,
          );
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

        const isFirstResumableStageForMain = claimFirstResumableStage(stageType);
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
          agentSessionId: runAgentSessionId,
          isFirstResumableStage: isFirstResumableStageForMain,
        });

        // Operator stop check (cancel path) — the AbortController inside the
        // executor surfaces as result.status === "cancelled". Don't try to use
        // the (possibly partial) handoff; exit immediately like the pre-stage
        // graceful check above.
        if (result.status === "cancelled") {
          const mode = getStopSignal(runId) ?? "cancel";
          runLog.info({ stage: stageType, mode }, "stage cancelled by operator — aborting pipeline");
          await this.markRunCancelled(db, runId, run, mode);
          return;
        }

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

            // BEC-227 — RALPH re-implement runs inside the implement stage's
            // main invocation, which already claimed the first-resumable slot
            // if eligible. Re-claim is a no-op (returns false) so this call
            // takes the `resume` shape when the flag is on.
            const isFirstResumableStageForRalph = claimFirstResumableStage(stageType);
            // BEC-227 — when this RALPH iteration is a resumed call (session
            // active AND not the first resumable stage), the prior handoff is
            // already in the agent's resumed SDK transcript. Suppress the
            // `<previous-stage-context>` block to avoid duplicating that
            // context as prompt input tokens.
            const suppressRalphHandoff =
              runAgentSessionId !== null && !isFirstResumableStageForRalph;
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
              agentSessionId: runAgentSessionId,
              isFirstResumableStage: isFirstResumableStageForRalph,
              suppressHandoff: suppressRalphHandoff,
              // BEC-227 Phase 4 / Track D — RALPH iteration counter (1..N)
              // surfaces in pipeline_run_decisions.iteration so operators
              // can correlate persisted decisions with the RALPH loop pass
              // that produced them.
              iteration,
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
              // BEC-227 — retry of an already-attempted stage. If the main
              // invocation above claimed the session, this is a no-op.
              const isFirstResumableStageForRetry = claimFirstResumableStage(stageType);
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
                agentSessionId: runAgentSessionId,
                isFirstResumableStage: isFirstResumableStageForRetry,
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
          // BEC-227 — runMode tells the validator whether this stage is the
          // first resumable stage of the run (paranoia check still runs),
          // a subsequent resumable stage (skip — agent inherits context),
          // or a non-session run (validate as before).
          const mainStageRunMode: ValidateRunMode =
            runAgentSessionId === null
              ? "fallback"
              : isFirstResumableStageForMain
                ? "first-resumed"
                : "resumed";
          const validation = await validateHandoff(
            stage,
            {
              artifact: result.handoffArtifact,
              structured: result.handoffIsStructured ?? false,
              // BEC-227 Phase 4 / Track D — validator doesn't consume the
              // decisions artifact (Track B's review-fix loop does). The
              // executor already persisted it before returning; we don't
              // need to thread it through validateHandoff.
              decisions: null,
            },
            sanitizedIssue,
            repoConfig,
            worktreePath,
            mainStageRunMode,
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
                // BEC-227 — validation-failed retry. Same stage as the main
                // invocation; claim is a no-op when the session is open.
                const isFirstResumableStageForValRetry = claimFirstResumableStage(stageType);
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
                  agentSessionId: runAgentSessionId,
                  isFirstResumableStage: isFirstResumableStageForValRetry,
                });
                if (result.status === "completed" && result.handoffArtifact) {
                  // BEC-227 — `isFirstResumableStageForValRetry` reflects the
                  // retry execution that just produced `result`. Same formula
                  // as the main-loop validation.
                  const valRetryRunMode: ValidateRunMode =
                    runAgentSessionId === null
                      ? "fallback"
                      : isFirstResumableStageForValRetry
                        ? "first-resumed"
                        : "resumed";
                  const retryValidation = await validateHandoff(
                    stage,
                    {
                      artifact: result.handoffArtifact,
                      structured: result.handoffIsStructured ?? false,
                      // BEC-227 Phase 4 / Track D — see main-stage call above.
                      decisions: null,
                    },
                    sanitizedIssue,
                    repoConfig,
                    worktreePath,
                    valRetryRunMode,
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

        // After stage completes: update the in-memory file list so the next
        // stage's pre-loop upsertActiveWork persists the accumulated set.
        // We intentionally skip a second DB write here — the row was already
        // written at the start of this stage and will be refreshed again at
        // the start of the next one, avoiding a redundant intermediate write.
        if (worktreePath) {
          const freshFiles = await getModifiedFiles(worktreePath);
          if (freshFiles.length > 0) {
            allModifiedFiles = freshFiles;
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

            // BEC-227 Phase 4 / Track B — for the implement fixStage, decide
            // surgical vs legacy review-fix. Surgical = the per-run SDK session
            // is intact (JSONL on disk) so we can send a focused
            // findings-plus-prior-decisions prompt instead of re-running the
            // full implement template. The audit event fires inside
            // runSurgicalReviewFix for BOTH paths so operators can monitor
            // fallback rates.
            let surgicalPrompt: string | undefined;
            let surgicalSuppressHandoff = false;
            if (fixStage === "implement") {
              const blocking = (handoff?.context?.reviewFindings ?? []).filter(
                (f) => f.severity === "blocking",
              );
              if (blocking.length > 0) {
                const decision = await runSurgicalReviewFix({
                  db: this.db as AnyDb,
                  runId,
                  issueId: sanitizedIssue.id,
                  agentSessionId: runAgentSessionId,
                  worktreePath,
                  blockingFindings: blocking,
                });
                if (decision.path === "surgical") {
                  surgicalPrompt = decision.prompt;
                  surgicalSuppressHandoff = true;
                }
              }
            }

            const isFirstResumableStageForFix = claimFirstResumableStage(fixStage);
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
              agentSessionId: runAgentSessionId,
              isFirstResumableStage: isFirstResumableStageForFix,
              // BEC-227 Phase 4 / Track D — review-fix iteration counter
              // (1..N) for the implement fixStage's decision artifact. Other
              // fixStages (test/review) don't emit decisions, so the value
              // is harmless when unused.
              iteration: rfIteration,
              // BEC-227 Phase 4 / Track B — undefined when the surgical
              // decision returned `legacy` (or fixStage !== "implement"),
              // which preserves the legacy assembled-prompt path.
              promptOverride: surgicalPrompt,
              suppressHandoff: surgicalSuppressHandoff,
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
              // BEC-227 — runMode derived from the review-fix executeStage
              // claim. The review-fix loop runs after the main stage loop,
              // so `isFirstResumableStageForFix` is virtually always false
              // (session already initiated). Formula is the same.
              const fixStageRunMode: ValidateRunMode =
                runAgentSessionId === null
                  ? "fallback"
                  : isFirstResumableStageForFix
                    ? "first-resumed"
                    : "resumed";
              const validation = await validateHandoff(
                fixStage,
                {
                  artifact: fixResult.handoffArtifact,
                  structured: fixResult.handoffIsStructured ?? false,
                  // BEC-227 Phase 4 / Track D — see main-stage call above.
                  decisions: null,
                },
                sanitizedIssue,
                repoConfig,
                worktreePath,
                fixStageRunMode,
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

            // Update in-memory file list with latest changes from review-fix stage.
            // No DB write needed here — coordination was already established at the
            // start of the preceding main-stage loop and the run remains tracked.
            if (handoff?.filesChanged?.length) {
              allModifiedFiles = handoff.filesChanged;
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
      let effectiveDeepReviewPasses = isFeatureLicensed("deep-review")
        ? config.deepReviewPasses ?? 0
        : 0;
      const hasReview = config.stages.includes("review");
      const hasImplement = config.stages.includes("implement");

      // Tier 3 — auto-bump deepReviewPasses to ≥1 when the agent's diff trips
      // any of the heuristic thresholds (changedFiles / totalLines /
      // newPublicExports). The agentic deep-review provider runs on Claude
      // and is enabled by `deep-review` license alone — no OpenRouter env
      // vars required. OpenRouter fanout is an additional provider that
      // runs on top when its env vars are set, but the bump is useful
      // regardless because the agentic provider always activates.
      if (isFeatureLicensed("deep-review") && hasReview && hasImplement) {
        try {
          const diffOut = await gitExecSafe(
            ["diff", "--stat", `origin/${repoConfig.defaultBranch}...HEAD`],
            worktreePath!,
          );
          // "N files changed, X insertions(+), Y deletions(-)" — last line.
          // git diff --stat reports changed (added + modified + deleted) — the
          // field is named `changedFiles` to match.
          const tail = diffOut.split("\n").filter(Boolean).pop() ?? "";
          const changedFilesMatch = /^\s*(\d+)\s+files? changed/.exec(tail);
          const insertionsMatch = /(\d+)\s+insertion/.exec(tail);
          const deletionsMatch = /(\d+)\s+deletion/.exec(tail);
          const changedFiles = changedFilesMatch ? Number(changedFilesMatch[1]) : 0;
          const totalLines =
            (insertionsMatch ? Number(insertionsMatch[1]) : 0) +
            (deletionsMatch ? Number(deletionsMatch[1]) : 0);

          const fullDiff = await gitExecSafe(
            ["diff", `origin/${repoConfig.defaultBranch}...HEAD`],
            worktreePath!,
          );
          const newPublicExports = countNewPublicExports(fullDiff);

          const thresholds =
            config.autoDeepReviewThresholds ??
            DEFAULT_AUTO_DEEP_REVIEW_THRESHOLDS;

          if (
            shouldAutoDeepReview(
              { changedFiles, totalLines, newPublicExports },
              thresholds,
            )
          ) {
            const bumped = Math.max(effectiveDeepReviewPasses, 1);
            if (bumped > effectiveDeepReviewPasses) {
              runLog.info(
                {
                  metrics: { changedFiles, totalLines, newPublicExports },
                  thresholds,
                  from: effectiveDeepReviewPasses,
                  to: bumped,
                },
                "auto-deep-review: thresholds tripped — forcing deepReviewPasses ≥ 1",
              );
              await logAuditEvent(
                this.db as AnyDb,
                pipelineAutoDeepReviewBumpedEvent({
                  runId,
                  issueId: sanitizedIssue.id,
                  metrics: { changedFiles, totalLines, newPublicExports },
                  thresholds,
                  from: effectiveDeepReviewPasses,
                  to: bumped,
                }),
              );
              effectiveDeepReviewPasses = bumped;
            }
          }
        } catch (autoErr) {
          runLog.warn(
            { err: autoErr },
            "auto-deep-review: heuristic evaluation failed — proceeding with configured deepReviewPasses",
          );
        }
      }

      const deepReviewPasses = effectiveDeepReviewPasses;
      const maxDeepReviewPasses = config.maxDeepReviewPasses ?? 3;

      if (deepReviewPasses > 0 && hasReview && hasImplement) {
        // Cap deep review iterations against maxDeepReviewPasses
        const passLimit = Math.min(deepReviewPasses, maxDeepReviewPasses);

        let previousFindingsCount = Infinity;
        let previousFingerprints = new Set<string>();
        // Tracks the last convergence check so we can emit a diagnostic after
        // the loop when the pass limit is reached without full convergence.
        let lastConvergenceCheck: ReturnType<typeof checkDeepReviewConvergence> | null = null;
        let drPassFinal = 0;
        let finalFindingsCount = 0;

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
          //
          // BEC-227 Task 11 — thread agent-session info through so the
          // agentic deep-review provider can resume the per-run SDK session
          // in its 3 parallel sub-agents. `claimFirstResumableStage` flips
          // the runner-level latch exactly once across the whole run; deep
          // review may be the first resumable consumer (e.g. when the main
          // review stage was skipped or used a fresh model).
          const isFirstResumableStageForDeepReview =
            claimFirstResumableStage("review");
          const reviewCtx = {
            runId,
            issueId: sanitizedIssue.id,
            stageRunId: lastReviewStageRunId,
            workdir: worktreePath,
            handoff,
            baseRef: repoConfig.defaultBranch ?? "main",
            prNumber: null,
            agentSessionId: runAgentSessionId,
            isFirstResumableStage: isFirstResumableStageForDeepReview,
            reviewModel: config.stageModels?.["review"],
            db: this.db as AnyDb,
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

          // BEC-212: content-aware convergence check — compares finding
          // fingerprints (not just counts) to detect cycling/contradictory-
          // requirement patterns and emit structured diagnostics.
          const convergence = checkDeepReviewConvergence(
            previousFingerprints,
            deepResult.findings,
            previousFindingsCount,
          );
          lastConvergenceCheck = convergence;
          drPassFinal = drPass;
          finalFindingsCount = findingsCount;

          if (convergence.converged) {
            runLog.info({ drPass }, "deep review: no findings — converged");
            break;
          }
          if (convergence.shouldStop) {
            runLog.info(
              {
                drPass,
                findingsCount,
                previousFindingsCount,
                reason: convergence.reason,
                findingsDiff: convergence.findingsDiff,
              },
              "deep review: convergence check stopped loop",
            );
            break;
          }

          previousFindingsCount = findingsCount;
          previousFingerprints = new Set(deepResult.findings.map(buildFindingFingerprint));

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

          const isFirstResumableStageForDrImpl = claimFirstResumableStage("implement");
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
            agentSessionId: runAgentSessionId,
            isFirstResumableStage: isFirstResumableStageForDrImpl,
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
          const isFirstResumableStageForDrReview = claimFirstResumableStage("review");
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
            agentSessionId: runAgentSessionId,
            isFirstResumableStage: isFirstResumableStageForDrReview,
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
          //
          // Tier 3 — when `deepReviewFindingsAreBlocking` is true (default),
          // upgrade every deep-review finding's severity to "blocking" so it
          // forces draft. Operators who want the pre-Tier-3 advisory behavior
          // can set `deepReviewFindingsAreBlocking: false` per pipeline.
          if (handoff && deepResult.findings.length > 0) {
            const findingsAreBlocking =
              config.deepReviewFindingsAreBlocking ?? true;
            const incoming = findingsAreBlocking
              ? deepResult.findings.map((f) => ({ ...f, severity: "blocking" as const }))
              : deepResult.findings;
            const existingFindings = handoff.context.reviewFindings ?? [];
            handoff = {
              ...handoff,
              context: {
                ...handoff.context,
                reviewFindings: [...existingFindings, ...incoming],
              },
            };
            if (findingsAreBlocking) {
              runLog.info(
                {
                  drPass,
                  upgraded: deepResult.findings.length,
                },
                "deep review: findings upgraded to blocking (Tier 3 deepReviewFindingsAreBlocking)",
              );
            }
          }
        }

        // BEC-212: emit structured diagnostic when the loop exhausts all
        // passes without converging to zero findings.
        if (
          lastConvergenceCheck !== null &&
          !lastConvergenceCheck.converged &&
          !lastConvergenceCheck.shouldStop
        ) {
          // Loop exited because drPass > passLimit (not via a break).
          const diffStat = worktreePath
            ? await gitExecSafe(["diff", "--stat", "HEAD"], worktreePath)
            : "";
          const diagnostic = buildNonConvergenceDiagnostic(
            passLimit,
            drPassFinal,
            finalFindingsCount,
            "pass-limit",
            lastConvergenceCheck.findingsDiff,
            diffStat,
          );
          runLog.warn(
            {
              diagnostic,
              runId,
              passLimit,
              finalFindingsCount,
            },
            "deep review: pass limit reached without convergence — review findings remain unresolved; consider increasing deepReviewPasses or investigating contradictory requirements",
          );
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

      // Tier 1a — scratch-file denylist gate. Runs after all stages have
      // committed (per-stage auto-commits at line ~1247 have run; push-queue
      // auto-commit at ~1780 is still ahead and serves as the final safety net
      // for any files that escape this point). If matches are found, surface
      // them as blocking findings so the existing draft-PR renderer takes over.
      // Fail-open: a git error returns an empty result and the gate stays silent.
      try {
        const scratch = await findScratchFiles(
          worktreePath!,
          repoConfig.defaultBranch,
        );
        if (scratch.skipped) {
          runLog.info("scratch-file-guard: skipped via URATEAM_DISABLE_SCRATCH_GUARD env var");
        } else if (scratch.files.length > 0) {
          shouldDraft = true;
          for (const f of scratch.files) {
            unresolvedBlockingFindings.push({
              severity: "blocking",
              file: f,
              line: 0,
              category: "scratch-files",
              description: `Scratch artifact at \`${f}\` matched the urateam denylist (agent self-documentation / *.bak / *.tmp / *.log / root-only commit-*.sh|run-*.sh / non-exempt repo-root *.md).`,
              fix:
                "Delete the file from the worktree (`git rm`), re-run, or set `URATEAM_DISABLE_SCRATCH_GUARD=true` if the match is a false positive.",
            });
          }
          runLog.warn(
            {
              issueId: sanitizedIssue.id,
              files: scratch.files,
              count: scratch.files.length,
            },
            "scratch-file-guard: matched denylist — forcing draft PR",
          );
          await logAuditEvent(
            this.db as AnyDb,
            pipelineScratchFilesBlockedEvent({
              runId,
              issueId: sanitizedIssue.id,
              files: scratch.files,
            }),
          );
        }
      } catch (guardErr) {
        // Best-effort: log and continue. The push-queue auto-commit + the
        // review-stage convention check (Tier 2) provide overlapping coverage.
        runLog.warn({ err: guardErr }, "scratch-file-guard: gate evaluation failed — skipping");
      }

      // Tier 1b — typecheck gate. Runs `pnpm -w typecheck` inside the
      // worktree as a deterministic backstop for the review stage missing
      // type errors.
      //
      // Two failure classes, treated differently:
      //   • `errorCount > 0` — parseable `error TSnnnn` lines in the output.
      //     This is a REAL typecheck failure: push a `category: "typecheck"`
      //     blocking ReviewFinding, force draft, emit audit event.
      //   • `errorCount === 0` && `!passed` — non-zero exit with no parseable
      //     errors. Almost always a setup issue (missing `node_modules`, no
      //     root `typecheck` script, pnpm not on PATH). Log warn and continue
      //     — we don't want a broken `pnpm install` to draft every PR.
      //
      // The gate is also fail-open on runner exceptions (caught below).
      try {
        const tc = await runTypecheck(worktreePath!);
        if (tc.skipped) {
          runLog.info("typecheck-gate: skipped via URATEAM_DISABLE_TYPECHECK_GATE env var");
        } else if (tc.passed) {
          runLog.info("typecheck-gate: passed");
        } else if (tc.errorCount === 0) {
          // Setup failure (no parseable TS errors). Don't block on this —
          // operator likely has a misconfigured workspace; review-stage will
          // catch real issues anyway.
          runLog.warn(
            { excerpt: tc.firstMessages, outputPrefix: tc.output.slice(0, 200) },
            "typecheck-gate: non-zero exit with no parseable TS errors — treating as setup issue and continuing",
          );
        } else {
          shouldDraft = true;
          // Keep `description` single-line so it renders cleanly inside the
          // draft-PR comment's markdown list item (runner.ts:2188 interpolates
          // description directly into a `-` list bullet — embedded `\n` would
          // break the list).
          const firstMessage = tc.firstMessages[0] ?? "(no parseable first message)";
          const additional =
            tc.firstMessages.length > 1
              ? ` (+${tc.firstMessages.length - 1} more)`
              : "";
          unresolvedBlockingFindings.push({
            severity: "blocking",
            file: "(workspace)",
            line: 0,
            category: "typecheck",
            description: `Typecheck failed with ${tc.errorCount} error${tc.errorCount === 1 ? "" : "s"}. First: ${firstMessage}${additional}`,
            fix:
              "Fix the type errors. Full output (up to 5 first errors) is in the audit log (`pipeline.typecheck_failed` event) and the run's structured logs. Set `URATEAM_DISABLE_TYPECHECK_GATE=true` if the gate is firing on a false positive.",
          });
          runLog.warn(
            {
              issueId: sanitizedIssue.id,
              errorCount: tc.errorCount,
              firstMessages: tc.firstMessages,
            },
            "typecheck-gate: failed — forcing draft PR",
          );
          await logAuditEvent(
            this.db as AnyDb,
            pipelineTypecheckFailedEvent({
              runId,
              issueId: sanitizedIssue.id,
              errorCount: tc.errorCount,
              firstMessages: tc.firstMessages,
            }),
          );
        }
      } catch (tcErr) {
        runLog.warn(
          { err: tcErr },
          "typecheck-gate: evaluation failed — skipping",
        );
      }

      // Tier 1c — spec-vs-impl JSDoc gate. Scans the agent's added/modified
      // TS files for docblock references (`config.X` / `opts.X` / `env.X` /
      // `deps.X` / `options.X`) whose bare symbol isn't defined anywhere in
      // the worktree's tracked source. Catches the PR #254 BEC-201 failure
      // mode (`config.implementProviderFallback` documented but never added
      // to the Zod schema). Fail-open: any error from the gate is logged and
      // swallowed.
      try {
        const sv = await checkSpecVsImpl(worktreePath!, repoConfig.defaultBranch);
        if (sv.skipped) {
          runLog.info(
            "spec-vs-impl-gate: skipped via URATEAM_DISABLE_SPEC_VS_IMPL_GATE env var",
          );
        } else if (sv.findings.length > 0) {
          shouldDraft = true;
          for (const f of sv.findings) {
            unresolvedBlockingFindings.push({
              severity: "blocking",
              file: f.filePath,
              line: 0,
              category: "spec-vs-impl",
              description: `JSDoc references \`${f.promisedPrefix}.${f.promisedSymbol}\` but \`${f.promisedSymbol}\` is not defined anywhere in the worktree's TS/JS source.`,
              fix: `Either add the symbol to the relevant schema/interface, or update the docblock to reference the actual field name. Set \`URATEAM_DISABLE_SPEC_VS_IMPL_GATE=true\` to bypass (heuristic — false positives possible).`,
            });
          }
          runLog.warn(
            {
              issueId: sanitizedIssue.id,
              count: sv.findings.length,
              findings: sv.findings.slice(0, 5),
            },
            "spec-vs-impl-gate: matched undefined symbols — forcing draft PR",
          );
          await logAuditEvent(
            this.db as AnyDb,
            pipelineSpecVsImplFailedEvent({
              runId,
              issueId: sanitizedIssue.id,
              findings: sv.findings,
            }),
          );
        }
      } catch (svErr) {
        runLog.warn(
          { err: svErr },
          "spec-vs-impl-gate: evaluation failed — skipping",
        );
      }

      // All stages complete — push branch and create PR.
      // The push queue (concurrency=1) serialises within this process.
      // withBranchLock extends that serialisation across multiple server instances
      // via a DB advisory lock (Postgres) so they can't race on PR creation for
      // the same branch.  If the lock cannot be acquired within prLockTimeoutMs,
      // the pipeline fails with a LockTimeoutError.

      // Parse the repo URL once here — repoConfig.url is constant for the
      // lifetime of this pipeline run. All GitHub/gh-CLI call sites below
      // consume parsedRepoUrl instead of re-parsing the same string.
      // Null on parse failure so the gh-CLI fallback path (which tolerates
      // a missing owner) keeps working; GitHub-App paths use
      // requireParsedRepoUrl() below to surface a clear error instead of
      // crashing on a non-null assertion.
      const parsedRepoUrl = (() => {
        try {
          return parseRepoUrl(repoConfig.url);
        } catch {
          return null;
        }
      })();
      const requireParsedRepoUrl = (): { owner: string; repo: string } => {
        if (!parsedRepoUrl) {
          throw new Error(
            `PipelineRunner: failed to parse repo URL '${repoConfig.url}' — cannot interact with GitHub API`,
          );
        }
        return parsedRepoUrl;
      };

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

            // Abort the in-progress rebase so the worktree HEAD returns to the
            // named branch ref before the agent starts writing new commits.
            // Without this, HEAD stays detached on the tentative rebase commit
            // and verifyBranchMatch() (BEC-99 guard) will reject the push.
            await abortRebase(wtPath);

            const isFirstResumableStageForResolve = claimFirstResumableStage("implement");
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
              agentSessionId: runAgentSessionId,
              isFirstResumableStage: isFirstResumableStageForResolve,
            });

            run.totalInputTokens += resolveResult.inputTokens;
            run.totalOutputTokens += resolveResult.outputTokens;

            if (resolveResult.status !== "completed") {
              runLog.warn("push queue: conflict resolution failed — force-pushing for human review");
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
        // Tier 6e — compute triage prediction-quality and emit audit event so the
        // Tier 6e — compute triage prediction-quality and emit audit event so
        // the metric can be surfaced in the PR description footer (BEC-220).
        // Reads `triage_results.v2_prediction` (BEC-217 DB-backed path).
        // Fail-open: any error is logged and swallowed; PR creation always
        // proceeds. Parallelized with the agent-commits read.
        let triageQuality: TriageQualityMetric | undefined;
        const [qualityResult, agentCommits] = await Promise.all([
          (async () => {
            try {
              const [stored, actualFiles] = await Promise.all([
                getTriageResult(this.db as AnyDb, sanitizedIssue.id),
                getChangedFiles(wtPath, repoConfig.defaultBranch),
              ]);
              const predicted = stored?.affectedFiles;
              const quality = computeAffectedFilesPredictionQuality(predicted, actualFiles);
              await logAuditEvent(
                this.db as AnyDb,
                pmTriageQualityScoreEvent({
                  runId,
                  issueId: sanitizedIssue.id,
                  ...quality,
                }),
              );
              if (quality.hasV2Prediction) {
                // PredictionQualityResult and TriageQualityMetric are structurally identical.
                const metric: TriageQualityMetric = quality;
                return metric;
              }
              return undefined;
            } catch (qualityErr) {
              runLog.warn(
                { err: qualityErr instanceof Error ? qualityErr.message : String(qualityErr) },
                "triage-quality-score: emission failed — skipping (fail-open)",
              );
              return undefined;
            }
          })(),
          getAgentCommits(wtPath, repoConfig.defaultBranch),
        ]);
        triageQuality = qualityResult;
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
          triageQuality,
        });
        const isGitLab = repoConfig.provider === "gitlab";
        const isBitbucket = repoConfig.provider === "bitbucket";

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
        } else if (isBitbucket && this.bitbucketConfig) {
          // Bitbucket — create PR via REST API
          try {
            const { workspace, repoSlug } = parseBitbucketUrl(repoConfig.url);
            prUrl = await createBitbucketPR(this.bitbucketConfig, {
              workspace,
              repoSlug,
              sourceBranch: branch,
              targetBranch: repoConfig.defaultBranch,
              title: sanitizedIssue.title,
              description: prBody,
              draft: shouldDraft,
            });
            run.prUrl = prUrl;
            runLog.info({ prUrl }, "PR created via Bitbucket API");
          } catch (prError) {
            runLog.error({ err: prError }, "PR creation via Bitbucket API failed");
          }
        } else if (!isGitLab && !isBitbucket && this.githubConfig) {
          // GitHub App — use Octokit API
          try {
            const { owner, repo } = requireParsedRepoUrl();
            const octokit = await this.getOctokit();
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
        } else if (!isGitLab && !isBitbucket) {
          // No provider-specific config — use gh CLI
          runLog.info("creating PR via gh CLI");
          const ghOwner = parsedRepoUrl?.owner;
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
        // access; the gh-CLI/GitLab/Bitbucket paths skip this (parity gap accepted for v1).
        if (
          prUrl &&
          pendingFanoutRuns.length > 0 &&
          !isGitLab &&
          !isBitbucket &&
          this.githubConfig
        ) {
          const fanoutPrNumberMatch = prUrl.match(/\/pull\/(\d+)/);
          const fanoutPrNumber = fanoutPrNumberMatch
            ? parseInt(fanoutPrNumberMatch[1]!, 10)
            : null;
          if (fanoutPrNumber !== null) {
            try {
              const { owner: fanoutOwner, repo: fanoutRepo } =
                requireParsedRepoUrl();
              const fanoutOctokit = await this.getOctokit();
              const fanoutResult = await postFanoutCommentsToPR(
                fanoutOctokit,
                fanoutOwner,
                fanoutRepo,
                fanoutPrNumber,
                pendingFanoutRuns,
              );
              runLog.info(
                {
                  prNumber: fanoutPrNumber,
                  count: pendingFanoutRuns.length,
                  fallbackCount: fanoutResult.fallbackCount,
                  suppressedEmptyCount: fanoutResult.suppressedEmptyCount,
                  suppressedProviderFailureCount: fanoutResult.suppressedProviderFailureCount,
                },
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

        // 6. Auto-merge (skip drafts, unresolved conflicts)
        const maxLines = config.autoMergeMaxLines ?? 200;
        if (config.autoMerge && prUrl && !rebaseConflict && !shouldDraft) {
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
          // fallback and GitLab/Bitbucket paths skip this check — documented in the
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
                    const octokit = await this.getOctokit();
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
            runLog.info({ diffLines, maxLines, provider: repoConfig.provider }, "auto-merge eligible, merging PR");
            if (isGitLab && this.gitlabConfig) {
              // GitLab: use merge_when_pipeline_succeeds API
              try {
                const { projectPath } = parseGitLabUrl(repoConfig.url);
                // Extract MR IID from URL: .../-/merge_requests/42
                const mrIidMatch = prUrl.match(/\/merge_requests\/(\d+)/);
                const mrIid = mrIidMatch ? parseInt(mrIidMatch[1]!, 10) : null;
                if (mrIid !== null) {
                  autoMerged = await mergeMRWhenPipelineSucceeds(this.gitlabConfig, projectPath, mrIid);
                  if (autoMerged) {
                    autoMergeReason = "PR auto-merged via GitLab merge_when_pipeline_succeeds";
                    runLog.info({ prUrl }, "GitLab MR queued for merge when pipeline succeeds");
                  } else {
                    autoMergeReason = "GitLab merge_when_pipeline_succeeds API call failed";
                    runLog.warn("GitLab auto-merge failed, sending human review alert");
                    await this.notifier.onHumanReviewNeeded?.(run, prUrl, "GitLab auto-merge failed — please merge manually");
                  }
                } else {
                  autoMergeReason = "Could not parse MR IID from URL";
                  runLog.warn({ prUrl }, "GitLab auto-merge: could not parse MR IID");
                  await this.notifier.onHumanReviewNeeded?.(run, prUrl, "GitLab auto-merge failed — could not determine MR ID");
                }
              } catch (err) {
                autoMergeReason = "GitLab auto-merge threw an error";
                runLog.error({ err }, "GitLab auto-merge error");
                await this.notifier.onHumanReviewNeeded?.(run, prUrl, "GitLab auto-merge failed — please merge manually");
              }
            } else if (isBitbucket && this.bitbucketConfig) {
              // Bitbucket: use PR merge API
              try {
                const { workspace, repoSlug } = parseBitbucketUrl(repoConfig.url);
                // Extract PR ID from URL: .../pull-requests/42
                const prIdMatch = prUrl.match(/\/pull-requests\/(\d+)/);
                const prId = prIdMatch ? parseInt(prIdMatch[1]!, 10) : null;
                if (prId !== null) {
                  autoMerged = await mergeBitbucketPR(this.bitbucketConfig, workspace, repoSlug, prId);
                  if (autoMerged) {
                    autoMergeReason = "PR auto-merged via Bitbucket API";
                    runLog.info({ prUrl }, "Bitbucket PR merged");
                  } else {
                    autoMergeReason = "Bitbucket merge API call failed";
                    runLog.warn("Bitbucket auto-merge failed, sending human review alert");
                    await this.notifier.onHumanReviewNeeded?.(run, prUrl, "Bitbucket auto-merge failed — please merge manually");
                  }
                } else {
                  autoMergeReason = "Could not parse PR ID from Bitbucket URL";
                  runLog.warn({ prUrl }, "Bitbucket auto-merge: could not parse PR ID");
                  await this.notifier.onHumanReviewNeeded?.(run, prUrl, "Bitbucket auto-merge failed — could not determine PR ID");
                }
              } catch (err) {
                autoMergeReason = "Bitbucket auto-merge threw an error";
                runLog.error({ err }, "Bitbucket auto-merge error");
                await this.notifier.onHumanReviewNeeded?.(run, prUrl, "Bitbucket auto-merge failed — please merge manually");
              }
            } else {
              // GitHub / gh CLI fallback
              autoMerged = await mergePRViaCli(wtPath, branch);
              if (autoMerged) {
                autoMergeReason = "PR auto-merged successfully";
                runLog.info({ prUrl }, "PR auto-merged");
              } else {
                autoMergeReason = "Auto-merge command failed";
                runLog.warn("auto-merge failed, sending human review alert");
                await this.notifier.onHumanReviewNeeded?.(run, prUrl, "Auto-merge failed — please merge manually");
              }
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
      await this.cancelRunningStageRuns(db, runId);
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
      // pipeline completion. Supported on GitHub, GitLab, and Bitbucket.
      // BEC-206: provider booleans must be local to this block — the
      // declarations inside the push queue scope are not visible here.
      const isGitLab = repoConfig.provider === "gitlab";
      const isBitbucket = repoConfig.provider === "bitbucket";
      if (
        process.env.URATEAM_PR_COST_SUMMARY === "true" &&
        prUrl
      ) {
        try {
          // Build cost body regardless of provider
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
            if (!modelsByStage.has(mr.stageRunId)) modelsByStage.set(mr.stageRunId, []);
            modelsByStage.get(mr.stageRunId)!.push({
              modelId: mr.modelId,
              inputTokens: mr.inputTokens,
              outputTokens: mr.outputTokens,
            });
          }
          const breakdown: StageCostBreakdown[] = stages.map((s: any) => ({
            stage: s.stage,
            inputTokens: s.inputTokens,
            outputTokens: s.outputTokens,
            cacheCreationInputTokens: s.cacheCreationInputTokens ?? 0,
            cacheReadInputTokens: s.cacheReadInputTokens ?? 0,
            modelRuns: modelsByStage.get(s.id),
          }));
          const costBody = formatPRCostSummary(breakdown, run.pipelineKey, {
            pipelineConfigs: { [run.pipelineKey]: config },
          });
          if (costBody) {
            if (isGitLab && this.gitlabConfig) {
              // GitLab: post via REST API
              const { projectPath } = parseGitLabUrl(repoConfig.url);
              const mrIidMatch = prUrl.match(/\/merge_requests\/(\d+)/);
              const mrIid = mrIidMatch ? parseInt(mrIidMatch[1]!, 10) : null;
              if (mrIid !== null) {
                await addMRComment(this.gitlabConfig, projectPath, mrIid, costBody);
                runLog.info({ mrIid }, "BEC-175: posted GitLab MR cost summary");
              }
            } else if (isBitbucket && this.bitbucketConfig) {
              // Bitbucket: post via REST API
              const { workspace, repoSlug } = parseBitbucketUrl(repoConfig.url);
              const prIdMatch = prUrl.match(/\/pull-requests\/(\d+)/);
              const prId = prIdMatch ? parseInt(prIdMatch[1]!, 10) : null;
              if (prId !== null) {
                await addBitbucketPRComment(this.bitbucketConfig, workspace, repoSlug, prId, costBody);
                runLog.info({ prId }, "BEC-175: posted Bitbucket PR cost summary");
              }
            } else if (this.githubConfig) {
              // GitHub: use Octokit with dedup check
              const summaryPrMatch = prUrl.match(/\/pull\/(\d+)/);
              const summaryPrNumber = summaryPrMatch
                ? parseInt(summaryPrMatch[1]!, 10)
                : null;
              if (summaryPrNumber !== null) {
                const { owner: summaryOwner, repo: summaryRepo } =
                  requireParsedRepoUrl();
                const summaryOctokit = await this.getOctokit();
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
                    costBody,
                  );
                  runLog.info(
                    { prNumber: summaryPrNumber },
                    "BEC-175: posted PR cost summary",
                  );
                }
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
      // changes, so silent shipping is a bug. Supported on all providers.
      if (run.runType === "review-feedback" && prUrl) {
        try {
          if (isGitLab && this.gitlabConfig) {
            // GitLab: build change summary and post via addMRComment
            const { projectPath } = parseGitLabUrl(repoConfig.url);
            const mrIidMatch = prUrl.match(/\/merge_requests\/(\d+)/);
            const mrIid = mrIidMatch ? parseInt(mrIidMatch[1]!, 10) : null;
            if (mrIid !== null && handoff) {
              const { renderChangeSummary } = await import("./pr-change-summary.js");
              let triggeringComments: any[] = [];
              if (run.feedbackContext) {
                try {
                  const parsed = JSON.parse(run.feedbackContext) as unknown;
                  if (Array.isArray(parsed)) triggeringComments = parsed as any[];
                } catch { /* ignore */ }
              }
              const csBody = renderChangeSummary({
                handoff,
                run: { id: run.id, totalInputTokens: run.totalInputTokens, totalOutputTokens: run.totalOutputTokens },
                triggeringComments,
                dashboardBaseUrl: process.env.URATEAM_DASHBOARD_URL ?? "",
                prUrl,
              });
              await addMRComment(this.gitlabConfig, projectPath, mrIid, csBody);
              runLog.info({ mrIid }, "posted GitLab MR change summary for review-feedback run");
            }
          } else if (isBitbucket && this.bitbucketConfig) {
            // Bitbucket: build change summary and post via addBitbucketPRComment
            const { workspace, repoSlug } = parseBitbucketUrl(repoConfig.url);
            const prIdMatch = prUrl.match(/\/pull-requests\/(\d+)/);
            const prId = prIdMatch ? parseInt(prIdMatch[1]!, 10) : null;
            if (prId !== null && handoff) {
              const { renderChangeSummary } = await import("./pr-change-summary.js");
              let triggeringComments: any[] = [];
              if (run.feedbackContext) {
                try {
                  const parsed = JSON.parse(run.feedbackContext) as unknown;
                  if (Array.isArray(parsed)) triggeringComments = parsed as any[];
                } catch { /* ignore */ }
              }
              const csBody = renderChangeSummary({
                handoff,
                run: { id: run.id, totalInputTokens: run.totalInputTokens, totalOutputTokens: run.totalOutputTokens },
                triggeringComments,
                dashboardBaseUrl: process.env.URATEAM_DASHBOARD_URL ?? "",
                prUrl,
              });
              await addBitbucketPRComment(this.bitbucketConfig, workspace, repoSlug, prId, csBody);
              runLog.info({ prId }, "posted Bitbucket PR change summary for review-feedback run");
            }
          } else {
            // GitHub: use existing maybePostChangeSummary helper
            const summaryPrMatch = prUrl.match(/\/pull\/(\d+)/);
            const summaryPrNumber = summaryPrMatch
              ? parseInt(summaryPrMatch[1]!, 10)
              : null;
            const { owner: csOwner, repo: csRepo } = requireParsedRepoUrl();
            const csOctokit = await this.getOctokit();
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
          }
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
      // Store currentStageIndex - 1 so the existing resume path's
      // `slice(startStageIndex + 1)` lands back on the failed stage.
      // (await-approval stores the completed stage index; we need to re-run the failed one.)
      // No floor clamp: -1 is valid when stage 0 fails, since slice(-1+1) = slice(0)
      // re-runs the full stage list. The await-approval path stores the completed
      // stage index; we store failedIndex - 1 so the same +1 offset re-runs the failed stage.
      const resumeStageIndex = (context.currentStageIndex ?? 0) - 1;

      const resumePayload = buildResumePayload(
        context.handoff ?? null,
        context.pipelineConfig,
        context.repoConfig,
        context.sanitizedIssue,
        context.worktreePath,
        resumeStageIndex,
      );

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
    await this.cancelRunningStageRuns(db, runId);
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

          await Promise.all([
            db
              .update(pipelineRuns)
              .set({ status: "failed", errorMessage: errorMsg })
              .where(eq(pipelineRuns.id, run.id)),
            this.cancelRunningStageRuns(db, run.id),
            removeActiveWork(db, run.id),
          ]);
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
