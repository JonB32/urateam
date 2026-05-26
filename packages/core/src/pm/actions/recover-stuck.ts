import type { AnyDb } from "../../db/client.js";
import { pipelineRuns } from "../../db/schema.js";
import { eq, inArray } from "drizzle-orm";
import { getActiveAndRecentIssueIds } from "./db-queries.js";
import { resolveWorkflowStates } from "../linear-helpers.js";
import { resolveIssueRelations } from "../../util/linear.js";
import { createLogger } from "../../logger.js";
import {
  logAuditEventUnchecked,
  pmRecoveredLongRunningEvent,
  pmSkippedAlreadyShippedEvent,
} from "../../audit/index.js";
import type { LinearClient } from "@linear/sdk";

const log = createLogger({ component: "PmAgent:recoverStuck" });

export interface RecoverStuckInput {
  linearClient: Pick<LinearClient, "issues" | "workflowStates" | "updateIssue" | "createComment">;
  db: AnyDb;
  teamIds: string[];
  /** Linear state name to move stuck issues into. */
  targetState: "Backlog" | "Todo";
  /** Maximum number of stuck issues to process per PM Agent tick (rate limiter). */
  maxPerTick: number;
  /**
   * BEC-184: Age threshold (in minutes) after which a 'running' pipeline run is
   * considered zombie/stuck and eligible for recovery. Defaults to 60 minutes.
   * Set via PM_AGENT_STUCK_RUN_AGE_MIN env var.
   */
  stuckRunAgeMinutes?: number;
  /** Pre-fetched workflow state map (`${teamId}:${stateName}` → stateId). */
  stateMap?: Map<string, string>;
  /** Called with all successfully recovered issues for Slack notification. */
  postSlackNotification?: (issues: StuckIssueResult[]) => Promise<void>;
}

export interface StuckIssueResult {
  /** Linear issue UUID (internal ID) */
  issueId: string;
  /** Human-readable identifier, e.g. "BEC-91" */
  identifier: string;
  title: string;
  previousState: string;
  lastRunStatus: string | null;
  /**
   * BEC-165: includes "In Review" when the open-PR override redirects
   * (last run completed AND has a pr_url AND a workspace In Review state
   * exists). Otherwise the caller's input targetState ("Backlog" | "Todo").
   */
  targetState: "Backlog" | "Todo" | "In Review";
  /**
   * BEC-184: set to true when this issue was recovered due to a long-running
   * (zombie) run, as opposed to a failed/completed stuck run.
   */
  recoveredLongRunning?: boolean;
}

/**
 * Detects Linear issues that are stuck in "In Progress" with no active pipeline run,
 * moves them to the configured target state (Backlog or Todo), and returns results.
 *
 * An issue is considered "stuck" when:
 *  - Its Linear state is "In Progress"
 *  - There is no pipeline_runs row with status "running" or "queued" for that issue
 *
 * BEC-184: Additionally, issues whose most recent run has status "running" but
 * started more than `stuckRunAgeMinutes` minutes ago are treated as zombie runs.
 * The `pipeline_runs` row is marked status='failed' and the Linear issue is moved
 * to the target state. An audit event `pm.recovered_long_running` is emitted.
 *
 * Rate-limited to `maxPerTick` issues per tick to prevent flooding.
 *
 * **Hard limit:** The Linear query uses `first: 50`, which means at most 50 issues are
 * returned per tick. If exactly 50 results are returned, the query may be truncated and
 * additional stuck issues may exist beyond the first page. In that case, a warning is
 * logged with the message "stuck-issue query may be truncated — consider pagination".
 * A future improvement would implement cursor-based pagination to handle this edge case.
 */
export async function recoverStuckInProgressIssues(
  input: RecoverStuckInput,
): Promise<StuckIssueResult[]> {
  const { linearClient, db, teamIds, targetState, maxPerTick, postSlackNotification } = input;
  const stuckRunAgeMinutes = input.stuckRunAgeMinutes ?? 60;
  const stuckRunAgeMs = stuckRunAgeMinutes * 60 * 1000;

  // 1. Query Linear for all "In Progress" issues across all configured teams
  const issuesResponse = await linearClient.issues({
    filter: {
      team: { id: { in: teamIds } },
      state: { name: { eq: "In Progress" } },
    },
    first: 50,
  });
  const inProgressIssues: any[] = issuesResponse.nodes ?? [];

  // Warn when the hard cap of 50 is hit — additional stuck issues may exist beyond page 1
  if (inProgressIssues.length === 50) {
    log.warn(
      { count: inProgressIssues.length },
      "stuck-issue query may be truncated — consider pagination",
    );
  }

  if (inProgressIssues.length === 0) {
    log.debug("no In Progress issues found");
    return [];
  }

  // 2. Fetch active and recently-processed issue IDs in one shared helper.
  //    BEC-184: pass stuckRunAgeMs so zombie running runs are excluded from activeIssueIds.
  const { activeIssueIds, recentlyProcessed } = await getActiveAndRecentIssueIds(
    db,
    undefined,
    stuckRunAgeMs,
  );

  // 3. Identify stuck issues: In Progress in Linear but no active DB run
  // NOTE: DB stores issue.identifier (e.g. "BEC-120"), not issue.id (Linear UUID)
  const stuckIssues = inProgressIssues.filter(
    (issue: any) =>
      !activeIssueIds.has(issue.identifier) &&
      !recentlyProcessed.has(issue.identifier),
  );

  if (stuckIssues.length === 0) {
    log.debug("all In Progress issues have active pipeline runs — none stuck");
    return [];
  }

  log.info(
    {
      totalInProgress: inProgressIssues.length,
      stuckCount: stuckIssues.length,
      rateLimitedTo: Math.min(stuckIssues.length, maxPerTick),
    },
    "stuck In Progress issues detected",
  );

  // 4. Apply rate limit — only process up to maxPerTick per tick
  const toProcess = stuckIssues.slice(0, maxPerTick);
  const stuckIdentifiers = toProcess.map((i: any) => i.identifier);

  // 5. Batch-fetch most recent pipeline run status + prUrl + id for each stuck issue.
  //    BEC-165: prUrl is needed for the open-PR override below.
  //    BEC-184: id is needed to update the run row for long-running zombie runs.
  const lastRunStatusMap = new Map<string, string>();
  const lastRunPrUrlMap = new Map<string, string | null>();
  const lastRunIdMap = new Map<string, string | null>();
  const lastRunStartedAtMap = new Map<string, Date | null>();
  const lastRunAutoMergedMap = new Map<string, boolean>();
  if (stuckIdentifiers.length > 0) {
    const runs = await db
      .select({
        id: pipelineRuns.id,
        issueId: pipelineRuns.issueId,
        status: pipelineRuns.status,
        startedAt: pipelineRuns.startedAt,
        prUrl: pipelineRuns.prUrl,
        autoMerged: pipelineRuns.autoMerged,
      })
      .from(pipelineRuns)
      .where(inArray(pipelineRuns.issueId, stuckIdentifiers));

    // Pre-compute timestamps before sorting to avoid O(N log N) Date allocations
    // inside the comparator (Date objects would be created on every comparison otherwise).
    const runsWithTime = (runs as any[]).map((r) => ({
      ...r,
      _time: r.startedAt ? new Date(r.startedAt as any).getTime() : 0,
    }));
    // Sort descending by startedAt to get the most recent run per issue
    const sorted = runsWithTime.sort((a, b) => b._time - a._time);
    for (const run of sorted) {
      if (!lastRunStatusMap.has(run.issueId)) {
        lastRunStatusMap.set(run.issueId, run.status);
        lastRunPrUrlMap.set(run.issueId, run.prUrl ?? null);
        lastRunIdMap.set(run.issueId, run.id ?? null);
        lastRunStartedAtMap.set(
          run.issueId,
          run.startedAt ? new Date(run.startedAt as any) : null,
        );
        lastRunAutoMergedMap.set(run.issueId, run.autoMerged === true);
      }
    }
  }

  // 6. Resolve target state IDs from the stateMap (fetches from Linear if not provided)
  const stateMap =
    input.stateMap ?? (await resolveWorkflowStates(linearClient, teamIds));

  const results: StuckIssueResult[] = [];

  // Pre-fetch all issue relations in parallel before entering the loop.
  // Each issue's team/state/labels are independent, so a single Promise.all
  // reduces wall-clock time from O(N × RTT) to O(RTT) for the batch.
  const allIssueRelations = await Promise.all(toProcess.map((i) => resolveIssueRelations(i)));

  for (let issueIdx = 0; issueIdx < toProcess.length; issueIdx++) {
    const issue = toProcess[issueIdx]!;
    const { team, state: issueStateRelation } = allIssueRelations[issueIdx]!;
    const teamId = team?.id;
    const lastRunStatus = lastRunStatusMap.get(issue.identifier) ?? null;
    const lastRunPrUrl = lastRunPrUrlMap.get(issue.identifier) ?? null;
    const lastRunId = lastRunIdMap.get(issue.identifier) ?? null;
    const lastRunStartedAt = lastRunStartedAtMap.get(issue.identifier) ?? null;
    const lastRunAutoMerged = lastRunAutoMergedMap.get(issue.identifier) ?? false;

    // BEC-262: If the most-recent run completed AND was auto-merged, the work
    // is already shipped. Any "In Progress" state here was set by an external
    // source (e.g. Linear PR-automation triggered by a sidecar PR mentioning
    // the issue ID). Don't transition state or post a comment — the issue is done.
    if (lastRunStatus === "completed" && lastRunAutoMerged) {
      log.info(
        { identifier: issue.identifier, prUrl: lastRunPrUrl },
        "skipping already-shipped issue — last run auto-merged, In Progress set by external source",
      );
      void logAuditEventUnchecked(
        db,
        pmSkippedAlreadyShippedEvent({ issueId: issue.identifier, prUrl: lastRunPrUrl ?? undefined }),
      );
      continue;
    }

    // BEC-184: Detect zombie (long-running) runs. When the most recent run has
    // status='running' but is NOT in activeIssueIds, it means getActiveAndRecentIssueIds
    // excluded it because it started more than stuckRunAgeMs ago.
    const isLongRunningRun =
      lastRunStatus === "running" && lastRunId !== null;

    // BEC-165: open-PR override — if the most recent run completed AND
    // produced a PR, the runner forgot to move Linear → "In Review" (the
    // bug fixed in linear.ts onPipelineComplete). Recovering to "Backlog"
    // here would re-promote the issue and burn another full pipeline cycle
    // on already-merged-or-pending work. Redirect to "In Review" instead.
    // Falls back to caller's targetState if the workspace lacks an "In
    // Review" state (custom Linear column setups).
    const inReviewOverride =
      lastRunStatus === "completed" && lastRunPrUrl !== null && teamId
        ? stateMap.get(`${teamId}:In Review`)
        : undefined;
    const effectiveTargetState: "Backlog" | "Todo" | "In Review" =
      inReviewOverride !== undefined ? "In Review" : targetState;
    const effectiveTargetStateId = inReviewOverride
      ?? (teamId ? stateMap.get(`${teamId}:${targetState}`) : undefined);

    if (!effectiveTargetStateId) {
      log.warn(
        { identifier: issue.identifier, teamId, targetState: effectiveTargetState },
        "no target state ID found for team — skipping stuck issue",
      );
      continue;
    }

    const previousStateName: string = issueStateRelation?.name ?? "In Progress";

    try {
      // BEC-184: For long-running zombie runs, mark the pipeline_runs row as
      // failed before moving Linear state, so future PM ticks don't re-detect
      // the same run as active.
      if (isLongRunningRun && lastRunId) {
        const errorMessage = `recovered: running > ${stuckRunAgeMinutes} min with no completion`;
        await db
          .update(pipelineRuns)
          .set({
            status: "failed",
            errorMessage,
            completedAt: new Date(),
          })
          .where(eq(pipelineRuns.id, lastRunId));

        log.info(
          {
            identifier: issue.identifier,
            runId: lastRunId,
            stuckRunAgeMinutes,
          },
          "marked long-running pipeline run as failed",
        );

        // Emit audit event for visibility into zombie run recovery
        if (lastRunStartedAt) {
          void logAuditEventUnchecked(
            db,
            pmRecoveredLongRunningEvent({
              issueId: issue.identifier,
              runId: lastRunId,
              startedAt: lastRunStartedAt,
              stuckRunAgeMinutes,
              targetState: effectiveTargetState,
            }),
          );
        }
      }

      const displayStatus = isLongRunningRun ? "running (marked failed — zombie)" : lastRunStatus;
      const runNote = displayStatus
        ? `Most recent pipeline run status: \`${displayStatus}\`${lastRunPrUrl ? ` (PR: ${lastRunPrUrl})` : ""}.`
        : "No pipeline run record found in the database.";
      const overrideNote = inReviewOverride
        ? "\n\n*BEC-165 override: completed run produced a PR — moving to In Review instead of re-promoting.*"
        : "";
      const longRunningNote = isLongRunningRun
        ? `\n\n*BEC-184: run was still status \`running\` after >${stuckRunAgeMinutes} min — marked as failed and issue recovered.*`
        : "";
      await Promise.all([
        linearClient.updateIssue(issue.id, { stateId: effectiveTargetStateId }),
        linearClient.createComment({
          issueId: issue.id,
          body:
            `🤖 **PM Agent — Auto-recovered stuck issue**\n\n` +
            `This issue was detected in **In Progress** state with no active pipeline run. ` +
            `It has been automatically moved to **${effectiveTargetState}** for re-evaluation.\n\n${runNote}${overrideNote}${longRunningNote}`,
        }),
      ]);

      results.push({
        issueId: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        previousState: previousStateName,
        lastRunStatus,
        targetState: effectiveTargetState,
        recoveredLongRunning: isLongRunningRun,
      });

      log.info(
        {
          identifier: issue.identifier,
          previousState: previousStateName,
          lastRunStatus,
          targetState: effectiveTargetState,
          inReviewOverride: inReviewOverride !== undefined,
          recoveredLongRunning: isLongRunningRun,
        },
        "auto-recovered stuck In Progress issue",
      );
    } catch (err) {
      log.error(
        { identifier: issue.identifier, err },
        "failed to auto-recover stuck issue",
      );
    }
  }

  // 7. Send Slack notification for all recovered issues
  if (results.length > 0 && postSlackNotification) {
    try {
      await postSlackNotification(results);
    } catch (err) {
      log.error({ err }, "failed to post Slack notification for stuck issue recovery");
    }
  }

  return results;
}
