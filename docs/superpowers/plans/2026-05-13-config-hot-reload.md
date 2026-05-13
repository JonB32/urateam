# `config.json` Hot-Reload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `ura start` watches `~/.urateam/config.json` (`$URATEAM_HOME/config.json`) and picks up `ura repo add` / `ura repo remove` / safe field changes without a restart. In-flight pipeline runs continue uninterrupted.

**Architecture:** A `ConfigWatcher` (`packages/cli/src/lib/config-watcher.ts`) watches the file via `fs.watch` with debouncing (1s default), re-parses + zod-validates on change, diffs against the previous config, and emits an `applied` event with the diff. `start.ts` instantiates the watcher after `createApp`, mutates the live `repoConfigs` object in-place for added / removed / safe-modified repos, and logs warnings for unsafe modifications + repos with in-flight pipeline runs (deferred removal). Schema-validation failures keep the previous in-memory config and log a warning. JS objects are pass-by-reference so mutating the shared `repoConfigs` propagates to the runner without any new lock.

**Tech Stack:** Node 22 `fs.watch`, `node:events`, vitest. No new deps.

---

## File structure

**Create:**
- `packages/cli/src/lib/config-watcher.ts` — ConfigWatcher + diff helpers
- `packages/cli/src/__tests__/config-watcher.test.ts` — unit tests

**Modify:**
- `packages/cli/src/commands/start.ts` — instantiate watcher after createApp; wire mutation handler
- `packages/core/src/types.ts` — add `config.reloaded` to AuditEventTypeSchema
- `packages/core/src/audit/events.ts` — add `configReloadedEvent` builder
- `CLAUDE.md` — bump audit count 50 → 51; document the hot-reload contract
- `.claude/CLAUDE.md` — short note
- `deploy/USER_LEVEL_INSTALL.md` — new "Hot-reload" section; remove "Hot-reload" from "What's deferred"

---

## Behavior contract

**Safe-to-apply field changes (no restart needed):**
- `labelPattern`, `testCommand`, `buildCommand`, `teamId`

**Unsafe — restart required (logged as warning):**
- `url`, `path`, `defaultBranch`

**Add:** new entry registered immediately; webhook routes via the existing `selectRepoConfig` lookup are live as soon as the mutation lands.

**Remove:**
- If no in-flight `pipeline_runs WHERE status='running' AND repo_url=?` → unregister immediately.
- Else → log "draining: N runs in flight; deferring removal" and try again on the next reload tick. Operators can force-remove by restarting the daemon.

**Schema validation failure on new config:** warn-log the zod error, keep the in-memory config unchanged.

**Debouncing:** rapid successive writes (e.g. an editor saving twice) coalesce into one reload (default 1s window).

---

## Task 1: Audit event + builder

- [ ] Append to `AuditEventTypeSchema`:
  ```
  /** `ura start` reloaded ~/.urateam/config.json without restart. Payload
   *  carries added / removed / modified arrays + diff hash. */
  "config.reloaded",
  ```

- [ ] Add `configReloadedEvent` builder:
  ```typescript
  export function configReloadedEvent(args: {
    added: string[];
    removed: string[];
    modifiedSafe: string[];
    modifiedUnsafe: string[];
    sha256: string;
  }): AuditEvent {
    return base({
      eventType: "config.reloaded",
      actor: "system",
      actorType: "system",
      payload: {
        added: args.added,
        removed: args.removed,
        modifiedSafe: args.modifiedSafe,
        modifiedUnsafe: args.modifiedUnsafe,
        sha256: args.sha256,
      },
    });
  }
  ```

- [ ] Test in `audit-events-config-reloaded.test.ts`: shape + defense-in-depth no PII.

## Task 2: ConfigWatcher

- [ ] `packages/cli/src/lib/config-watcher.ts` exports:
  - `diffRepos(prev, next)` — pure function returning `{ added, removed, modifiedSafe, modifiedUnsafe }`
  - `ConfigWatcher` class with `start()` / `stop()` and `on("applied", diff)` / `on("error", err)`
- [ ] Tests in `config-watcher.test.ts`:
  - diffRepos: add, remove, modify-safe, modify-unsafe (4 separate tests)
  - debounce: 3 rapid writes coalesce into 1 reload (fake timers)
  - schema error: doesn't update internal state, emits "error" with zod error
  - stop() unwatches the file
  - file deletion mid-watch: handled gracefully

## Task 3: Wire into start.ts

- [ ] After createApp, build a `repoConfigs` mutation handler:
  - For each added repo: insert into `config.repoConfigs[key]`
  - For each removed repo: query `db.select(pipelineRuns).where(eq(status, "running")).where(eq(repoUrl, url))`; if empty, delete; else log + skip
  - For each modifiedSafe repo: merge fields into the existing entry
  - For each modifiedUnsafe repo: log warning with "restart required"
- [ ] Instantiate ConfigWatcher only in user-level mode (URATEAM_HOME or `~/.urateam/config.json` is the source); skip when REPO_* env vars are used (project-level / sidecar). Detection via `buildRepoConfigsFromEnv`'s mode.
- [ ] On graceful shutdown: stop the watcher.
- [ ] Emit `config.reloaded` audit event per applied reload.

## Task 4: Docs + CLAUDE.md count + release

- CLAUDE.md: bump 50 → 51; document safe vs unsafe fields and the draining behavior.
- `.claude/CLAUDE.md`: one-line note about hot-reload.
- `deploy/USER_LEVEL_INSTALL.md`: new "Hot-reload" section under "Running as a service" (or its own top-level section); remove the deferred bullet.

## Task 5: PR + Sonnet review + release v0.1.56

Same flow.

---

## Self-review

- Spec coverage: file watching, debounce, schema validation, add/remove/modify, drain on remove, in-flight pipelines uninterrupted, audit event — all covered.
- No new locking primitive: uses JS object mutation (single-threaded). Read coordination.ts before any tighter sync — confirmed not needed for this scope.
- Type consistency: `ConfigDiff` shape used in `diffRepos`, ConfigWatcher event, and configReloadedEvent payload.
