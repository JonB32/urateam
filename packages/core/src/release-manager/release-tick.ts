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
import { and, desc, eq, lt } from "drizzle-orm";
import type { Octokit } from "@octokit/rest";
import type { LinearClient } from "@linear/sdk";
import type { AnyDb } from "../db/client.js";
import { releaseDecisions } from "../db/schema.js";
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
import {
  maybePostSlack,
  persistDecision,
  consumeApprovalRow,
  getMaxAttemptCountForReason,
  tryFileQaGapIssue,
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

/** Maximum createRelease attempts before a fire-pending row is exhausted. */
const MAX_FIRE_PENDING_ATTEMPTS = 3;

/**
 * Retry sweep for fire-pending rows.
 *
 * Called at the top of every tick, before collectState, so the state query
 * sees the result of any successful retry (avoiding a spurious
 * `manual_tag_detected` skip on the same tick).
 *
 * For each fire-pending row with attemptCount < MAX_FIRE_PENDING_ATTEMPTS:
 *   - Verify the tag still exists in GitHub (skip if 404, fail-open on error).
 *   - Call createRelease only (the tag already exists).
 *   - Success → update the row to decision="fire", audit releaseFiredEvent.
 *   - Failure → increment attemptCount. When it reaches the cap, write a new
 *     skip row with reason="release_create_failed_after_retries" and audit
 *     releasePartialEvent.
 */
async function sweepFirePendingRows(ctx: TickContext): Promise<void> {
  const { db, octokit, repoUrl, branch, slack, mutableState, config } = ctx;

  const pending = await (db as any)
    .select()
    .from(releaseDecisions)
    .where(
      and(
        eq(releaseDecisions.repoUrl, repoUrl),
        eq(releaseDecisions.branch, branch),
        eq(releaseDecisions.decision, "fire-pending"),
        lt(releaseDecisions.attemptCount, MAX_FIRE_PENDING_ATTEMPTS),
      ),
    )
    .orderBy(desc(releaseDecisions.decidedAt));

  if (pending.length === 0) return;

  const { owner, repo } = parseRepoFromUrl(repoUrl);

  for (const row of pending) {
    const tag: string = row.firedTag;
    const sha: string = row.firedSha ?? "";

    if (!tag) continue;

    // Verify the tag still exists in GitHub before attempting createRelease.
    try {
      await octokit.git.getRef({ owner, repo, ref: `tags/${tag}` });
    } catch (refErr: any) {
      if (refErr?.status === 404) {
        log.info({ repoUrl, branch, tag }, "fire-pending: tag no longer exists — operator cleaned up; skipping retry");
        continue;
      }
      // Network/other error — fail-open and try createRelease anyway.
      log.warn({ err: refErr, repoUrl, branch, tag }, "fire-pending: getRef failed — attempting createRelease anyway");
    }

    let releaseUrl: string | undefined;
    let createFailed = false;

    try {
      const res = await octokit.repos.createRelease({
        owner,
        repo,
        tag_name: tag,
        target_commitish: sha,
        generate_release_notes: true,
      });
      releaseUrl = (res as any)?.data?.html_url ?? `https://github.com/${owner}/${repo}/releases/tag/${tag}`;
    } catch (releaseErr: any) {
      createFailed = true;
      const newAttemptCount = row.attemptCount + 1;

      if (newAttemptCount >= MAX_FIRE_PENDING_ATTEMPTS) {
        const skipId = `rd_${randomUUID()}`;
        await persistDecision(db, repoUrl, branch, {
          id: skipId,
          decision: "skip",
          reason: "release_create_failed_after_retries",
          triggerStateJson: row.triggerStateJson,
          proposedVersion: row.proposedVersion ?? undefined,
          firedTag: tag,
          firedSha: sha,
          attemptCount: newAttemptCount,
        });
        void logAuditEventUnchecked(
          db,
          releasePartialEvent({ repoUrl, branch, tag, attemptCount: newAttemptCount }),
        );
        log.error(
          { repoUrl, branch, tag, attemptCount: newAttemptCount },
          "fire-pending: release creation exhausted retries — manual cleanup required",
        );
      } else {
        await (db as any)
          .update(releaseDecisions)
          .set({ attemptCount: newAttemptCount })
          .where(eq(releaseDecisions.id, row.id));
        log.warn(
          { repoUrl, branch, tag, attemptCount: newAttemptCount, err: releaseErr?.message },
          "fire-pending: createRelease retry failed — will retry next tick",
        );
      }
    }

    if (createFailed) continue;

    // Success — promote row to decision="fire".
    await (db as any)
      .update(releaseDecisions)
      .set({ decision: "fire" })
      .where(eq(releaseDecisions.id, row.id));

    let mergedPrCount = 0;
    try {
      mergedPrCount = JSON.parse(row.triggerStateJson)?.mergedCommitsSinceLastTag ?? 0;
    } catch {}

    void logAuditEventUnchecked(
      db,
      releaseFiredEvent({ repoUrl, branch, tag, sha, mergedPrCount }),
    );
    log.info({ repoUrl, branch, tag, releaseUrl }, "fire-pending: retry succeeded");
    await maybePostSlack(
      slack,
      config.slackChannel,
      db,
      mutableState.slackDedup,
      `:rocket: Released *${tag}* for ${repoUrl} (${branch}) — retry succeeded. ${releaseUrl}`,
      null,
    );
    mutableState.slackDedup.lastSkipReason = null;
  }
}

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

  // Retry any fire-pending rows before collecting state so that a successfully
  // retried tag is reflected in the state query (preventing spurious
  // manual_tag_detected on the same tick).
  try {
    await sweepFirePendingRows(ctx);
  } catch (sweepErr) {
    log.error({ err: sweepErr, repoUrl, branch }, "sweepFirePendingRows failed — continuing tick");
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
      // Look up the highest attempt count across all qa_needs_trigger rows for this
      // (branch, sha) pair. Using MAX instead of ORDER BY + LIMIT 1 to be stable
      // when multiple rows share the same decidedAt timestamp.
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
        attemptCount = 0; // reset on successful dispatch
        qaRunId = dispatch.runId;
        qaRunSha = state.headSha;
      } else if (dispatch.kind === "dispatch_404") {
        // Workflow disappeared between state cache and dispatch — drop into gap-issue path.
        finalReason = "qa_no_workflow";
        if (linear) {
          const gapResult = await tryFileQaGapIssue({
            db, linear, repoUrl, branch,
            workflowPath: config.triggers.qaCheck!.workflow,
            linearTeamId: config.triggers.qaCheck!.linearTeamId,
          });
          finalReason = gapResult.finalReason;
          attemptCount = gapResult.attemptCount;
        } else {
          log.error({ repoUrl, branch }, "qaCheck requires Linear client but none configured — skipping gap-issue file");
        }
      } else if (dispatch.kind === "dispatch_422") {
        finalReason = "qa_dispatch_error";
        attemptCount = 99; // permanent skip — workflow misconfigured, retrying won't help
      } else if (dispatch.kind === "dispatch_pending") {
        // GitHub eventual-consistency window. Don't count against retry budget; next tick
        // will re-evaluate and the run should be findable by then.
        // Tag with qaRunSha so the per-SHA retry counter query can find these rows.
        qaRunSha = state.headSha;
        // attemptCount stays as-is; finalReason stays as "qa_needs_trigger" for next tick to retry.
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
      if (linear) {
        const gapResult = await tryFileQaGapIssue({
          db, linear, repoUrl, branch,
          workflowPath: config.triggers.qaCheck!.workflow,
          linearTeamId: config.triggers.qaCheck!.linearTeamId,
        });
        finalReason = gapResult.finalReason;
        attemptCount = gapResult.attemptCount;
      } else {
        log.error({ repoUrl, branch }, "qaCheck requires Linear client but none configured — skipping gap-issue file");
      }
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
    // Tag was created but release-creation failed. Write a fire-pending row so
    // the tick-start sweep can retry createRelease on subsequent ticks (up to
    // MAX_FIRE_PENDING_ATTEMPTS total). No releasePartialEvent is emitted here;
    // that fires only after all retry attempts are exhausted.
    await persistDecision(db, repoUrl, branch, {
      id,
      decision: "fire-pending",
      reason: "release_create_failed",
      triggerStateJson,
      proposedVersion,
      firedTag: proposedVersion,
      firedSha: state.headSha,
      attemptCount: 1,
    });
    log.warn(
      { repoUrl, branch, tag: proposedVersion, msg: githubResult.message },
      "release create failed after tag was created — will retry release creation next tick",
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
