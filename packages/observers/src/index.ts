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

// Types
export type {
  QualityFinding,
  ObserverStore,
  TickResult,
} from "./types.js";
