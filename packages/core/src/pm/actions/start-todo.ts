import type { AnyDb } from "../../db/client.js";
import { getActiveAndRecentIssueIds, batchCountConsecutiveFailures } from "./db-queries.js";
import { resolvePipeline } from "../../pipeline/router.js";
import { mapIssueToSchema } from "../../executor/prompt/schema-mapper.js";
import type { PipelineConfig, RepoConfig } from "../../types.js";
import type { PipelineRunner, LinearIssue } from "../../pipeline/runner.js";
import type { BudgetEvaluation } from "../types.js";
import { createLogger } from "../../logger.js";
import { logAuditEventUnchecked, pmSkippedCircuitBreakerEvent } from "../../audit/index.js";
import { selectRepoConfig } from "./select-repo-config.js";
import type { LinearClient } from "@linear/sdk";

const log = createLogger({ component: "PmAgent:startTodo" });

export interface StartTodoInput {
  linearClient: Pick<LinearClient, "issues">;
  db: AnyDb;
  teamIds: string[];
  runner: PipelineRunner;
  pipelineConfigs: Record<string, PipelineConfig>;
  repoConfigs: Record<string, RepoConfig>;
  /** Maximum number of Todo issues to start per tick (rate limiter). */
  maxPerTick: number;
  /** Budget evaluation from the current tick. When blocked, this action short-circuits. */
  budgetEvaluation?: BudgetEvaluation;
  /**
   * BEC-161: when set, Todo issues whose pipeline has ≥ this many consecutive
   * failed runs (since the last success) are skipped. Leave undefined to
   * disable the breaker.
   */
  maxConsecutiveFailures?: number;
  /**
   * BEC-161/BEC-181: returns the number of consecutive failed runs for an
   * issue. Tests inject a stub here (avoids real DB rows). Production omits
   * this so `batchCountConsecutiveFailures` is used instead (single DB
   * round-trip for all candidates via the required `db` field).
   */
  getFailureCount?: (issueId: string) => Promise<number>;
  /**
   * BEC-236 — issue IDs the half-open probe selected this tick. Issues in
   * this Set bypass the consecutive-failures circuit-breaker skip, allowing
   * exactly one probe run per cooldown window. When undefined, breaker
   * behavior is unchanged from BEC-161/181.
   */
  probeOverrideIds?: Set<string>;
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

  // BEC-161/BEC-181: no additional validation needed — batchCountConsecutiveFailures
  // uses the required `db` field directly, so getFailureCount is not required.

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

  // BEC-181: pre-fetch failure counts for all candidates in one DB round-trip
  // to avoid an N+1 query pattern (one query per candidate in the loop below).
  // Uses getFailureCount when provided (test-injectable stub); otherwise falls
  // back to batchCountConsecutiveFailures for a single DB round-trip.
  let prefetchedFailureCounts: Map<string, number> | null = null;
  if (input.maxConsecutiveFailures !== undefined && !input.getFailureCount) {
    const candidateIds = toProcess.map((i: any) => i.identifier as string);
    prefetchedFailureCounts = await batchCountConsecutiveFailures(db, candidateIds);
  }

  for (const issue of toProcess) {
    // BEC-161: circuit breaker — fire FIRST, before any Linear SDK round-trips
    // (issue.team / issue.project / issue.labels each cost an API call).
    if (input.maxConsecutiveFailures !== undefined) {
      const failureCount = input.getFailureCount
        ? await input.getFailureCount(issue.identifier)
        : (prefetchedFailureCounts!.get(issue.identifier) ?? 0);
      if (
        failureCount >= input.maxConsecutiveFailures &&
        !input.probeOverrideIds?.has(issue.identifier)
      ) {
        log.warn(
          { identifier: issue.identifier, failureCount, threshold: input.maxConsecutiveFailures },
          "circuit-breaker engaged — skipping start",
        );
        void logAuditEventUnchecked(
          db,
          pmSkippedCircuitBreakerEvent({
            issueId: issue.identifier,
            failureCount,
            threshold: input.maxConsecutiveFailures,
            source: "start-todo",
          }),
        );
        results.push({
          identifier: issue.identifier,
          title: issue.title,
          started: false,
          reason: `circuit-breaker: ${failureCount} consecutive failed runs (threshold ${input.maxConsecutiveFailures})`,
        });
        continue;
      }
    }

    // Parallelise the three independent Linear SDK round-trips (team, project,
    // labels) to avoid sequential waterfall latency across the network.
    const [team, project, labelsConnection] = await Promise.all([
      issue.team,
      issue.project,
      issue.labels(),
    ]);
    const teamId = team?.id;
    const projectId = project?.id;
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

    // Resolve repo config: label-pattern lookup first (BEC-177 multi-repo routing),
    // then teamId / projectId key lookup (backwards compatible).
    const repoConfig = selectRepoConfig(resolved.key, teamId, projectId, repoConfigs);
    if (!repoConfig) {
      results.push({
        identifier: issue.identifier,
        title: issue.title,
        started: false,
        reason: `no repo config for label "${resolved.key}" (team ${teamId})`,
      });
      log.warn(
        { identifier: issue.identifier, teamId, projectId, pipelineLabel: resolved.key },
        "no repo mapping — skipping (checked labelPattern and teamId/projectId keys)",
      );
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

  let started = 0;
  const skipped: StartTodoResult[] = [];
  for (const r of results) {
    r.started ? started++ : skipped.push(r);
  }
  if (skipped.length > 0) {
    log.info(
      { started, skipped: skipped.map((s) => ({ id: s.identifier, reason: s.reason })) },
      "startTodoIssues summary",
    );
  }

  return results;
}
