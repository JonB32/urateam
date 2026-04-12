import type { AnyDb } from "../../db/client.js";
import { pipelineRuns } from "../../db/schema.js";
import { inArray } from "drizzle-orm";
import { getActiveAndRecentIssueIds } from "./db-queries.js";
import { resolveWorkflowStates } from "../linear-helpers.js";
import { createLogger } from "../../logger.js";

const log = createLogger({ component: "PmAgent:recoverStuck" });

export interface RecoverStuckInput {
  linearClient: any;
  db: AnyDb;
  teamIds: string[];
  /** Linear state name to move stuck issues into. */
  targetState: "Backlog" | "Todo";
  /** Maximum number of stuck issues to process per PM Agent tick (rate limiter). */
  maxPerTick: number;
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
  targetState: "Backlog" | "Todo";
}

/**
 * Detects Linear issues that are stuck in "In Progress" with no active pipeline run,
 * moves them to the configured target state (Backlog or Todo), and returns results.
 *
 * An issue is considered "stuck" when:
 *  - Its Linear state is "In Progress"
 *  - There is no pipeline_runs row with status "running" or "queued" for that issue
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

  // 2. Fetch active and recently-processed issue IDs in one shared helper
  const { activeIssueIds, recentlyProcessed } = await getActiveAndRecentIssueIds(db);

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

  // 5. Batch-fetch most recent pipeline run status for each stuck issue
  const lastRunStatusMap = new Map<string, string>();
  if (stuckIdentifiers.length > 0) {
    const runs = await db
      .select({
        issueId: pipelineRuns.issueId,
        status: pipelineRuns.status,
        startedAt: pipelineRuns.startedAt,
      })
      .from(pipelineRuns)
      .where(inArray(pipelineRuns.issueId, stuckIdentifiers));

    // Sort descending by startedAt to get the most recent run per issue
    const sorted = [...(runs as any[])].sort((a, b) => {
      const aTime = a.startedAt ? new Date(a.startedAt as any).getTime() : 0;
      const bTime = b.startedAt ? new Date(b.startedAt as any).getTime() : 0;
      return bTime - aTime;
    });
    for (const run of sorted) {
      if (!lastRunStatusMap.has(run.issueId)) {
        lastRunStatusMap.set(run.issueId, run.status);
      }
    }
  }

  // 6. Resolve target state IDs from the stateMap (fetches from Linear if not provided)
  const stateMap =
    input.stateMap ?? (await resolveWorkflowStates(linearClient, teamIds));

  const results: StuckIssueResult[] = [];

  for (const issue of toProcess) {
    // Linear SDK lazy relations — must await team and state
    const team = await issue.team;
    const teamId = team?.id;
    const targetStateId = teamId ? stateMap.get(`${teamId}:${targetState}`) : undefined;

    if (!targetStateId) {
      log.warn(
        { identifier: issue.identifier, teamId, targetState },
        "no target state ID found for team — skipping stuck issue",
      );
      continue;
    }

    const state = await issue.state;
    const previousStateName: string = state?.name ?? "In Progress";
    const lastRunStatus = lastRunStatusMap.get(issue.identifier) ?? null;

    try {
      // Move the issue to the configured target state
      await linearClient.updateIssue(issue.id, { stateId: targetStateId });

      // Post a comment on the Linear issue explaining the auto-recovery
      const runNote = lastRunStatus
        ? `Most recent pipeline run status: \`${lastRunStatus}\`.`
        : "No pipeline run record found in the database.";
      await linearClient.createComment({
        issueId: issue.id,
        body:
          `🤖 **PM Agent — Auto-recovered stuck issue**\n\n` +
          `This issue was detected in **In Progress** state with no active pipeline run. ` +
          `It has been automatically moved to **${targetState}** for re-evaluation.\n\n${runNote}`,
      });

      results.push({
        issueId: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        previousState: previousStateName,
        lastRunStatus,
        targetState,
      });

      log.info(
        {
          identifier: issue.identifier,
          previousState: previousStateName,
          lastRunStatus,
          targetState,
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
