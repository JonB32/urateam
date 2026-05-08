// Engine — core first-tick detection and dedup logic
export { isFirstTick, seedDedupOnFirstTick, processFindings } from "./engine.js";

// Scheduler — tick orchestration with cron support
export { createObserverScheduler } from "./scheduler.js";
export type { ObserverScheduler, ObserverSchedulerDeps } from "./scheduler.js";

// Store — SQLite-backed dedup persistence
export { createObserverStore } from "./store.js";

// Run patterns — pipeline-run-level pattern detection (BEC-169)
export { findLoopingDeepReviews, LOOP_TURN_THRESHOLD } from "./run-patterns.js";
export type { RunSummary, LoopingFinding } from "./run-patterns.js";

import { findLoopingDeepReviews } from "./run-patterns.js";
import type { RunSummary, LoopingFinding } from "./run-patterns.js";

/** Aggregated report from observeRunPatterns. */
export interface ObserverReport {
  loopingFindings: LoopingFinding[];
}

/**
 * Run all quality-observer pattern checks against a set of pipeline run
 * summaries and return an aggregated report. Main entry point for the
 * quality observer sidecar (BEC-138).
 */
export function observeRunPatterns(runs: RunSummary[]): ObserverReport {
  return { loopingFindings: findLoopingDeepReviews(runs) };
}

// Types
export type {
  QualityFinding,
  ObserverStore,
  TickResult,
} from "./types.js";
