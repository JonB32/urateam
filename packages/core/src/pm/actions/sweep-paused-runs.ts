import type { AnyDb } from "../../db/client.js";
import { pipelineRuns } from "../../db/schema.js";
import { and, eq, lt } from "drizzle-orm";
import { createLogger } from "../../logger.js";
import { removeActiveWork } from "../coordination.js";
import { cleanupWorktrees } from "../../repo/git.js";
import { logAuditEventUnchecked, pmPausedRunExpiredEvent } from "../../audit/index.js";
import type { LinearClient } from "@linear/sdk";

const log = createLogger({ component: "PmAgent:sweep-paused-runs" });

const DEFAULT_MAX_AGE_MINUTES = 4320; // 72 hours
const ESCALATION_LABEL = "needs-design";

export interface SweepExpiredPausedRunsResult {
  cancelled: number;
  issueIds: string[];
}

/**
 * BEC-271 — PM tick sweep that expires paused pipeline runs.
 *
 * Queries pipeline_runs WHERE status='paused' AND startedAt < now - thresholdMinutes.
 * For each expired run:
 *  1. Marks it cancelled with error_message='await-approval timeout after Nh'
 *  2. Removes its active_work entry
 *  3. Adds the 'needs-design' label to the Linear issue and posts a comment
 *  4. Emits a pm.paused_run_expired audit event
 *
 * After all runs are processed, calls cleanupWorktrees(agentRunDir, thresholdHours) to
 * prune expired on-disk worktree directories.
 *
 * Escape hatch: URATEAM_DISABLE_PAUSED_RUN_EXPIRY=true (strict equality) skips the sweep.
 * Threshold: PM_AGENT_AWAIT_APPROVAL_MAX_AGE_MIN env var (default 4320 min = 72h).
 */
export async function sweepExpiredPausedRuns(
  db: AnyDb,
  linearClient: Pick<LinearClient, "searchIssues" | "issueLabels" | "updateIssue" | "createComment">,
  opts: {
    thresholdMinutes?: number;
    agentRunDir?: string;
  } = {},
): Promise<SweepExpiredPausedRunsResult> {
  if (process.env.URATEAM_DISABLE_PAUSED_RUN_EXPIRY === "true") {
    log.debug("URATEAM_DISABLE_PAUSED_RUN_EXPIRY=true — paused-run expiry sweep disabled");
    return { cancelled: 0, issueIds: [] };
  }

  const thresholdMinutes = opts.thresholdMinutes ?? DEFAULT_MAX_AGE_MINUTES;
  const thresholdHours = thresholdMinutes / 60;
  const cutoff = new Date(Date.now() - thresholdMinutes * 60 * 1000);

  const expiredRuns = (await db
    .select({
      id: pipelineRuns.id,
      issueId: pipelineRuns.issueId,
      startedAt: pipelineRuns.startedAt,
    })
    .from(pipelineRuns)
    .where(
      and(eq(pipelineRuns.status, "paused"), lt(pipelineRuns.startedAt, cutoff)),
    )) as Array<{ id: string; issueId: string; startedAt: unknown }>;

  if (expiredRuns.length === 0) {
    log.debug("no expired paused runs found");
    return { cancelled: 0, issueIds: [] };
  }

  log.info(
    { count: expiredRuns.length, thresholdHours },
    "BEC-271: expired paused runs detected — cancelling",
  );

  // Resolve the needs-design label ID once for all runs in this tick.
  let needsDesignLabelId: string | undefined;
  try {
    const allLabels = await linearClient.issueLabels({ first: 100 });
    for (const label of (allLabels.nodes ?? []) as Array<{ id: string; name: string }>) {
      if (label.name.toLowerCase() === ESCALATION_LABEL) {
        needsDesignLabelId = label.id;
        break;
      }
    }
    if (!needsDesignLabelId) {
      log.warn(
        { label: ESCALATION_LABEL },
        "BEC-271: 'needs-design' label not found in Linear — issues will not be relabeled",
      );
    }
  } catch (err) {
    log.warn({ err }, "BEC-271: failed to look up needs-design label");
  }

  const now = new Date();
  const cancelledIssueIds: string[] = [];

  for (const run of expiredRuns) {
    const startedAt = run.startedAt ? new Date(run.startedAt as string | number) : null;
    const ageMs = startedAt ? now.getTime() - startedAt.getTime() : thresholdMinutes * 60 * 1000;
    const ageHours = Math.round(ageMs / (1000 * 60 * 60));
    const errorMessage = `await-approval timeout after ${ageHours}h`;

    try {
      // 1. Mark the pipeline run cancelled in DB.
      await db
        .update(pipelineRuns)
        .set({ status: "cancelled", completedAt: now, errorMessage })
        .where(eq(pipelineRuns.id, run.id));

      // 2. Remove active_work entry (removeActiveWork is already fail-open).
      await removeActiveWork(db, run.id);

      // 3. Emit audit event (fire-and-forget via logAuditEventUnchecked).
      void logAuditEventUnchecked(
        db,
        pmPausedRunExpiredEvent({ runId: run.id, issueId: run.issueId, ageHours, thresholdHours }),
      );

      cancelledIssueIds.push(run.issueId);
      log.info(
        { runId: run.id, issueId: run.issueId, ageHours },
        "BEC-271: cancelled expired paused run",
      );
    } catch (err) {
      log.error(
        { err, runId: run.id, issueId: run.issueId },
        "BEC-271: failed to cancel expired paused run — skipping",
      );
      continue;
    }

    // 4. Update the Linear issue (best-effort — DB change is already committed above).
    try {
      const searchResult = await linearClient.searchIssues(run.issueId, { first: 1 });
      const issue = (searchResult.nodes as Array<{ id: string; labelIds: string[] }>)[0];

      if (!issue) {
        log.warn({ issueId: run.issueId }, "BEC-271: issue not found in Linear — skipping label update");
        continue;
      }

      if (needsDesignLabelId) {
        const merged = [...new Set([...issue.labelIds, needsDesignLabelId])];
        await linearClient.updateIssue(issue.id, { labelIds: merged });
      }

      await linearClient.createComment({
        issueId: issue.id,
        body:
          `🕐 **PM Agent — await-approval timeout**\n\n` +
          `This run was waiting for human approval for **${ageHours}h** ` +
          `(threshold: ${thresholdHours}h) and has been automatically cancelled.\n\n` +
          `Please review the original triage, address any concerns, and re-open ` +
          `the ticket when ready to retry.`,
      });
    } catch (err) {
      log.warn(
        { err, issueId: run.issueId },
        "BEC-271: failed to update Linear issue — DB run is already cancelled",
      );
    }
  }

  // 5. Prune expired worktree directories (fail-open).
  if (opts.agentRunDir && cancelledIssueIds.length > 0) {
    try {
      const pruned = await cleanupWorktrees(opts.agentRunDir, thresholdHours);
      if (pruned.length > 0) {
        log.info(
          { count: pruned.length, thresholdHours },
          "BEC-271: pruned expired worktree directories",
        );
      }
    } catch (err) {
      log.warn({ err }, "BEC-271: cleanupWorktrees failed — worktrees may remain on disk");
    }
  }

  return { cancelled: cancelledIssueIds.length, issueIds: cancelledIssueIds };
}

/**
 * Parse PM_AGENT_AWAIT_APPROVAL_MAX_AGE_MIN env var.
 * Default: 4320 minutes (72 hours). Clamps to ≥1 minute.
 */
export function parsePausedRunMaxAgeMinutes(envValue: string | undefined): number {
  const parsed = parseInt(envValue ?? "", 10);
  return isNaN(parsed) ? DEFAULT_MAX_AGE_MINUTES : Math.max(1, parsed);
}
