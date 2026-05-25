import { join } from "node:path";
import { homedir } from "node:os";
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
import { getCircuitBreakerProbeConfig } from "./actions/circuit-breaker-config.js";
import { selectProbeCandidates } from "./actions/select-probe-candidates.js";
import { sweepRecoveredCircuitBreakers } from "./actions/sweep-recovered-circuit-breakers.js";
import { sweepOrphanStageRuns } from "./actions/sweep-orphan-stage-runs.js";
import { getActiveFileMaps, predictConflict, type ActiveRun } from "./conflict.js";
import { fetchCircuitBrokenIssues, ACTIVE_STATUSES } from "./actions/db-queries.js";
import { PmSlackNotifier } from "./slack.js";
import { isPmPaused } from "./slack-interface.js";
import { isFeatureLicensed } from "../license.js";
import type { Db, AnyDb } from "../db/client.js";
import { isPostgres } from "../db/client.js";
import { pipelineRuns } from "../db/schema.js";
import { makeCallClaude } from "./call-claude.js";
import { sanitize } from "../executor/prompt/sanitizer.js";
import { resolveWorkflowStates, createLazyLinearClient } from "./linear-helpers.js";
import { sql, inArray } from "drizzle-orm";
import { createLogger } from "../logger.js";
import { logAuditEventUnchecked, budgetRefusedEvent, pruneAuditLog, claudeAuthExpiredEvent } from "../audit/index.js";
import { pruneExpiredSessions } from "../auth/index.js";
import { recomputeCostRollups } from "../cost/index.js";
import { createAuthMonitor, type AuthMonitor } from "../executor/auth-monitor.js";

const log = createLogger({ component: "PmAgent:scheduler" });

function captureTickError(tick: TickResult, key: string, err: unknown, msg: string): void {
  log.error({ err }, msg);
  tick.errors.push(`${key}: ${(err as Error).message}`);
}

/**
 * BEC-184 / BEC-227: parse the PM_AGENT_STUCK_RUN_AGE_MIN env var (default 120 min).
 * Controls how long a 'running' run must be active before it's treated as a
 * zombie and eligible for stuck-issue recovery.
 *
 * Default raised from 60 → 120 in BEC-227 — real RALPH-iterated implementation
 * work routinely takes 60-90 min, and the prior 60-min default produced
 * false-positive reaps on healthy long runs.
 *
 * Uses an isNaN guard so '0' doesn't silently fall back via a falsy `||`
 * check; clamps to ≥1 min to prevent overly-aggressive recovery on
 * mis-configured deployments.
 */
export function parseStuckRunAgeMinutes(envValue: string | undefined): number {
  const parsed = parseInt(envValue ?? "", 10);
  return isNaN(parsed) ? 120 : Math.max(1, parsed);
}

export interface PmSchedulerDeps {
  config: PmAgentConfig;
  db: Db;
  linearApiKey: string;
  slackBotToken: string;
  repoCloneDir?: string;
  defaultBranch?: string;
  /** Base directory where per-run worktrees are created. Defaults to $HOME/data/runs (matching runner default). */
  agentRunDir?: string;
  runner?: {
    resume: (issueId: string) => Promise<void>;
    start: (issue: any, pipelineKey: string, pipelineConfig: any, repoConfig: any, sanitizedIssue: any) => Promise<void>;
  };
  pipelineConfigs?: Record<string, any>;
  repoConfigs?: Record<string, any>;
  actions?: Partial<PmSchedulerActions>;
  /** Injectable auth monitor — defaults to the real createAuthMonitor. Used by tests to avoid slow real API calls. */
  authMonitor?: AuthMonitor;
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
  postDigest: (tick: TickResult, maxInFlight: number, minConsecutiveFailures?: number) => Promise<void>;
  getActiveFileMaps: typeof getActiveFileMaps;
  predictConflict: typeof predictConflict;
}

export interface PmScheduler {
  tick(): Promise<void>;
}

export function createPmScheduler(deps: PmSchedulerDeps): PmScheduler {
  const actions = deps.actions as PmSchedulerActions | undefined;

  const { getClient: getLinearClient } = createLazyLinearClient(deps.linearApiKey);
  let slackNotifier: PmSlackNotifier | null = null;
  const callClaudeFn = makeCallClaude();

  // BEC-207: AuthMonitor — periodic Claude session health-check (every 6h).
  // Alerts to the PM agent's Slack channel when SLACK_ERROR_ALERTS=true.
  // No-ops when CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY is set.
  const authMonitor: AuthMonitor = deps.authMonitor ?? createAuthMonitor({
    slackBotToken: deps.slackBotToken || undefined,
    slackErrorChannel:
      process.env.SLACK_ERROR_ALERTS === "true"
        ? deps.config.slackChannelId
        : undefined,
    db: deps.db as AnyDb,
  });

  function getSlackNotifier(): PmSlackNotifier {
    if (!slackNotifier) {
      slackNotifier = new PmSlackNotifier({
        botToken: deps.slackBotToken,
        channelId: deps.config.slackChannelId,
      });
    }
    return slackNotifier;
  }

  // BEC-238: fire the reactions:read scope probe once at scheduler creation.
  // Non-blocking — failure is caught inside probeReactionsScope and logged warn.
  // Guard on slackBotToken so tests that pass an empty string skip the probe.
  if (deps.slackBotToken && deps.config.slackChannelId) {
    void getSlackNotifier().probeReactionsScope();
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
          captureTickError(tick, "budget", err, "budget evaluation failed");
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
        tick.budgetScopes = evaluation.scopes;

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
            void logAuditEventUnchecked(
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
          void logAuditEventUnchecked(
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
          captureTickError(tick, "recover", err, "recovery sweep failed");
        }

        // Fetch workflow states once per tick to avoid redundant Linear API round-trips
        let stateMap = new Map<string, string>();
        if (!actions) {
          try {
            stateMap = await resolveWorkflowStates(await getLinearClient(), config.teamIds);
          } catch (err) {
            captureTickError(tick, "resolveWorkflowStates", err, "resolveWorkflowStates failed");
          }
        }

        // --- Stuck In Progress issue recovery sweep ---
        if (config.stuckIssueRecovery !== false && !isPmPaused()) {
          try {
            const stuckRunAgeMinutes = parseStuckRunAgeMinutes(
              process.env.PM_AGENT_STUCK_RUN_AGE_MIN,
            );
            const stuckResult = actions?.recoverStuckInProgressIssues
              ? await actions.recoverStuckInProgressIssues({} as any)
              : await recoverStuckInProgressIssues({
                  linearClient: await getLinearClient(),
                  db,
                  teamIds: config.teamIds,
                  targetState: config.stuckIssueTargetState ?? "Backlog",
                  maxPerTick: config.stuckIssueMaxPerTick ?? 5,
                  stuckRunAgeMinutes,
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
            captureTickError(tick, "recoverStuck", err, "stuck issue recovery sweep failed");
          }
        }

        // BEC-250 — orphan stage_runs sweep: cancel stage_runs whose parent is
        // terminal and delete any whose parent is missing. Runs every tick;
        // idempotent and fail-open. Guarded by !actions so tests that inject
        // mock actions with db:{} don't hit a real DB call.
        if (!actions) {
          try {
            await sweepOrphanStageRuns(db);
          } catch (err) {
            log.warn({ err }, "orphan stage_runs sweep failed");
          }
        }

        // Compute available slots once for both startTodo and promote
        const slotsAvailable = config.maxInFlight - (tick.budgetGuard.activeCount ?? 0);

        // BEC-236 — half-open circuit-breaker probe. Picks at most `cap` issues
        // per tick that the breaker would normally skip; promote + startTodo
        // receive this Set as probeOverrideIds and bypass the skip for them.
        const probeConfig = getCircuitBreakerProbeConfig();
        const breakerThreshold = config.maxConsecutiveFailures > 0
          ? config.maxConsecutiveFailures
          : 3;
        let probeOverrideIds: Set<string> = new Set();
        if (db && !probeConfig.disabled) {
          try {
            probeOverrideIds = await selectProbeCandidates(db, {
              cap: probeConfig.maxProbesPerTick,
              cooldownMs: probeConfig.cooldownMs,
              maxConsecutiveFailures: breakerThreshold,
              now: Date.now(),
            });
          } catch (err) {
            captureTickError(tick, "probe", err, "selectProbeCandidates failed");
          }

          // BEC-236 — sweep recovered issues. The runner can't drive recovery
          // itself (no `linearClient` in its scope), so each tick scans for
          // state rows whose consecutive-failure count has dropped (= a
          // `completed` run landed). Recovery deletes the state row and
          // strips the Tier-5-added `needs-design` label.
          try {
            await sweepRecoveredCircuitBreakers(db, await getLinearClient(), {
              maxConsecutiveFailures: breakerThreshold,
            });
          } catch (err) {
            captureTickError(tick, "sweepRecovered", err, "sweepRecoveredCircuitBreakers failed");
          }
        }

        // --- Start pipelines for orphaned Todo issues ---
        if (deps.runner?.start && deps.pipelineConfigs && deps.repoConfigs) {
          try {
            if (slotsAvailable > 0 && !tick.budgetGuard.promoteBlocked && !isPmPaused()) {
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
                    maxConsecutiveFailures: config.maxConsecutiveFailures > 0
                      ? config.maxConsecutiveFailures
                      : undefined,
                    // BEC-181: omit getFailureCount so startTodoIssues uses the batch
                    // batchCountConsecutiveFailures path (single DB round-trip for all
                    // candidates) instead of per-issue N+1 queries.
                    probeOverrideIds,
                  });
              const started = todoResults.filter((r) => r.started);
              if (started.length > 0) {
                tick.startedTodoIssues = todoResults;
                log.info({ startedCount: started.length }, "started pipelines for orphaned Todo issues");
              }
            }
          } catch (err) {
            captureTickError(tick, "startTodo", err, "startTodoIssues failed");
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
          captureTickError(tick, "triage", err, "triage failed");
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
          captureTickError(tick, "resolveApprovals", err, "resolve approvals failed");
        }

        if (isPmPaused()) {
          tick.paused = true;
          log.info("PM Agent is paused — skipping start-todo, recover-stuck, promote, deprioritize, and cancel");
        }

        if (!tick.budgetGuard.promoteBlocked && !isPmPaused()) {
          try {
            if (actions) {
              tick.promoted = await actions.promoteReadyIssues({} as any);
            } else {
              const agentRunDir = deps.agentRunDir ?? join(homedir(), "data", "runs");
              const baseDir = deps.repoCloneDir ?? join(homedir(), "work", "repos");
              const defaultBranch = deps.defaultBranch ?? "main";
              const { readdir, stat } = await import("node:fs/promises");

              // Fetch active runs from DB and scan for the first cloned repo dir in parallel.
              const [activeRuns, repoDir] = await Promise.all([
                getActiveRunsFromDb(db, agentRunDir),
                (async () => {
                  try {
                    const entries = await readdir(baseDir);
                    const candidates = await Promise.all(
                      entries.map(async (entry) => {
                        const candidate = `${baseDir}/${entry}`;
                        try {
                          const s = await stat(`${candidate}/.git`);
                          if (s.isDirectory()) return candidate;
                        } catch { /* not a git repo */ }
                        return null;
                      }),
                    );
                    return candidates.find((c) => c !== null) ?? baseDir;
                  } catch {
                    log.warn("could not scan repoCloneDir for git repos");
                    return baseDir;
                  }
                })(),
              ]);

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
                requirePipelineLabel: config.requirePipelineLabelForPromote,
                pipelineConfigs: deps.pipelineConfigs,
                maxConsecutiveFailures: config.maxConsecutiveFailures > 0
                  ? config.maxConsecutiveFailures
                  : undefined,
                // BEC-181: omit getFailureCount so promoteReadyIssues uses the batch
                // batchCountConsecutiveFailures path (single DB round-trip for all
                // candidates) instead of per-issue N+1 queries.
                probeOverrideIds,
              });
            }
          } catch (err) {
            captureTickError(tick, "promote", err, "promote failed");
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
            captureTickError(tick, "deprioritize", depResult.reason, "deprioritize failed");
          }

          if (cancelResult.status === "fulfilled") {
            tick.cancelRequested = cancelResult.value;
          } else {
            captureTickError(tick, "cancel", cancelResult.reason, "cancel failed");
          }
        }

        // BEC-223: Populate circuit-broken issues for the digest before posting.
        // Wrapped in try/catch — failure must not prevent the digest from posting.
        const minFailures = config.maxConsecutiveFailures > 0 ? config.maxConsecutiveFailures : 3;
        if (!actions) {
          try {
            tick.circuitBrokenIssues = await fetchCircuitBrokenIssues(db, minFailures);
          } catch (err) {
            log.warn({ err }, "failed to fetch circuit-broken issues for digest");
          }
        }

        try {
          if (actions) {
            await actions.postDigest(tick, config.maxInFlight);
          } else {
            await getSlackNotifier().postDigest(tick, config.maxInFlight, minFailures);
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
        // The isFeatureLicensed check here is the SECONDARY guard — the
        // primary gate now lives inside recomputeCostRollups itself. This
        // outer check skips the call entirely (saves a function frame +
        // one structured warn log per tick) and should not be removed
        // even if the inner gate looks sufficient.
        try {
          if (isFeatureLicensed("cost-roi")) {
            await recomputeCostRollups(db, config as any);
          }
        } catch (err) {
          log.warn({ err }, "cost rollup failed");
        }

        // BEC-207: AuthMonitor — periodic Claude session health-check (every 6h).
        // Throttled internally; fire-and-forget safe.
        try {
          await authMonitor.tick();
        } catch (err) {
          log.warn({ err }, "auth monitor tick failed");
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

async function getActiveRunsFromDb(db: AnyDb, agentRunDir: string): Promise<ActiveRun[]> {
  try {
    const rows = await db
      .select({
        id: pipelineRuns.id,
        issueId: pipelineRuns.issueId,
        branch: pipelineRuns.branch,
      })
      .from(pipelineRuns)
      .where(
        inArray(pipelineRuns.status, [...ACTIVE_STATUSES]),
      );

    return rows
      .filter((r: any) => r.branch)
      .map((r: any) => ({
        issueId: r.issueId,
        branch: r.branch,
        worktreePath: join(agentRunDir, r.id, "worktree"),
      }));
  } catch {
    return [];
  }
}
