import type { PmAgentConfig, TickResult, BudgetEvaluation } from "./types.js";
import { evaluateBudget } from "./budget.js";
import { maybeFireAlerts, type PostSlackMessage } from "./budget-alerts.js";
import { postSlackMessage } from "./slack-helpers.js";
import { triageNewIssues, type TriageInput } from "./actions/triage.js";
import { promoteReadyIssues, type PromoteInput } from "./actions/promote.js";
import { deprioritizeStaleIssues, type DeprioritizeInput } from "./actions/deprioritize.js";
import { cancelAbandonedIssues, type CancelInput } from "./actions/cancel.js";
import { resolveApprovals, type ResolveApprovalsInput, type ResolveApprovalsResult } from "./actions/resolve-approvals.js";
import { recoverRetriableRuns, type RecoverResult } from "./actions/recover.js";
import { recoverStuckInProgressIssues, type StuckIssueResult } from "./actions/recover-stuck.js";
import { startTodoIssues, type StartTodoInput, type StartTodoResult } from "./actions/start-todo.js";
import { getActiveFileMaps, predictConflict, type ActiveRun } from "./conflict.js";
import { PmSlackNotifier } from "./slack.js";
import { isPmPaused } from "./slack-interface.js";
import { isFeatureLicensed } from "../license.js";
import type { Db, AnyDb } from "../db/client.js";
import { isPostgres } from "../db/client.js";
import { pipelineRuns } from "../db/schema.js";
import { makeCallClaude } from "./call-claude.js";
import { sanitize } from "../executor/prompt/sanitizer.js";
import { resolveWorkflowStates } from "./linear-helpers.js";
import { sql } from "drizzle-orm";
import { createLogger } from "../logger.js";
import { logAuditEvent, budgetRefusedEvent, pruneAuditLog } from "../audit/index.js";
import { pruneExpiredSessions } from "../auth/index.js";
import { recomputeCostRollups } from "../cost/index.js";

const log = createLogger({ component: "PmAgent:scheduler" });

export interface PmSchedulerDeps {
  config: PmAgentConfig;
  db: Db;
  linearApiKey: string;
  slackBotToken: string;
  repoCloneDir?: string;
  defaultBranch?: string;
  runner?: {
    resume: (issueId: string) => Promise<void>;
    start: (issue: any, pipelineKey: string, pipelineConfig: any, repoConfig: any, sanitizedIssue: any) => Promise<void>;
  };
  pipelineConfigs?: Record<string, any>;
  repoConfigs?: Record<string, any>;
  actions?: Partial<PmSchedulerActions>;
}

interface PmSchedulerActions {
  evaluateBudget: (input: { db: AnyDb; config: PmAgentConfig }) => Promise<BudgetEvaluation>;
  postSlackMessage?: PostSlackMessage;
  recoverRetriableRuns: (input: any) => Promise<RecoverResult>;
  recoverStuckInProgressIssues?: (input: any) => Promise<StuckIssueResult[]>;
  startTodoIssues?: (input: StartTodoInput) => Promise<StartTodoResult[]>;
  triageNewIssues: (input: TriageInput) => Promise<any[]>;
  resolveApprovals: (input: ResolveApprovalsInput) => Promise<ResolveApprovalsResult>;
  promoteReadyIssues: (input: PromoteInput) => Promise<any[]>;
  deprioritizeStaleIssues: (input: DeprioritizeInput) => Promise<string[]>;
  cancelAbandonedIssues: (input: CancelInput) => Promise<string[]>;
  postDigest: (tick: TickResult, maxInFlight: number) => Promise<void>;
  getActiveFileMaps: typeof getActiveFileMaps;
  predictConflict: typeof predictConflict;
}

export interface PmScheduler {
  tick(): Promise<void>;
}

export function createPmScheduler(deps: PmSchedulerDeps): PmScheduler {
  const actions = deps.actions as PmSchedulerActions | undefined;

  let linearClient: any = null;
  let slackNotifier: PmSlackNotifier | null = null;
  const callClaudeFn = makeCallClaude();

  async function getLinearClient() {
    if (!linearClient && deps.linearApiKey) {
      const { LinearClient } = await import("@linear/sdk");
      linearClient = new LinearClient({ apiKey: deps.linearApiKey });
    }
    return linearClient;
  }

  function getSlackNotifier(): PmSlackNotifier {
    if (!slackNotifier) {
      slackNotifier = new PmSlackNotifier({
        botToken: deps.slackBotToken,
        channelId: deps.config.slackChannelId,
      });
    }
    return slackNotifier;
  }

  async function tryAcquireLock(): Promise<boolean> {
    if (!isPostgres(deps.db)) return true;
    try {
      const result = await (deps.db as any).execute(
        sql`SELECT pg_try_advisory_lock(hashtext('pm-agent-tick')) as acquired`,
      );
      return result?.[0]?.acquired === true;
    } catch (err) {
      log.warn({ err }, "advisory lock check failed, proceeding anyway");
      return true;
    }
  }

  async function releaseLock(): Promise<void> {
    if (!isPostgres(deps.db)) return;
    try {
      await (deps.db as any).execute(
        sql`SELECT pg_advisory_unlock(hashtext('pm-agent-tick'))`,
      );
    } catch {
      // Best effort
    }
  }

  return {
    async tick() {
      const acquired = await tryAcquireLock();
      if (!acquired) {
        log.info("another tick is running, skipping");
        return;
      }

      try {
        const tick: TickResult = {
          triaged: [],
          promoted: [],
          approvalsResolved: 0,
          approvalsPending: 0,
          deprioritizeRequested: [],
          cancelRequested: [],
          errors: [],
          budgetGuard: { promoteBlocked: false, activeCount: 0, tokenSpendPercent: 0, dailyTokensUsed: 0 },
        };

        const db = deps.db as AnyDb;
        const config = deps.config;

        let evaluation: BudgetEvaluation;
        try {
          evaluation = actions?.evaluateBudget
            ? await actions.evaluateBudget({ db, config })
            : await evaluateBudget({ db, config });
        } catch (err) {
          log.error({ err }, "budget evaluation failed");
          tick.errors.push(`budget: ${(err as Error).message}`);
          evaluation = {
            scopes: [],
            worstTier: "ok",
            promoteBlocked: false,
            activeCount: 0,
          };
        }

        // Backward-compat TickResult shape: derive BudgetGuardResult from evaluation.
        const globalScope = evaluation.scopes.find((s) => s.scope.kind === "global");
        tick.budgetGuard = {
          promoteBlocked: evaluation.promoteBlocked,
          reason: evaluation.blockReason,
          activeCount: evaluation.activeCount,
          tokenSpendPercent: globalScope?.percent ?? 0,
          dailyTokensUsed: globalScope?.used ?? 0,
        };

        // Emit budget.run_refused audit events for every scope at blocked-100.
        // Recovers the per-scope breakdown that is otherwise dropped when we
        // collapse the evaluation into tick.budgetGuard.
        if (evaluation.promoteBlocked) {
          for (const s of evaluation.scopes) {
            if (s.tier !== "blocked-100") continue;
            const scopeKey =
              s.scope.kind === "global"
                ? "global"
                : s.scope.kind === "team"
                  ? `team:${s.scope.teamId}`
                  : `repo:${s.scope.repoUrl}`;
            void logAuditEvent(
              db,
              budgetRefusedEvent({
                scope: scopeKey,
                scopeType: s.scope.kind,
                tokensUsed: s.used,
                limit: s.limit,
                utilization: s.percent,
              }),
            );
          }
        }

        // Preserve legacy maxInFlight block: if we're at capacity, treat as blocked
        // (existing promoters already check tick.budgetGuard.promoteBlocked).
        if (evaluation.activeCount >= config.maxInFlight && !tick.budgetGuard.promoteBlocked) {
          tick.budgetGuard.promoteBlocked = true;
          tick.budgetGuard.reason = `maxInFlight reached (${evaluation.activeCount}/${config.maxInFlight})`;
          // Emit a budget.run_refused event so operators can trace "why didn't
          // this run start?" when capacity (not token spend) is the blocker.
          void logAuditEvent(
            db,
            budgetRefusedEvent({
              scope: "global",
              scopeType: "global",
              tokensUsed: evaluation.activeCount,
              limit: config.maxInFlight,
              utilization: 100,
            }),
          );
        }

        // Fire threshold alerts for newly-crossed scopes (deduped in budget_alerts).
        try {
          const alertChannel = config.budgets?.alertChannel ?? config.slackChannelId;
          const postSlack: PostSlackMessage | undefined = actions?.postSlackMessage
            ?? (deps.slackBotToken
              ? async (channel, blocks) => {
                  const result = await postSlackMessage(deps.slackBotToken, { channel, blocks });
                  // postSlackMessage swallows fetch errors (returns null) and logs
                  // ok:false without throwing. Re-throw here so maybeFireAlerts'
                  // catch-block triggers the dedup row rollback and the next tick
                  // re-posts the alert.
                  if (result === null) {
                    throw new Error("postSlackMessage returned null (fetch failed)");
                  }
                  if (result && result.ok === false) {
                    throw new Error(`postSlackMessage returned ok:false (${result.error ?? "unknown"})`);
                  }
                }
              : undefined);
          if (postSlack) {
            await maybeFireAlerts(evaluation, db, postSlack, alertChannel);
          }
        } catch (err) {
          log.error({ err }, "failed to fire budget alerts");
        }

        // --- Recovery sweep: requeue retriable (transient-failure) runs ---
        try {
          const recoveryResult = actions
            ? await actions.recoverRetriableRuns({} as any)
            : await recoverRetriableRuns({
                db: deps.db as any,
                runner: deps.runner ?? { resume: async () => { log.warn("no runner configured for recovery"); } },
                maxRetries: 3,
              });
          if (recoveryResult.recovered.length > 0) {
            log.info({ recovered: recoveryResult.recovered }, "recovered retriable runs");
          }
          if (recoveryResult.exhausted.length > 0) {
            log.warn({ exhausted: recoveryResult.exhausted }, "retriable runs exhausted max retries");
          }
        } catch (err) {
          log.error({ err }, "recovery sweep failed");
          tick.errors.push(`recover: ${(err as Error).message}`);
        }

        // Fetch workflow states once per tick to avoid redundant Linear API round-trips
        let stateMap = new Map<string, string>();
        if (!actions) {
          try {
            stateMap = await resolveWorkflowStates(await getLinearClient(), config.teamIds);
          } catch (err) {
            log.error({ err }, "resolveWorkflowStates failed");
            tick.errors.push(`resolveWorkflowStates: ${(err as Error).message}`);
          }
        }

        // --- Stuck In Progress issue recovery sweep ---
        if (config.stuckIssueRecovery !== false) {
          try {
            const stuckResult = actions?.recoverStuckInProgressIssues
              ? await actions.recoverStuckInProgressIssues({} as any)
              : await recoverStuckInProgressIssues({
                  linearClient: await getLinearClient(),
                  db,
                  teamIds: config.teamIds,
                  targetState: config.stuckIssueTargetState ?? "Backlog",
                  maxPerTick: config.stuckIssueMaxPerTick ?? 5,
                  stateMap,
                  postSlackNotification: (issues) =>
                    getSlackNotifier().postStuckIssueRecovered(issues),
                });
            if (stuckResult.length > 0) {
              tick.recoveredStuckIssues = stuckResult.map((r) => r.identifier);
              log.info(
                { recovered: tick.recoveredStuckIssues },
                "auto-recovered stuck In Progress issues",
              );
            }
          } catch (err) {
            log.error({ err }, "stuck issue recovery sweep failed");
            tick.errors.push(`recoverStuck: ${(err as Error).message}`);
          }
        }

        // Compute available slots once for both startTodo and promote
        const slotsAvailable = config.maxInFlight - (tick.budgetGuard.activeCount ?? 0);

        // --- Start pipelines for orphaned Todo issues ---
        if (deps.runner?.start && deps.pipelineConfigs && deps.repoConfigs) {
          try {
            if (slotsAvailable > 0 && !tick.budgetGuard.promoteBlocked) {
              const todoResults = actions?.startTodoIssues
                ? await actions.startTodoIssues({} as any)
                : await startTodoIssues({
                    linearClient: await getLinearClient(),
                    db: deps.db as AnyDb,
                    teamIds: config.teamIds,
                    runner: deps.runner as any,
                    pipelineConfigs: deps.pipelineConfigs,
                    repoConfigs: deps.repoConfigs,
                    maxPerTick: slotsAvailable,
                    budgetEvaluation: evaluation,
                  });
              const started = todoResults.filter((r) => r.started);
              if (started.length > 0) {
                tick.startedTodoIssues = todoResults;
                log.info({ startedCount: started.length }, "started pipelines for orphaned Todo issues");
              }
            }
          } catch (err) {
            log.error({ err }, "startTodoIssues failed");
            tick.errors.push(`startTodo: ${(err as Error).message}`);
          }
        }

        try {
          tick.triaged = actions
            ? await actions.triageNewIssues({} as any)
            : await triageNewIssues({
                linearClient: await getLinearClient(),
                teamIds: config.teamIds,
                callClaude: callClaudeFn,
                sanitize,
                batchSize: config.triageBatchSize,
                stateMap,
                db,
              });
        } catch (err) {
          log.error({ err }, "triage failed");
          tick.errors.push(`triage: ${(err as Error).message}`);
        }

        try {
          const approvalResult = actions
            ? await actions.resolveApprovals({} as any)
            : await resolveApprovals({
                linearClient: await getLinearClient(),
                slackNotifier: getSlackNotifier(),
                db,
                teamIds: config.teamIds,
                stateMap,
              });
          tick.approvalsResolved = approvalResult.resolved;
          tick.approvalsPending = approvalResult.stillPending;
        } catch (err) {
          log.error({ err }, "resolve approvals failed");
          tick.errors.push(`resolveApprovals: ${(err as Error).message}`);
        }

        if (isPmPaused()) {
          tick.paused = true;
          log.info("PM Agent is paused — skipping promote, deprioritize, and cancel");
        }

        if (!tick.budgetGuard.promoteBlocked && !isPmPaused()) {
          try {
            if (actions) {
              tick.promoted = await actions.promoteReadyIssues({} as any);
            } else {
              const activeRuns = await getActiveRunsFromDb(db);
              const baseDir = deps.repoCloneDir ?? "/var/agent-repos";
              const defaultBranch = deps.defaultBranch ?? "main";

              // Find the first cloned repo directory (runner clones to <repoCloneDir>/<slug>/)
              let repoDir = baseDir;
              try {
                const { readdirSync, statSync } = await import("node:fs");
                const entries = readdirSync(baseDir);
                for (const entry of entries) {
                  const candidate = `${baseDir}/${entry}`;
                  try {
                    if (statSync(`${candidate}/.git`).isDirectory()) {
                      repoDir = candidate;
                      break;
                    }
                  } catch { /* not a git repo */ }
                }
              } catch {
                log.warn("could not scan repoCloneDir for git repos");
              }

              const fileMaps = await getActiveFileMaps({
                activeRuns,
                defaultBranch,
                repoDir,
                execGit: (await import("../repo/git.js")).gitExec,
              });

              const checkConflict = isFeatureLicensed("conflict-detection")
                ? (description: string) =>
                    predictConflict({ candidateDescription: description, activeFileMaps: fileMaps, callClaude: callClaudeFn, sanitize })
                : async (_description: string) =>
                    ({ overlapRisk: "none" as const, likelyFiles: [] as string[], reasoning: "conflict detection requires license" });

              tick.promoted = await promoteReadyIssues({
                linearClient: await getLinearClient(),
                teamIds: config.teamIds,
                slotsAvailable,
                checkConflict,
                stateMap,
                db,
              });
            }
          } catch (err) {
            log.error({ err }, "promote failed");
            tick.errors.push(`promote: ${(err as Error).message}`);
          }
        }

        if (!isPmPaused() && isFeatureLicensed("approval-workflows")) {
          const linearClient = await getLinearClient();
          const slackNotifier = getSlackNotifier();

          const [depResult, cancelResult] = await Promise.allSettled([
            actions
              ? actions.deprioritizeStaleIssues({} as any)
              : deprioritizeStaleIssues({
                  linearClient,
                  teamIds: config.teamIds,
                  slackNotifier,
                  db,
                  staleDays: 14,
                  minPriority: 3,
                }),
            actions
              ? actions.cancelAbandonedIssues({} as any)
              : cancelAbandonedIssues({
                  linearClient,
                  teamIds: config.teamIds,
                  slackNotifier,
                  db,
                  abandonedDays: 30,
                }),
          ]);

          if (depResult.status === "fulfilled") {
            tick.deprioritizeRequested = depResult.value;
          } else {
            log.error({ err: depResult.reason }, "deprioritize failed");
            tick.errors.push(`deprioritize: ${(depResult.reason as Error).message}`);
          }

          if (cancelResult.status === "fulfilled") {
            tick.cancelRequested = cancelResult.value;
          } else {
            log.error({ err: cancelResult.reason }, "cancel failed");
            tick.errors.push(`cancel: ${(cancelResult.reason as Error).message}`);
          }
        }

        try {
          if (actions) {
            await actions.postDigest(tick, config.maxInFlight);
          } else {
            await getSlackNotifier().postDigest(tick, config.maxInFlight);
          }
        } catch (err) {
          log.error({ err }, "digest failed");
        }

        // Audit log retention sweep (no-op if unlicensed or not configured).
        // Wrapped in try/catch — retention failure must not crash the tick.
        try {
          if (isFeatureLicensed("audit-log")) {
            const days = (config as any).auditLog?.retentionDays ?? 365;
            await pruneAuditLog(db, days);
          }
        } catch (err) {
          log.warn({ err }, "audit retention sweep failed");
        }

        // Dashboard session prune sweep (no-op if SSO unlicensed).
        // Wrapped in try/catch — prune failure must not crash the tick.
        try {
          if (isFeatureLicensed("sso")) {
            await pruneExpiredSessions(db);
          }
        } catch (err) {
          log.warn({ err }, "session prune failed");
        }

        // Cost & ROI daily rollup (no-op if unlicensed).
        // Wrapped in try/catch — rollup failure must not crash the tick.
        try {
          if (isFeatureLicensed("cost-roi")) {
            await recomputeCostRollups(db, config as any);
          }
        } catch (err) {
          log.warn({ err }, "cost rollup failed");
        }

      log.info({
        triaged: tick.triaged.length,
        promoted: tick.promoted.filter((p) => p.promoted).length,
        errors: tick.errors.length,
      }, "tick complete");
      } finally {
        await releaseLock();
      }
    },
  };
}

async function getActiveRunsFromDb(db: AnyDb): Promise<ActiveRun[]> {
  try {
    const rows = await db
      .select({
        issueId: pipelineRuns.issueId,
        branch: pipelineRuns.branch,
      })
      .from(pipelineRuns)
      .where(
        sql`${pipelineRuns.status} in ('queued', 'running')`,
      );

    return rows
      .filter((r: any) => r.branch)
      .map((r: any) => ({ issueId: r.issueId, branch: r.branch }));
  } catch {
    return [];
  }
}
