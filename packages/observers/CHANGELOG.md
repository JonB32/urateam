# Changelog — @urateam/observers

All notable changes to this package will be documented in this file.

## [0.1.0] — 2026-05-08

### Added

- **BEC-172** — Quality Observer: first-tick dedup seeding to prevent batch-flooding GitHub Issues on fresh deploy.

  **Problem:** On a fresh install the observer's SQLite store is empty, so every finding from the 24h lookback window is classified as "new" and filed as a GitHub Issue at once. This created 5 historical-pattern issues (#178–182) on the first tick of the dogfood deployment.

  **Solution:** The `scheduler.tick()` method now calls `isFirstTick()` before computing findings. When the store is fresh (first tick), findings are computed as normal but fingerprints are written to `observer_findings` without filing any GitHub Issues. A summary log line is emitted:

  ```
  first-tick seed: 5 findings registered for dedup; not filed (observer is fresh-installed)
  ```

  On the second tick the same findings are deduped (0 issues filed). Only genuinely new patterns discovered on the third tick or later are filed.

  **New exports from `engine.ts`:**
  - `isFirstTick(store)` — returns `true` when `observer_findings` is empty or `meta.firstTickAt` is absent
  - `seedDedupOnFirstTick(store, computeFindings)` — registers fingerprints without filing, sets `firstTickAt`
  - `processFindings(store, computeFindings, fileIssue)` — normal dedup-and-file flow

  **New export from `scheduler.ts`:**
  - `createObserverScheduler(deps)` — factory that wires `tick()`, `start()`, `stop()`

  **Environment variable:**
  - `QUALITY_OBSERVER_FIRST_TICK_FILE=true` — disables first-tick seeding and files immediately on the first tick (back-compat for CI / deliberate-reset scenarios). Can also be set programmatically via the `firstTickFile` field on `ObserverSchedulerDeps`.
