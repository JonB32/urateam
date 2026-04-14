import type { AnyDb } from "../../db/client.js";
import { getActiveAndRecentIssueIds } from "./db-queries.js";
import { resolvePipeline } from "../../pipeline/router.js";
import { mapIssueToSchema } from "../../executor/prompt/schema-mapper.js";
import type { PipelineConfig, RepoConfig } from "../../types.js";
import type { PipelineRunner, LinearIssue } from "../../pipeline/runner.js";
import type { BudgetEvaluation } from "../types.js";
import { createLogger } from "../../logger.js";

const log = createLogger({ component: "PmAgent:startTodo" });

export interface StartTodoInput {
  linearClient: any;
  db: AnyDb;
  teamIds: string[];
  runner: PipelineRunner;
  pipelineConfigs: Record<string, PipelineConfig>;
  repoConfigs: Record<string, RepoConfig>;
  /** Maximum number of Todo issues to start per tick (rate limiter). */
  maxPerTick: number;
  /** Budget evaluation from the current tick. When blocked, this action short-circuits. */
  budgetEvaluation?: BudgetEvaluation;
}

export interface StartTodoResult {
  identifier: string;
  title: string;
  started: boolean;
  reason: string;
}

/**
 * Scans Linear for issues in "Todo" state with no active pipeline run,
 * and starts pipelines for them.
 *
 * This closes the gap where issues moved to Todo (by promote or manually)
 * are missed because the webhook didn't fire or the process restarted.
 */
export async function startTodoIssues(
  input: StartTodoInput,
): Promise<StartTodoResult[]> {
  const { linearClient, db, teamIds, runner, pipelineConfigs, repoConfigs, maxPerTick } = input;

  if (input.budgetEvaluation?.promoteBlocked) {
    log.info(
      { reason: input.budgetEvaluation.blockReason },
      "startTodoIssues skipped — budget exceeded",
    );
    return [];
  }

  // 1. Query Linear for all "Todo" issues across configured teams
  const issuesResponse = await linearClient.issues({
    filter: {
      team: { id: { in: teamIds } },
      state: { name: { eq: "Todo" } },
    },
    first: 50,
  });
  const todoIssues: any[] = issuesResponse.nodes ?? [];

  if (todoIssues.length === 0) {
    log.debug("no Todo issues found");
    return [];
  }

  // 2. Fetch active and recently-processed issue IDs in one shared helper
  const { activeIssueIds, recentlyProcessed } = await getActiveAndRecentIssueIds(db);

  // 3. Filter to orphaned issues (in Todo but no active pipeline run)
  // NOTE: DB stores issue.identifier (e.g. "BEC-120"), not issue.id (Linear UUID)
  const orphaned = todoIssues.filter((issue: any) => !activeIssueIds.has(issue.identifier));

  if (orphaned.length === 0) {
    log.debug({ totalTodo: todoIssues.length }, "all Todo issues have active pipeline runs");
    return [];
  }

  // 3b. Skip issues with recently completed/failed runs (within last 30 min)
  const filteredOrphaned = orphaned.filter((issue: any) => {
    if (recentlyProcessed.has(issue.identifier)) {
      log.info(
        { identifier: issue.identifier },
        "skipping — recent completed/failed pipeline run exists",
      );
      return false;
    }
    return true;
  });

  if (filteredOrphaned.length === 0) {
    log.debug("all orphaned Todo issues have recent pipeline runs — skipping");
    return [];
  }

  log.info(
    { totalTodo: todoIssues.length, orphanedCount: filteredOrphaned.length, maxPerTick },
    "found Todo issues with no active pipeline run",
  );

  // 4. Rate-limit and process
  const toProcess = filteredOrphaned.slice(0, maxPerTick);
  const results: StartTodoResult[] = [];

  for (const issue of toProcess) {
    const team = await issue.team;
    const teamId = team?.id;
    const project = await issue.project;
    const projectId = project?.id;

    // Resolve labels — Linear SDK issue.labels is a method, not a property
    const labelsConnection = await issue.labels();
    const labelNodes = labelsConnection?.nodes ?? [];
    const labelNames: string[] = labelNodes.map((l: any) => l.name);

    // Resolve pipeline from labels
    const resolved = resolvePipeline(labelNames, pipelineConfigs);
    if (!resolved) {
      results.push({
        identifier: issue.identifier,
        title: issue.title,
        started: false,
        reason: "no pipeline config matches labels",
      });
      log.info({ identifier: issue.identifier, labels: labelNames }, "no pipeline match — skipping");
      continue;
    }

    // Resolve repo config from team/project ID
    const repoConfig = repoConfigs[teamId] ?? repoConfigs[projectId ?? ""] ?? null;
    if (!repoConfig) {
      results.push({
        identifier: issue.identifier,
        title: issue.title,
        started: false,
        reason: `no repo config for team ${teamId}`,
      });
      log.warn({ identifier: issue.identifier, teamId, projectId }, "no repo mapping — skipping");
      continue;
    }

    // Build LinearIssue and sanitized version (same as webhook handler)
    const linearIssue: LinearIssue = {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description ?? "",
      labels: labelNodes,
      priority: issue.priority ?? 4,
      teamId: teamId ?? "",
      projectId: projectId,
    };

    const sanitizedIssue = mapIssueToSchema(linearIssue);

    try {
      await runner.start(
        linearIssue,
        resolved.key,
        resolved.config,
        repoConfig,
        sanitizedIssue,
        teamId ?? null,
      );
      results.push({
        identifier: issue.identifier,
        title: issue.title,
        started: true,
        reason: `started pipeline ${resolved.key}`,
      });
      log.info({ identifier: issue.identifier, pipeline: resolved.key }, "started pipeline for orphaned Todo issue");
    } catch (err) {
      results.push({
        identifier: issue.identifier,
        title: issue.title,
        started: false,
        reason: (err as Error).message,
      });
      log.error({ identifier: issue.identifier, err }, "failed to start pipeline for Todo issue");
    }
  }

  const started = results.filter((r) => r.started).length;
  const skipped = results.filter((r) => !r.started);
  if (skipped.length > 0) {
    log.info(
      { started, skipped: skipped.map((s) => ({ id: s.identifier, reason: s.reason })) },
      "startTodoIssues summary",
    );
  }

  return results;
}
