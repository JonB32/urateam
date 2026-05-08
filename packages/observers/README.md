# @urateam/observers

Quality observer for the urateam pipeline. Detects recurring quality patterns in pipeline run data and files GitHub Issues for new patterns, with built-in dedup to prevent repeat filings.

## First-tick seeding

On a fresh deployment the observer's SQLite store (`observer.db`) is empty. Without special handling, the 24-hour lookback window would cause every historical pattern to be filed at once — potentially dozens of GitHub Issues about already-resolved tickets.

**Default behaviour:** On the very first tick, the observer seeds the dedup store with all current findings but does **not** file any GitHub Issues. A log line summarises the action:

```
first-tick seed: 5 findings registered for dedup; not filed (observer is fresh-installed)
```

On subsequent ticks:
- Tick 2 (same patterns) — 0 issues filed (dedup catches them)
- Tick 3+ (new pattern appears) — only the new finding is filed

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `QUALITY_OBSERVER_FIRST_TICK_FILE` | `false` | Set to `true` to disable first-tick seeding and file all findings immediately. Use for CI or deliberate-reset scenarios. |

## Usage

```typescript
import { createObserverStore, createObserverScheduler } from "@urateam/observers";

const store = createObserverStore("/var/observer/observer.db");

const scheduler = createObserverScheduler({
  store,
  computeFindings: async () => {
    // Query your pipeline_runs database and return QualityFinding[]
    return [];
  },
  fileGithubIssue: async (finding) => {
    // Call GitHub API to open an issue; return the URL or null to skip
    return null;
  },
});

// Run on a schedule (default: every hour)
scheduler.start("0 * * * *");

// Or run a single tick manually
const result = await scheduler.tick();
console.log(result);
// { firstTick: true, seeded: 5, filed: 0, skipped: 0 }
```

## Deploy steps

1. Set `QUALITY_OBSERVER_FIRST_TICK_FILE` in your environment if you want to bypass first-tick seeding.
2. Ensure the directory containing `observer.db` is writable by the process user.
3. On first start the SQLite tables (`observer_findings`, `observer_meta`) are created automatically.
