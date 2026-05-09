# Changelog — @urateam/observers

All notable changes to this package will be documented in this file.

## [0.1.1] — 2026-05-09

### Added

- **BEC-169** — `findLoopingDeepReviews(runs)` and `observeRunPatterns(runs)`. Detects pipeline runs whose total turn count exceeded the threshold (`LOOP_TURN_THRESHOLD = 50`) WITHOUT having shipped a PR. Successful PR-creating runs are excluded — deep-review fanout legitimately produces high turn counts on the way to a successful PR. Driven by the BEC-152 false-positive (run `AUEHrV8TPvNF1PHB96mVt` hit 77 turns legitimately and produced PR #173, but was flagged as a loop).

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
  - `isFirstTick(store)` — returns `true` when `meta.firstTickAt` is absent (i.e. no tick has yet completed); insensitive to whether `observer_findings` is empty
  - `seedDedupOnFirstTick(store, computeFindings)` — registers fingerprints without filing, sets `firstTickAt`
  - `processFindings(store, computeFindings, fileIssue)` — normal dedup-and-file flow

  **Known limitation:** `processFindings` is not atomic across `fileIssue` and `registerFingerprint`. If `fileIssue` succeeds (issue created on GitHub) but the subsequent `registerFingerprint` write fails (process crash, disk full), the next tick will re-file the issue. SQLite writes are synchronous and rarely fail in isolation, so in practice this only affects crash scenarios. If duplicate filings become a real problem, switch the ordering to register-first / de-register-on-failure.

  **New export from `scheduler.ts`:**
  - `createObserverScheduler(deps)` — factory that wires `tick()`, `start()`, `stop()`

  **Environment variable:**
  - `QUALITY_OBSERVER_FIRST_TICK_FILE=true` — disables first-tick seeding and files immediately on the first tick (back-compat for CI / deliberate-reset scenarios). Can also be set programmatically via the `firstTickFile` field on `ObserverSchedulerDeps`.
