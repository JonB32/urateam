/**
 * release-tick.ts
 *
 * Responsibility: the release-manager decision cycle (QA trigger logic, approval
 * gate, version bump, Git tag creation, and cron rescheduling state).
 *
 * The single exported function `tick(ctx)` receives all dependencies and mutable
 * inter-tick state through an explicit `TickContext` struct instead of closing
 * over variables in the scheduler factory. This makes the function independently
 * testable and removes the 8-variable closure from scheduler.ts.
 *
 * Exports:
 *   - TickMutableState  — per-instance state that persists between ticks
 *   - TickContext       — all deps + mutable state for one tick invocation
 *   - tick              — execute a single release-manager decision cycle
 */
import { randomUUID } from "node:crypto";
import type { Octokit } from "@octokit/rest";
import type { LinearClient } from "@linear/sdk";
import type { AnyDb } from "../db/client.js";
import { createLogger } from "../logger.js";
import { logAuditEventUnchecked } from "../audit/writer.js";
import {
  releaseFiredEvent,
  releaseSkippedEvent,
  releaseTagConflictEvent,
  releasePartialEvent,
  qaRunCompletedEvent,
} from "../audit/events.js";
import { collectState } from "./state.js";
import { decide } from "./decide.js";
import { bumpFromConfigAndCommits } from "./versioning.js";
import { createTagAndRelease, parseRepoFromUrl } from "./github.js";
import type { ReleaseManagerConfig } from "./types.js";
import { triggerWorkflow, pollWorkflowRun, workflowFileExists } from "../qa/github.js";
import { markGapResolved } from "../qa/gap.js";
import { makeCallClaude } from "../pm/call-claude.js";
import {
  maybePostSlack,
  persistDecision,
  consumeApprovalRow,
  getMaxAttemptCountForReason,
  tryFileQaGapIssue,
  clearFailureRowsForSha,
  MAX_QA_RETRY_ATTEMPTS,
} from "./release-helpers.js";
import type { SlackPoster, SlackDedupState } from "./release-helpers.js";

const log = createLogger({ component: "ReleaseManager:scheduler" });

/**
 * Maximum number of completed QA run IDs to track in the dedup set before
 * evicting stale entries. Once this threshold is reached the set is cleared;
 * a cleared entry may produce a single duplicate `qa.run_completed` audit
 * event, which is acceptable (far better than unbounded memory growth in
 * long-running deployments).
 */
const MAX_AUDITED_RUN_IDS = 10_000;

/**
 * Sentinel attempt count that permanently skips retry logic for a dispatch
 * failure that cannot recover (e.g. workflow misconfigured via dispatch_422).
 * Must exceed MAX_QA_RETRY_ATTEMPTS so the circuit-breaker is never triggered
 * on a retriable path.
 */
const PERMANENT_FAILURE_ATTEMPT_COUNT = 99;

/**
 * Mutable per-instance state that persists across tick invocations.
 *
 * The scheduler factory constructs exactly one `TickMutableState` per
 * `createReleaseManagerScheduler` call and passes it through `TickContext` to
 * every `tick()` call. The tick function reads and writes this object in-place.
 */
export interface TickMutableState {
  /** Slack dedup counters — tracks reason + timestamp of last successful post. */
  slackDedup: SlackDedupState;
  /**
   * True once the "release-manager unlicensed" warning has been logged,
   * preventing repeated log spam on every unlicensed tick.
   */
  licenseWarnLogged: boolean;
  /**
   * Set of QA workflow run IDs whose completion has already been audited.
   * Prevents duplicate `qa.run_completed` audit events when the same run ID
   * appears across multiple ticks.
   *
   * Bounded to `MAX_AUDITED_RUN_IDS` entries — evicted (cleared) when the
   * threshold is exceeded to prevent unbounded memory growth in long-running
   * deployments.
   */
  auditedCompletedRunIds: Set<number>;
  /**
   * Epoch-ms timestamp until which the scheduler is paused (via `/release skip`).
   * Zero means not paused.
   */
  pausedUntilTs: number;
}

/**
 * All dependencies and configuration needed to run a single release-manager tick.
 *
 * The scheduler constructs a `TickContext` once at startup and passes it to every
 * `tick()` invocation rather than relying on closure variables. This makes the
 * state machine independently testable and explicit about its dependencies.
 *
 * @field config           - Full release-manager configuration for this repo/branch pair.
 * @field db               - Database client (SQLite dev / Postgres prod).
 * @field octokit          - GitHub REST API client.
 * @field linear           - Linear client for filing QA gap issues. Required when
 *                           `config.triggers.qaCheck` is configured.
 * @field repoUrl          - HTTPS URL of the repository (e.g. "https://github.com/org/repo").
 * @field branch           - Branch name being managed (e.g. "main").
 * @field isLicensed       - Injectable license check — returns true when
 *                           "release-manager" feature is licensed.
 * @field slack            - Optional Slack client for posting release notifications.
 * @field mutableState     - Per-instance state shared across ticks. Updated in-place.
 */
export interface TickContext {
  /** Full release-manager configuration for this repo/branch pair. */
  config: ReleaseManagerConfig;
  /** Database client (SQLite or Postgres). */
  db: AnyDb;
  /** GitHub REST API client. */
  octokit: Octokit;
  /**
   * Linear client for filing QA gap issues.
   * Required when `config.triggers.qaCheck` is configured.
   */
  linear?: LinearClient;
  /** HTTPS URL of the repository (e.g. "https://github.com/org/repo"). */
  repoUrl: string;
  /** Branch name being managed (e.g. "main"). */
  branch: string;
  /** Injectable license check — returns true when "release-manager" feature is licensed. */
  isLicensed: () => boolean;
  /** Optional Slack client for posting release notifications. */
  slack?: SlackPoster;
  /**
   * Mutable per-instance state shared across ticks.
   * Updated in-place by `tick()` to persist dedup counters, pause state, etc.
   */
  mutableState: TickMutableState;
}

/** Compute the approval TTL in milliseconds from config, defaulting to 24 hours. */
function approvalTtlMs(config: ReleaseManagerConfig): number {
  const hours = config.triggers.timeSinceLastHours;
  if (hours && hours > 0) return hours * 3600 * 1000;
  return 24 * 3600 * 1000;
}

/**
 * Execute a single release-manager decision cycle.
 *
 * Orchestrates the full state machine:
 * 1. License check and pause gate.
 * 2. Collect world state (branch HEAD, tags, CI, approvals, QA run).
 * 3. Manual-tag detection (re-baseline).
 * 4. QA workflow check — trigger, poll, or file gap issue as needed.
 * 5. Decide (skip / awaiting-approval / fire).
 * 6. On skip: persist decision, emit audit event, post Slack with dedup.
 * 7. On awaiting-approval: persist decision, post Slack prompt.
 * 8. On fire: create Git tag + GitHub release, persist decision, post Slack.
 *
 * All dependencies arrive through `ctx`; no closure variables are read or written.
 * Mutable inter-tick state is stored in `ctx.mutableState` and updated in-place.
 *
 * @param ctx - All dependencies and mutable state for this tick invocation.
 */
// Lazy singleton — created once per process, not per tick (avoids re-importing on every call).
const callClaude = makeCallClaude();

/**
 * Shared gap-filing step: call tryFileQaGapIssue when a Linear client is available,
 * log an error and return a no-op result when it isn't.
 * Eliminates the verbatim duplication between the dispatch_404 and qa_no_workflow paths.
 */
async function fileGapOrLog(
  linear: LinearClient | undefined,
  params: {
    db: AnyDb;
    repoUrl: string;
    branch: string;
    workflowPath: string;
    linearTeamId: string;
  },
): Promise<{ finalReason: string; attemptCount: number }> {
  if (!linear) {
    log.error({ repoUrl: params.repoUrl, branch: params.branch }, "qaCheck requires Linear client but none configured — skipping gap-issue file");
    return { finalReason: "qa_no_workflow", attemptCount: 0 };
  }
  return tryFileQaGapIssue({ ...params, linear, callClaude });
}

export async function tick(ctx: TickContext): Promise<void> {
  const { config, db, octokit, linear, repoUrl, branch, isLicensed, slack, mutableState } = ctx;
  const slackChannel = config.slackChannel;

  if (!isLicensed()) {
    if (!mutableState.licenseWarnLogged) {
      log.warn({ repoUrl, branch }, "release-manager unlicensed — skipping ticks");
      mutableState.licenseWarnLogged = true;
    }
    return;
  }
  if (Date.now() < mutableState.pausedUntilTs) {
    log.info({ pausedUntilTs: mutableState.pausedUntilTs }, "scheduler paused (via /release skip) — skipping tick");
    return;
  }

  let state;
  try {
    state = await collectState({
      octokit, db, repoUrl, branch, approvalTtlMs: approvalTtlMs(config),
    });
  } catch (err) {
    log.error({ err, repoUrl, branch }, "collectState failed — skipping tick");
    return;
  }

  const triggerStateJson = JSON.stringify({
    mergedCommitsSinceLastTag: state.mergedCommitsSinceLastTag,
    lastTag: state.lastTag,
    lastTagAt: state.lastTagAt?.toISOString() ?? null,
    ciStatus: state.ciStatus,
    hasFreshApproval: state.hasFreshApproval,
  });

  // 1. Manual-tag detection — re-baseline counters.
  if (state.manualTagDetected) {
    const id = `rd_${randomUUID()}`;
    await persistDecision(db, repoUrl, branch, {
      id,
      decision: "skip",
      reason: "manual_tag_detected",
      triggerStateJson,
    });
    void logAuditEventUnchecked(db, releaseSkippedEvent({ repoUrl, branch, reason: "manual_tag_detected" }));
    log.info({ repoUrl, branch }, "manual tag detected — re-baselining");
    return;
  }

  // 2. BEC-136: Compute QA state when qaCheck is configured.
  let qaState: { workflowFileExists: boolean; runConclusion: string | null } | undefined;
  if (config.triggers.qaCheck) {
    const { owner, repo } = parseRepoFromUrl(repoUrl);
    let wfExists = false;
    try {
      wfExists = await workflowFileExists({
        octokit, owner, repo,
        path: config.triggers.qaCheck.workflow,
        ref: state.headSha,
      });
    } catch (err) {
      log.warn({ err }, "qa workflowFileExists check failed — treating as exists");
      wfExists = true; // fail-open so retries hit the dispatch path
    }
    if (wfExists) {
      // BEC-136: workflow file is present; if there was an open gap issue for this
      // (repo, branch, workflow), mark it resolved so a future gap can be re-filed.
      await markGapResolved({
        db,
        repoUrl,
        branch,
        workflowPath: config.triggers.qaCheck.workflow,
      });
    }
    let runConclusion: string | null = null;
    if (state.qaRun && state.qaRun.runSha === state.headSha) {
      try {
        const polled = await pollWorkflowRun({ octokit, owner, repo, runId: state.qaRun.runId });
        if (polled.kind === "completed") {
          runConclusion = polled.conclusion;
          if (!mutableState.auditedCompletedRunIds.has(state.qaRun.runId)) {
            // BEC-196: bounded-memory eviction. The pre-split scheduler held
            // this set unbounded; the split is the right moment to fix it
            // because state is now passed explicitly via TickMutableState.
            // After eviction a single QA run id can be re-audited once
            // (duplicate `qa.run_completed` event) — acceptable in exchange
            // for bounded memory. The 10k cap is high enough that hitting it
            // requires months of continuous QA runs.
            if (mutableState.auditedCompletedRunIds.size >= MAX_AUDITED_RUN_IDS) {
              mutableState.auditedCompletedRunIds.clear();
            }
            mutableState.auditedCompletedRunIds.add(state.qaRun.runId);
            // Emit qa.run_completed audit on first observation of completion.
            void logAuditEventUnchecked(
              db,
              qaRunCompletedEvent({
                repoUrl, branch,
                runId: state.qaRun.runId,
                conclusion: polled.conclusion as any,
                durationMs: polled.durationMs,
              }),
            );
          }
          // When already in the set: runConclusion is still set above; audit skipped.
        }
      } catch (err) {
        log.warn({ err }, "qa pollWorkflowRun failed — treating as still running");
      }
    }
    qaState = { workflowFileExists: wfExists, runConclusion };
  }

  // 3. Decision.
  const result = decide(state, config.triggers, undefined, qaState);
  const proposedVersion = bumpFromConfigAndCommits(
    state.lastTag,
    state.commitsSinceLastTag,
    config.versionBump,
  );

  if (result.kind === "skip") {
    const id = `rd_${randomUUID()}`;

    // Compute attempt count for retry handling on qa_dispatch_error path.
    let attemptCount = 0;
    let qaRunId: number | undefined;
    let qaRunSha: string | undefined;
    let finalReason = result.reason;

    if (result.qaActionNeeded?.reason === "qa_needs_trigger") {
      // BEC-146: read the most-recent row's attemptCount (ORDER BY decidedAt DESC LIMIT 1)
      // rather than MAX(attemptCount) across all rows for this (branch, sha) pair.
      // Using MAX caused false permanent skips: after a successful dispatch reset
      // attemptCount to 0, the MAX query still returned the old high-water mark
      // from earlier failure rows, causing the next failure to immediately escalate.
      attemptCount = await getMaxAttemptCountForReason(
        db, repoUrl, branch, "qa_needs_trigger", state.headSha,
      );

      const { owner, repo } = parseRepoFromUrl(repoUrl);
      const dispatch = await triggerWorkflow({
        octokit, db, owner, repo, repoUrl, branch,
        workflow: config.triggers.qaCheck!.workflow,
        ref: state.headSha,
        inputs: config.triggers.qaCheck!.workflowInputs,
      });
      if (dispatch.kind === "ok") {
        // BEC-146: clear prior failure rows for this SHA so MAX(attemptCount)
        // naturally returns 0 if the run subsequently fails and we re-enter
        // the dispatch path on a later tick.
        await clearFailureRowsForSha(db, repoUrl, branch, "qa_needs_trigger", state.headSha);
        attemptCount = 0; // reset on successful dispatch
        qaRunId = dispatch.runId;
        qaRunSha = state.headSha;
      } else if (dispatch.kind === "dispatch_404") {
        // Workflow disappeared between state cache and dispatch — drop into gap-issue path.
        finalReason = "qa_no_workflow";
        ({ finalReason, attemptCount } = await fileGapOrLog(linear, {
          db, repoUrl, branch,
          workflowPath: config.triggers.qaCheck!.workflow,
          linearTeamId: config.triggers.qaCheck!.linearTeamId,
        }));
      } else if (dispatch.kind === "dispatch_422") {
        finalReason = "qa_dispatch_error";
        attemptCount = PERMANENT_FAILURE_ATTEMPT_COUNT; // permanent skip — workflow misconfigured, retrying won't help
      } else if (dispatch.kind === "dispatch_pending") {
        // GitHub eventual-consistency window. The HTTP dispatch DID succeed (204 OK), so
        // reset the retry counter to 0 — a successful dispatch is not a failure.
        // BEC-146: clear prior failure rows for this SHA so MAX(attemptCount) returns 0
        // for subsequent ticks. Without this, old dispatch_error rows (attemptCount=1,2)
        // would cause MAX to keep returning their high-water mark and the next failure
        // would immediately escalate to qa_dispatch_error, bypassing the retry budget.
        await clearFailureRowsForSha(db, repoUrl, branch, "qa_needs_trigger", state.headSha);
        attemptCount = 0;
        // Tag with qaRunSha so the per-SHA retry counter query can find this row.
        qaRunSha = state.headSha;
        // finalReason stays as "qa_needs_trigger" for next tick to retry.
      } else {
        // dispatch_error — increment attempt counter.
        // Tag with qaRunSha so the per-SHA retry counter query can find these rows.
        qaRunSha = state.headSha;
        attemptCount += 1;
        if (attemptCount >= MAX_QA_RETRY_ATTEMPTS) {
          finalReason = "qa_dispatch_error";
        }
      }
    } else if (result.qaActionNeeded?.reason === "qa_no_workflow") {
      ({ finalReason, attemptCount } = await fileGapOrLog(linear, {
        db, repoUrl, branch,
        workflowPath: config.triggers.qaCheck!.workflow,
        linearTeamId: config.triggers.qaCheck!.linearTeamId,
      }));
    }

    if (result.qaActionNeeded?.reason === "qa_timed_out" && !result.qaActionNeeded.pass && state.qaRun) {
      const elapsedMs = Date.now() - state.qaRun.triggeredAt.getTime();
      void logAuditEventUnchecked(
        db,
        qaRunCompletedEvent({
          repoUrl,
          branch,
          runId: result.qaActionNeeded.runId,
          conclusion: "timed_out",
          durationMs: elapsedMs,
          synthetic: true,
        }),
      );
    }

    await persistDecision(db, repoUrl, branch, {
      id,
      decision: "skip",
      reason: finalReason,
      triggerStateJson,
      proposedVersion,
      qaRunId,
      qaRunSha,
      attemptCount,
    });
    void logAuditEventUnchecked(db, releaseSkippedEvent({ repoUrl, branch, reason: finalReason }));
    // BEC-160: emit a stdout line for every skip so operators tailing
    // docker logs can see the scheduler is alive and why it's skipping.
    log.info(
      { repoUrl, branch, reason: finalReason, mergedCommitsSinceLastTag: state.mergedCommitsSinceLastTag, lastTag: state.lastTag, proposedVersion },
      "tick skip",
    );
    // Slack notification with dedup
    await maybePostSlack(
      slack, slackChannel, db, mutableState.slackDedup,
      `:double_vertical_bar: Release skipped for *${repoUrl}* (${branch}): ${finalReason}`,
      finalReason,
    );
    return;
  }

  if (result.kind === "awaiting-approval") {
    const id = `rd_${randomUUID()}`;
    await persistDecision(db, repoUrl, branch, {
      id,
      decision: "awaiting-approval",
      reason: result.reason,
      triggerStateJson,
      proposedVersion,
    });
    void logAuditEventUnchecked(db, releaseSkippedEvent({ repoUrl, branch, reason: "awaiting-approval" }));
    // BEC-160: stdout visibility for the awaiting-approval skip path.
    log.info(
      { repoUrl, branch, reason: "awaiting-approval", proposedVersion },
      "tick skip",
    );
    // Always post on first transition to awaiting-approval (bypass dedup).
    // Reset lastSkipReason so a subsequent regular-skip will re-post.
    mutableState.slackDedup.lastSkipReason = null;
    await maybePostSlack(
      slack, slackChannel, db, mutableState.slackDedup,
      `:hourglass_flowing_sand: Release ready for *${repoUrl}* (${branch}): bumping ${proposedVersion} (${state.mergedCommitsSinceLastTag} commits since last tag). Run \`/release approve\` to fire.`,
      null,
    );
    return;
  }

  // Fire — create tag + release.
  const id = `rd_${randomUUID()}`;
  const githubResult = await createTagAndRelease({
    octokit,
    ...parseRepoFromUrl(repoUrl),
    tag: proposedVersion,
    sha: state.headSha,
  });

  if (githubResult.kind === "tag_exists") {
    await persistDecision(db, repoUrl, branch, {
      id,
      decision: "skip",
      reason: "tag_exists",
      triggerStateJson,
      proposedVersion,
    });
    void logAuditEventUnchecked(db, releaseTagConflictEvent({ repoUrl, branch, tag: proposedVersion }));
    // BEC-160: stdout visibility for the tag-exists skip path.
    log.info(
      { repoUrl, branch, reason: "tag_exists", proposedVersion },
      "tick skip",
    );
    return;
  }

  if (githubResult.kind === "release_create_failed") {
    // Tag was created; release-creation failed. Write a single skip row with the
    // partial-fire details so an operator can see what happened and clean up the
    // orphaned tag manually. v1 does NOT retry release-creation across ticks
    // (the tag is now committed, so the next tick would hit `tag_exists` and
    // skip again — see plan §"Known v1 simplifications"). Proper retry is a v2
    // feature requiring a tick-start sweep that calls only `createRelease` for
    // matching fire-pending rows.
    await persistDecision(db, repoUrl, branch, {
      id,
      decision: "skip",
      reason: "release_create_failed",
      triggerStateJson,
      proposedVersion,
      firedTag: proposedVersion,
      firedSha: state.headSha,
    });
    void logAuditEventUnchecked(
      db,
      releasePartialEvent({ repoUrl, branch, tag: proposedVersion, attemptCount: 1 }),
    );
    log.error(
      { repoUrl, branch, tag: proposedVersion, msg: githubResult.message },
      "release create failed — tag exists in GitHub but release page not created; manual cleanup required",
    );
    return;
  }

  if (githubResult.kind === "other_error") {
    await persistDecision(db, repoUrl, branch, {
      id,
      decision: "skip",
      reason: "tag_create_error",
      triggerStateJson,
      proposedVersion,
    });
    void logAuditEventUnchecked(db, releaseSkippedEvent({ repoUrl, branch, reason: "tag_create_error" }));
    log.error({ err: githubResult.message, repoUrl, branch }, "createTagAndRelease unknown error — wrote skip row");
    return;
  }

  // ok — fire succeeded.
  await persistDecision(db, repoUrl, branch, {
    id,
    decision: "fire",
    reason: "all triggers passed",
    triggerStateJson,
    proposedVersion,
    firedTag: proposedVersion,
    firedSha: state.headSha,
  });
  if (state.hasFreshApproval) {
    await consumeApprovalRow(db, repoUrl, branch, id);
  }
  void logAuditEventUnchecked(
    db,
    releaseFiredEvent({
      repoUrl,
      branch,
      tag: proposedVersion,
      sha: state.headSha,
      mergedPrCount: state.mergedCommitsSinceLastTag,
    }),
  );
  // BEC-160: stdout visibility for the fire path. A successful release is a
  // production event — operators must see it in `docker logs`, not just the
  // audit table. Slack-suppressed deployments would otherwise be silent.
  log.info(
    { repoUrl, branch, tag: proposedVersion, sha: state.headSha, mergedPrCount: state.mergedCommitsSinceLastTag, releaseUrl: githubResult.releaseUrl },
    "tick fire",
  );
  await maybePostSlack(
    slack, slackChannel, db, mutableState.slackDedup,
    `:rocket: Released *${proposedVersion}* for ${repoUrl} (${branch}). ${githubResult.releaseUrl}`,
    null,
  );
  // Reset Slack dedup so the next skip re-posts.
  mutableState.slackDedup.lastSkipReason = null;
}
