import { randomUUID } from "node:crypto";
import { eq, isNull, and, desc } from "drizzle-orm";
import type { Octokit } from "@octokit/rest";
import { Cron } from "croner";
import type { AnyDb } from "../db/client.js";
import { releaseApprovals, releaseDecisions } from "../db/schema.js";
import { createLogger } from "../logger.js";
import { logAuditEvent } from "../audit/writer.js";
import {
  releaseFiredEvent,
  releaseSkippedEvent,
  releaseTagConflictEvent,
  releasePartialEvent,
  slackPostFailedEvent,
} from "../audit/events.js";
import { collectState } from "./state.js";
import { decide } from "./decide.js";
import { bumpFromConfigAndCommits } from "./versioning.js";
import { createTagAndRelease, parseRepoFromUrl } from "./github.js";
import type { ReleaseManagerConfig } from "./types.js";

const log = createLogger({ component: "ReleaseManager:scheduler" });

export interface SlackPoster {
  postMessage: (channel: string, text: string) => Promise<boolean>;
}

export interface ReleaseManagerSchedulerInput {
  config: ReleaseManagerConfig;
  db: AnyDb;
  octokit: Octokit;
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

const MAX_RETRY_ATTEMPTS = 3;
const SLACK_DEDUP_WINDOW_MS = 24 * 3600 * 1000;

export function createReleaseManagerScheduler(
  input: ReleaseManagerSchedulerInput,
): ReleaseManagerScheduler {
  const { config, db, octokit, repoUrl, isLicensed, slack } = input;
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
      void logAuditEvent(db, slackPostFailedEvent({ channel: slackChannel, reason: "post_returned_false" }));
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
      void logAuditEvent(db, releaseSkippedEvent({ repoUrl, branch, reason: "manual_tag_detected" }));
      log.info({ repoUrl, branch }, "manual tag detected — re-baselining");
      return;
    }

    // 2. Decision.
    const result = decide(state, config.triggers);
    const proposedVersion = bumpFromConfigAndCommits(
      state.lastTag,
      state.commitsSinceLastTag,
      config.versionBump,
    );

    if (result.kind === "skip") {
      const id = `rd_${randomUUID()}`;
      await persistDecision({
        id,
        decision: "skip",
        reason: result.reason,
        triggerStateJson,
        proposedVersion,
      });
      void logAuditEvent(db, releaseSkippedEvent({ repoUrl, branch, reason: result.reason }));
      // Slack notification with dedup
      await maybePostSlack(
        `:double_vertical_bar: Release skipped for *${repoUrl}* (${branch}): ${result.reason}`,
        result.reason,
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
      void logAuditEvent(db, releaseSkippedEvent({ repoUrl, branch, reason: "awaiting-approval" }));
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
      void logAuditEvent(db, releaseTagConflictEvent({ repoUrl, branch, tag: proposedVersion }));
      return;
    }

    if (githubResult.kind === "release_create_failed") {
      // Tag was created; release-creation failed. Increment attempt and write fire-pending.
      const prevAttempt = await (db as any)
        .select({ attemptCount: releaseDecisions.attemptCount })
        .from(releaseDecisions)
        .where(
          and(
            eq(releaseDecisions.repoUrl, repoUrl),
            eq(releaseDecisions.branch, branch),
            eq(releaseDecisions.decision, "fire-pending"),
            eq(releaseDecisions.firedTag, proposedVersion),
          ),
        )
        .limit(1);
      const nextAttempt = ((prevAttempt?.[0]?.attemptCount as number) ?? 0) + 1;
      const decision = nextAttempt >= MAX_RETRY_ATTEMPTS ? "skip" : "fire-pending";
      const reason = decision === "skip" ? "release_create_failed_after_retries" : "release_create_failed_retrying";
      await persistDecision({
        id,
        decision,
        reason,
        triggerStateJson,
        proposedVersion,
        firedTag: proposedVersion,
        firedSha: state.headSha,
        attemptCount: nextAttempt,
      });
      if (decision === "skip") {
        void logAuditEvent(db, releasePartialEvent({ repoUrl, branch, tag: proposedVersion, attemptCount: nextAttempt }));
      }
      log.error({ repoUrl, branch, tag: proposedVersion, attempt: nextAttempt, msg: githubResult.message }, "release create failed");
      return;
    }

    if (githubResult.kind === "other_error") {
      log.error({ err: githubResult.message, repoUrl, branch }, "createTagAndRelease unknown error — not persisting");
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
    void logAuditEvent(
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
