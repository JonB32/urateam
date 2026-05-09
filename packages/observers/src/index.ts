// Engine — core first-tick detection and dedup logic
export { isFirstTick, seedDedupOnFirstTick, processFindings } from "./engine.js";

// Scheduler — tick orchestration with cron support
export { createObserverScheduler } from "./scheduler.js";
export type { ObserverScheduler, ObserverSchedulerDeps } from "./scheduler.js";

// Store — SQLite-backed dedup persistence
export { createObserverStore } from "./store.js";

// Types
export type {
  QualityFinding,
  ObserverStore,
  TickResult,
} from "./types.js";
