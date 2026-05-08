import pino from "pino";
import type { Cron } from "croner";
import type { ObserverStore, QualityFinding, TickResult } from "./types.js";
import { isFirstTick, seedDedupOnFirstTick, processFindings } from "./engine.js";

const log = pino({ name: "QualityObserver:scheduler" });

export interface ObserverSchedulerDeps {
  /** Persistence store for dedup fingerprints and metadata */
  store: ObserverStore;
  /** Async function that computes the current set of quality findings */
  computeFindings: () => Promise<QualityFinding[]>;
  /**
   * Async function that files a single finding as a GitHub issue.
   * Returns the issue URL on success, or null to skip without registering.
   */
  fileGithubIssue: (finding: QualityFinding) => Promise<string | null>;
  /**
   * When true, the first tick files normally instead of seeding dedup.
   * Overrides the QUALITY_OBSERVER_FIRST_TICK_FILE env variable.
   * Useful for CI or deliberate reset scenarios.
   */
  firstTickFile?: boolean;
}

export interface ObserverScheduler {
  /**
   * Runs a single observer tick:
   * - On the first tick of a fresh install (and QUALITY_OBSERVER_FIRST_TICK_FILE is not set),
   *   seeds the dedup store without filing any GitHub issues.
   * - On subsequent ticks, files only findings whose fingerprints have not been seen before.
   */
  tick(): Promise<TickResult>;
  /**
   * Starts the scheduler on a cron expression (default: every hour).
   * Dynamically imports croner to avoid import-time side effects.
   */
  start(cronExpression?: string): void;
  /** Stops the cron scheduler if running. */
  stop(): void;
}

export function createObserverScheduler(
  deps: ObserverSchedulerDeps
): ObserverScheduler {
  const { store, computeFindings, fileGithubIssue } = deps;
  let cronJob: Cron | null = null;

  async function tick(): Promise<TickResult> {
    // Resolve first-tick-file flag:
    //   1. Explicit dep field (for tests / programmatic override)
    //   2. QUALITY_OBSERVER_FIRST_TICK_FILE env var
    //   3. Default: false (seed on first tick)
    const forceFile: boolean =
      deps.firstTickFile ??
      process.env["QUALITY_OBSERVER_FIRST_TICK_FILE"] === "true";

    // Check first-tick state BEFORE computing findings (as per ACs)
    const firstTick = isFirstTick(store);

    if (firstTick && !forceFile) {
      // Fresh install — seed dedup without filing any issues
      const { seeded } = await seedDedupOnFirstTick(store, computeFindings);
      return { firstTick: true, seeded, filed: 0, skipped: 0 };
    }

    // Normal flow — compute findings and file new ones
    const { filed, skipped } = await processFindings(
      store,
      computeFindings,
      fileGithubIssue
    );

    // If this was the first tick but force-filed (QUALITY_OBSERVER_FIRST_TICK_FILE=true),
    // mark firstTickAt so subsequent ticks don't re-enter the first-tick branch
    if (firstTick) {
      store.setFirstTickAt();
    }

    log.info({ filed, skipped }, "observer tick complete");
    return { firstTick, seeded: 0, filed, skipped };
  }

  return {
    tick,

    start(cronExpression = "0 * * * *"): void {
      if (cronJob) return;
      // Dynamic import to avoid import-time side effects
      import("croner")
        .then(({ Cron }) => {
          cronJob = new Cron(cronExpression, () => {
            tick().catch((err: unknown) =>
              log.error({ err }, "observer tick failed")
            );
          });
          log.info({ cronExpression }, "quality observer started");
        })
        .catch((err: unknown) => {
          log.error({ err }, "failed to start quality observer cron");
        });
    },

    stop(): void {
      if (cronJob) {
        cronJob.stop();
        cronJob = null;
        log.info("quality observer stopped");
      }
    },
  };
}
