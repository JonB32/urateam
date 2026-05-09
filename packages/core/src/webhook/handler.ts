import { Hono } from "hono";
import { eq, lt } from "drizzle-orm";
import type { TriggerMap } from "../types.js";
import { DEFAULT_TRIGGER_MAP } from "../types.js";
import { verifyLinearSignature } from "./signature.js";
import { parseStateChange } from "./parser.js";
import { mapIssueToSchema } from "../executor/prompt/schema-mapper.js";
import type { PipelineRunner } from "../pipeline/runner.js";
import { resolvePipeline } from "../pipeline/router.js";
import type { PipelineConfig, RepoConfig } from "../types.js";
import { createLogger } from "../logger.js";
import { webhookDedup } from "../db/schema.js";
import type { AnyDb } from "../db/client.js";
import type { PmAgentConfig } from "../pm/types.js";
import { evaluateBudget } from "../pm/budget.js";
import { selectRepoConfig } from "../pm/actions/select-repo-config.js";

const log = createLogger({ component: "WebhookHandler" });

const DEDUP_TTL_MS = 30_000;

export interface WebhookHandlerConfig {
  webhookSecret: string;
  runner: PipelineRunner;
  pipelineConfigs: Record<string, PipelineConfig>;
  repoConfigs: Record<string, RepoConfig>;
  triggerMap?: TriggerMap;
  /** When provided, dedup keys are persisted in the database (survives restarts). */
  db?: AnyDb;
  /** PM Agent config — when provided, enables the 100% budget gate on webhook starts. */
  pmConfig?: PmAgentConfig;
}

/** Dedup interface shared by in-memory and DB-backed implementations. */
interface DedupStore {
  has(key: string): Promise<boolean>;
  add(key: string): Promise<void>;
  cleanup(): Promise<void>;
}

// ---------------------------------------------------------------------------
// In-memory dedup set — fallback when no DB is provided.
// Resets on process restart and is not shared across instances.
// ---------------------------------------------------------------------------
class DedupSet implements DedupStore {
  private keys = new Map<string, number>();

  async has(key: string): Promise<boolean> {
    const expiry = this.keys.get(key);
    if (!expiry) return false;
    if (Date.now() > expiry) {
      this.keys.delete(key);
      return false;
    }
    return true;
  }

  async add(key: string): Promise<void> {
    this.keys.set(key, Date.now() + DEDUP_TTL_MS);
  }

  async cleanup(): Promise<void> {
    const now = Date.now();
    for (const [key, expiry] of this.keys) {
      if (now > expiry) this.keys.delete(key);
    }
  }
}

// ---------------------------------------------------------------------------
// DB-backed dedup set — survives restarts, shared across instances.
// ---------------------------------------------------------------------------
class DbDedupSet implements DedupStore {
  constructor(private db: AnyDb, private ttlMs: number) {}

  async has(key: string): Promise<boolean> {
    const rows: any[] = await (this.db as any)
      .select()
      .from(webhookDedup)
      .where(eq(webhookDedup.id, key));
    if (rows.length === 0) return false;
    const expiresAt: Date = rows[0].expiresAt;
    if (Date.now() > expiresAt.getTime()) {
      await (this.db as any).delete(webhookDedup).where(eq(webhookDedup.id, key));
      return false;
    }
    return true;
  }

  async add(key: string): Promise<void> {
    const expiresAt = new Date(Date.now() + this.ttlMs);
    await (this.db as any)
      .insert(webhookDedup)
      .values({ id: key, expiresAt })
      .onConflictDoUpdate({ target: webhookDedup.id, set: { expiresAt } });
  }

  async cleanup(): Promise<void> {
    await (this.db as any)
      .delete(webhookDedup)
      .where(lt(webhookDedup.expiresAt, new Date()));
  }
}

export function createWebhookHandler(config: WebhookHandlerConfig): Hono {
  const app = new Hono();
  const dedup: DedupStore = config.db
    ? new DbDedupSet(config.db, DEDUP_TTL_MS)
    : new DedupSet();

  // Periodic cleanup of expired dedup entries (runs outside the hot path)
  const cleanupTimer = setInterval(() => {
    dedup.cleanup().catch((err) => log.warn({ err }, "dedup cleanup failed"));
  }, 30_000);
  cleanupTimer.unref();

  app.post("/webhooks/linear", async (c) => {
    const rawBody = await c.req.text();
    const signature = c.req.header("Linear-Signature") ?? "";

    // 1. Verify signature
    if (!verifyLinearSignature(rawBody, signature, config.webhookSecret)) {
      return c.json({ error: "Invalid signature" }, 401);
    }

    // 2. Parse payload
    let payload: Record<string, any>;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    // 3. Extract state change
    const stateChange = parseStateChange(payload);
    if (!stateChange) {
      return c.json({ ok: true }); // Ignore non-state-change webhooks
    }

    // 4. Resolve trigger map: per-team repo config -> global config -> DEFAULT_TRIGGER_MAP
    const teamRepoConfig =
      config.repoConfigs[stateChange.issue.teamId] ??
      config.repoConfigs[stateChange.issue.projectId ?? ""] ??
      null;
    const triggerMap = teamRepoConfig?.triggerMap ?? config.triggerMap ?? DEFAULT_TRIGGER_MAP;

    // Build reverse map: state name -> action
    const stateToAction: Record<string, string> = {
      [triggerMap.start]: "start",
      [triggerMap.resume]: "resume",
      [triggerMap.pause]: "pause",
      [triggerMap.abort]: "abort",
    };

    // 5. Determine action from state name
    const action = stateToAction[stateChange.newState];
    if (!action) {
      return c.json({ ok: true }); // Ignore unrecognized states
    }

    // 6. Dedup
    const roundedTs = Math.floor(Date.now() / 30_000);
    const dedupKey = `${stateChange.issue.identifier}:${stateChange.newState}:${roundedTs}`;
    if (await dedup.has(dedupKey)) {
      return c.json({ ok: true, deduplicated: true });
    }
    await dedup.add(dedupKey);

    // 7. Dispatch based on action
    switch (action) {
      case "start": {
        // Resolve pipeline from labels
        const labelNames = stateChange.issue.labels.map((l) => l.name);
        const resolved = resolvePipeline(labelNames, config.pipelineConfigs);
        if (!resolved) {
          // No pipeline matches
          return c.json({ ok: true, message: "No pipeline config for labels" });
        }

        // Resolve repo config: label-pattern lookup first (BEC-177 multi-repo routing),
        // then teamId / projectId key lookup (backwards compatible with teamRepoConfig).
        const repoConfig = selectRepoConfig(
          resolved.key,
          stateChange.issue.teamId,
          stateChange.issue.projectId,
          config.repoConfigs,
        );
        if (!repoConfig) {
          log.error(
            { teamId: stateChange.issue.teamId, projectId: stateChange.issue.projectId ?? "none", issueId: stateChange.issue.identifier },
            // Library-level error reachable from any consumer of createWebhookHandler.
            // Names the most common entry-point root causes (env vars for `ura dev` /
            // `ura start`, config file for `ura run`) rather than the misleading
            // "check repoConfigs keys" wording the issue called out. See urateam#33.
            "no repo mapping for team — set REPO_TEAM_ID + REPO_URL in .env (ura dev / ura start) or check repos.config.ts (ura run); the team UUID logged here must match",
          );
          return c.json({
            ok: false,
            error: "No repo mapping for team/project",
            teamId: stateChange.issue.teamId,
            projectId: stateChange.issue.projectId ?? null,
          }, 422);
        }

        const linearTeamId = stateChange.issue.teamId ?? null;

        // Budget gate: refuse new runs when any scope is at 100%.
        // In-flight runs continue; PM Agent's startTodoIssues will
        // pick this issue up on the next tick when the budget recovers.
        if (config.pmConfig && config.db) {
          try {
            const evaluation = await evaluateBudget({
              db: config.db,
              config: config.pmConfig,
            });
            if (evaluation.promoteBlocked) {
              log.warn(
                {
                  issueId: stateChange.issue.identifier,
                  reason: evaluation.blockReason,
                },
                "webhook start refused — budget exceeded",
              );
              return c.json({
                ok: true,
                action: "start",
                runQueued: false,
                reason: "budget-exceeded",
              });
            }
          } catch (err) {
            log.error({ err }, "budget evaluation failed in webhook gate; allowing run");
            // Fail open — if the evaluation crashes, let the run proceed.
          }
        }

        const sanitizedIssue = mapIssueToSchema(stateChange.issue);

        // Enqueue async - don't await, but catch unhandled errors
        config.runner.start(
          stateChange.issue,
          resolved.key,
          resolved.config,
          repoConfig,
          sanitizedIssue,
          linearTeamId,
        ).catch((err) => log.error({ err }, "runner.start() failed"));

        return c.json({ ok: true, action: "start", runQueued: true });
      }

      case "resume":
        config.runner.resume(stateChange.issue.identifier);
        return c.json({ ok: true, action: "resume" });

      case "pause":
        config.runner.pause(stateChange.issue.identifier);
        return c.json({ ok: true, action: "pause" });

      case "abort":
        config.runner.abort(stateChange.issue.identifier);
        return c.json({ ok: true, action: "abort" });

      default:
        return c.json({ ok: true });
    }
  });

  return app;
}
