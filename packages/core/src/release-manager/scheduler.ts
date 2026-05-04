import { randomUUID } from "node:crypto";
import { eq, isNull, and, desc, max } from "drizzle-orm";
import type { Octokit } from "@octokit/rest";
import type { LinearClient } from "@linear/sdk";
import { Cron } from "croner";
import type { AnyDb } from "../db/client.js";
import { releaseApprovals, releaseDecisions } from "../db/schema.js";
import { createLogger } from "../logger.js";
import { logAuditEventUnchecked } from "../audit/writer.js";
import {
  releaseFiredEvent,
  releaseSkippedEvent,
  releaseTagConflictEvent,
  releasePartialEvent,
  slackPostFailedEvent,
  qaRunCompletedEvent,
} from "../audit/events.js";
import { collectState } from "./state.js";
import { decide } from "./decide.js";
import { bumpFromConfigAndCommits } from "./versioning.js";
import { createTagAndRelease, parseRepoFromUrl } from "./github.js";
import type { ReleaseManagerConfig } from "./types.js";
import { triggerWorkflow, pollWorkflowRun, workflowFileExists } from "../qa/github.js";
import { fileGapIssue, markGapResolved } from "../qa/gap.js";

const log = createLogger({ component: "ReleaseManager:scheduler" });

export interface SlackPoster {
  postMessage: (channel: string, text: string) => Promise<boolean>;
}

export interface ReleaseManagerSchedulerInput {
  config: ReleaseManagerConfig;
  db: AnyDb;
  octokit: Octokit;
  /** BEC-136: Linear client for filing QA gap issues. Required when qaCheck is configured. */
  linear?: LinearClient;
  repoUrl: string;
  /** Injectable license check — production passes `() => isFeatureLicensed("release-manager")`. */
  isLicensed: () => boolean;
  slack?: SlackPoster;
}

export interface ReleaseManagerScheduler {
  /** Run a single decision cycle. Used directly from tests + by the cron driver. */
  tick(): Promise<void>;
  /** Start the cron driver (no-op until called). */
  start(): void;
  /** Stop the cron driver (idempotent). */
  stop(): void;
  /** /release skip → pause future ticks until this timestamp. */
  pauseUntil(ts: Date): void;
}

const SLACK_DEDUP_WINDOW_MS = 24 * 3600 * 1000;

export function createReleaseManagerScheduler(
  input: ReleaseManagerSchedulerInput,
): ReleaseManagerScheduler {
  const { config, db, octokit, linear, repoUrl, isLicensed, slack } = input;
  const branch = config.branch;
  const slackChannel = config.slackChannel;

  // Per-(repo, branch) in-memory dedup state.
  let lastSlackSkipReason: string | null = null;
  let lastSlackPostAt: number = 0;
  let pausedUntilTs: number = 0;
  let cronJob: Cron | null = null;
  let licenseWarnLogged = false;

  function approvalTtlMs(): number {
    const hours = config.triggers.timeSinceLastHours;
    if (hours && hours > 0) return hours * 3600 * 1000;
    return 24 * 3600 * 1000;
  }

  async function maybePostSlack(text: string, currentSkipReason: string | null): Promise<void> {
    if (!slack || !slackChannel) return;
    const now = Date.now();
    // Always post when transitioning to fire / awaiting-approval.
    // Otherwise dedup: same reason + within window → suppress.
    if (currentSkipReason) {
      const sameReason = currentSkipReason === lastSlackSkipReason;
      const withinWindow = now - lastSlackPostAt < SLACK_DEDUP_WINDOW_MS;
      if (sameReason && withinWindow) return;
    }
    const ok = await slack.postMessage(slackChannel, text).catch(() => false);
    if (!ok) {
      void logAuditEventUnchecked(db, slackPostFailedEvent({ channel: slackChannel, reason: "post_returned_false" }));
      return;
    }
    lastSlackPostAt = now;
    lastSlackSkipReason = currentSkipReason;
  }

  async function persistDecision(row: {
    id: string;
    decision: string;
    reason: string;
    triggerStateJson: string;
    proposedVersion?: string;
    firedTag?: string;
    firedSha?: string;
    attemptCount?: number;
    qaRunId?: number;
    qaRunSha?: string;
  }): Promise<void> {
    await (db as any).insert(releaseDecisions).values({
      id: row.id,
      repoUrl,
      branch,
      decidedAt: new Date(),
      decision: row.decision,
      reason: row.reason,
      triggerStateJson: row.triggerStateJson,
      proposedVersion: row.proposedVersion,
      firedTag: row.firedTag,
      firedSha: row.firedSha,
      attemptCount: row.attemptCount ?? 0,
      qaRunId: row.qaRunId,
      qaRunSha: row.qaRunSha,
    });
  }

  async function consumeApprovalRow(decisionId: string): Promise<void> {
    // Mark the most-recent fresh approval as consumed by this decision.
    const fresh = await (db as any)
      .select({ id: releaseApprovals.id })
      .from(releaseApprovals)
      .where(
        and(
          eq(releaseApprovals.repoUrl, repoUrl),
          eq(releaseApprovals.branch, branch),
          isNull(releaseApprovals.consumedAt),
        ),
      )
      .orderBy(desc(releaseApprovals.approvedAt))
      .limit(1);
    if (fresh?.[0]?.id) {
      await (db as any)
        .update(releaseApprovals)
        .set({ consumedAt: new Date(), consumedByDecisionId: decisionId })
        .where(eq(releaseApprovals.id, fresh[0].id));
    }
  }

  async function tick(): Promise<void> {
    if (!isLicensed()) {
      if (!licenseWarnLogged) {
        log.warn({ repoUrl, branch }, "release-manager unlicensed — skipping ticks");
        licenseWarnLogged = true;
      }
      return;
    }
    if (Date.now() < pausedUntilTs) {
      log.info({ pausedUntilTs }, "scheduler paused (via /release skip) — skipping tick");
      return;
    }

    let state;
    try {
      state = await collectState({
        octokit, db, repoUrl, branch, approvalTtlMs: approvalTtlMs(),
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
      await persistDecision({
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
        // Look up the highest attempt count across all qa_needs_trigger rows for this branch.
        // Using MAX instead of ORDER BY + LIMIT 1 to be stable when multiple rows share the same decidedAt.
        const prevAttempts = await (db as any)
          .select({ maxAttempts: max(releaseDecisions.attemptCount) })
          .from(releaseDecisions)
          .where(
            and(
              eq(releaseDecisions.repoUrl, repoUrl),
              eq(releaseDecisions.branch, branch),
              eq(releaseDecisions.reason, "qa_needs_trigger"),
            ),
          );
        attemptCount = ((prevAttempts?.[0]?.maxAttempts as number) ?? 0);

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
            await fileGapIssue({
              db,
              linear,
              repoUrl,
              branch,
              workflowPath: config.triggers.qaCheck!.workflow,
              linearTeamId: config.triggers.qaCheck!.linearTeamId,
            });
          } else {
            log.error({ repoUrl, branch }, "qaCheck requires Linear client but none configured — skipping gap-issue file");
          }
        } else if (dispatch.kind === "dispatch_422") {
          finalReason = "qa_dispatch_error";
          attemptCount = 99; // permanent skip — workflow misconfigured, retrying won't help
        } else {
          // dispatch_error — increment attempt counter
          attemptCount += 1;
          if (attemptCount >= 3) {
            finalReason = "qa_dispatch_error";
          }
        }
      } else if (result.qaActionNeeded?.reason === "qa_no_workflow") {
        if (linear) {
          await fileGapIssue({
            db,
            linear,
            repoUrl,
            branch,
            workflowPath: config.triggers.qaCheck!.workflow,
            linearTeamId: config.triggers.qaCheck!.linearTeamId,
          });
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

      await persistDecision({
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
      // Slack notification with dedup
      await maybePostSlack(
        `:double_vertical_bar: Release skipped for *${repoUrl}* (${branch}): ${finalReason}`,
        finalReason,
      );
      return;
    }

    if (result.kind === "awaiting-approval") {
      const id = `rd_${randomUUID()}`;
      await persistDecision({
        id,
        decision: "awaiting-approval",
        reason: result.reason,
        triggerStateJson,
        proposedVersion,
      });
      void logAuditEventUnchecked(db, releaseSkippedEvent({ repoUrl, branch, reason: "awaiting-approval" }));
      // Always post on first transition to awaiting-approval (bypass dedup).
      // Reset lastSlackSkipReason so a subsequent regular-skip will re-post.
      lastSlackSkipReason = null;
      await maybePostSlack(
        `:hourglass_flowing_sand: Release ready for *${repoUrl}* (${branch}): bumping ${proposedVersion} (${state.mergedCommitsSinceLastTag} commits since last tag). Run \`/release approve\` to fire.`,
        null,
      );
      return;
    }

    // 3. Fire — create tag + release.
    const id = `rd_${randomUUID()}`;
    const githubResult = await createTagAndRelease({
      octokit,
      ...parseRepoFromUrl(repoUrl),
      tag: proposedVersion,
      sha: state.headSha,
    });

    if (githubResult.kind === "tag_exists") {
      await persistDecision({
        id,
        decision: "skip",
        reason: "tag_exists",
        triggerStateJson,
        proposedVersion,
      });
      void logAuditEventUnchecked(db, releaseTagConflictEvent({ repoUrl, branch, tag: proposedVersion }));
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
      await persistDecision({
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
      await persistDecision({
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

    // ok
    await persistDecision({
      id,
      decision: "fire",
      reason: "all triggers passed",
      triggerStateJson,
      proposedVersion,
      firedTag: proposedVersion,
      firedSha: state.headSha,
    });
    if (state.hasFreshApproval) {
      await consumeApprovalRow(id);
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
    await maybePostSlack(
      `:rocket: Released *${proposedVersion}* for ${repoUrl} (${branch}). ${githubResult.releaseUrl}`,
      null,
    );
    // Reset Slack dedup so the next skip re-posts.
    lastSlackSkipReason = null;
  }

  function start() {
    if (cronJob) return;
    cronJob = new Cron(config.schedule, () => {
      tick().catch((err) => log.error({ err, repoUrl, branch }, "release-manager tick errored"));
    });
    log.info({ schedule: config.schedule, repoUrl, branch }, "release-manager scheduler started");
  }

  function stop() {
    cronJob?.stop();
    cronJob = null;
  }

  function pauseUntil(ts: Date) {
    pausedUntilTs = ts.getTime();
  }

  return { tick, start, stop, pauseUntil };
}
