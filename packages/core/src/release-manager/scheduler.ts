/**
 * scheduler.ts
 *
 * Responsibility: cron factory — wires dependencies into a TickContext, constructs
 * the mutable per-instance state, and exposes the public
 * `createReleaseManagerScheduler` entry point.
 *
 * File responsibilities in this module:
 *   - scheduler.ts      : cron factory + public surface (this file)
 *   - release-tick.ts   : tick() orchestration — QA trigger logic, approval gate,
 *                         version bump, Git tag, cron rescheduling state
 *   - release-helpers.ts: persistence helpers — Slack dedup, persistDecision,
 *                         consumeApprovalRow
 */
import type { Octokit } from "@octokit/rest";
import type { LinearClient } from "@linear/sdk";
import { Cron } from "croner";
import type { AnyDb } from "../db/client.js";
import { createLogger } from "../logger.js";
import type { ReleaseManagerConfig } from "./types.js";
import type { SlackPoster } from "./release-helpers.js";
import { tick } from "./release-tick.js";
import type { TickContext, TickMutableState } from "./release-tick.js";

const log = createLogger({ component: "ReleaseManager:scheduler" });

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

/**
 * Create a release-manager scheduler for a single (repo, branch) pair.
 *
 * The returned object is the sole public API for the release-manager module.
 * Callers should call `start()` to enable the cron driver, or call `tick()`
 * directly in tests.
 *
 * Internally this function constructs a `TickContext` (defined in release-tick.ts)
 * and delegates every decision cycle to `tick(ctx)`. Mutable inter-tick state
 * (Slack dedup counters, license-warn flag, pause timestamp, etc.) lives in
 * `ctx.mutableState` and is updated in-place by each tick invocation.
 */
export function createReleaseManagerScheduler(
  input: ReleaseManagerSchedulerInput,
): ReleaseManagerScheduler {
  const { config, db, octokit, linear, repoUrl, isLicensed, slack } = input;
  const branch = config.branch;

  // Per-(repo, branch) mutable state — survives across ticks within this instance.
  const mutableState: TickMutableState = {
    slackDedup: { lastSkipReason: null, lastPostAt: 0 },
    licenseWarnLogged: false,
    auditedCompletedRunIds: new Set<number>(),
    pausedUntilTs: 0,
  };

  // Build the context struct once; tick() reads and mutates mutableState in-place.
  const ctx: TickContext = {
    config,
    db,
    octokit,
    linear,
    repoUrl,
    branch,
    isLicensed,
    slack,
    mutableState,
  };

  let cronJob: Cron | null = null;

  function start() {
    if (cronJob) return;
    cronJob = new Cron(config.schedule, () => {
      tick(ctx).catch((err) => log.error({ err, repoUrl, branch }, "release-manager tick errored"));
    });
    log.info({ schedule: config.schedule, repoUrl, branch }, "release-manager scheduler started");
  }

  function stop() {
    cronJob?.stop();
    cronJob = null;
  }

  function pauseUntil(ts: Date) {
    mutableState.pausedUntilTs = ts.getTime();
  }

  return {
    tick: () => tick(ctx),
    start,
    stop,
    pauseUntil,
  };
}
