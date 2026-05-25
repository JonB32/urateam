/**
 * Hot-reload of `~/.urateam/config.json` (`$URATEAM_HOME/config.json`).
 *
 * Watches the file via `fs.watch` with debouncing (default 1s), re-reads
 * + zod-validates on change, diffs against the previous config, and emits
 * an `applied` event with the diff. Schema-validation failures keep the
 * previous in-memory config and emit `error`.
 *
 * The watcher is read-only — callers handle the mutation (since they own
 * the live `repoConfigs` object that the runner reads from). JS objects
 * are pass-by-reference + single-threaded, so a property-level mutation
 * propagates to the runner without any new lock.
 */
import { watch, type FSWatcher } from "node:fs";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  readUserLevelConfig,
  type UserLevelConfig,
  type UserLevelRepo,
} from "./user-level-config.js";

/**
 * Fields that are safe to swap mid-flight. Changes to these propagate
 * immediately into the live repoConfigs.
 */
export const SAFE_REPO_FIELDS = [
  "labelPattern",
  "testCommand",
  "buildCommand",
  "teamId",
] as const satisfies ReadonlyArray<keyof UserLevelRepo>;

/**
 * Fields that change the daemon's wiring in ways the runner can't pick up
 * mid-flight. Modifying these triggers a "restart required" warning.
 */
export const UNSAFE_REPO_FIELDS = [
  "url",
  "path",
  "defaultBranch",
] as const satisfies ReadonlyArray<keyof UserLevelRepo>;

export interface ConfigDiff {
  /** Repo URLs that are present in the new config but not the previous. */
  added: UserLevelRepo[];
  /** Repo URLs that were in the previous but not the new config. */
  removed: UserLevelRepo[];
  /**
   * Repos present in both, with at least one safe field changed.
   * Carries the previous entry (so the caller can derive the OLD map key)
   * and the new entry plus the list of changed safe-field names.
   */
  modifiedSafe: Array<{
    prev: UserLevelRepo;
    repo: UserLevelRepo;
    fields: string[];
  }>;
  /** Same as modifiedSafe but for unsafe-field changes (restart required). */
  modifiedUnsafe: Array<{
    prev: UserLevelRepo;
    repo: UserLevelRepo;
    fields: string[];
  }>;
}

/**
 * Compute the diff between two configs, splitting modifications into
 * safe-to-apply vs restart-required categories.
 */
export function diffRepos(
  prev: UserLevelConfig,
  next: UserLevelConfig,
): ConfigDiff {
  const prevByUrl = new Map(prev.repos.map((r) => [r.url, r]));
  const nextByUrl = new Map(next.repos.map((r) => [r.url, r]));

  const added: UserLevelRepo[] = [];
  const removed: UserLevelRepo[] = [];
  const modifiedSafe: ConfigDiff["modifiedSafe"] = [];
  const modifiedUnsafe: ConfigDiff["modifiedUnsafe"] = [];

  for (const [url, next] of nextByUrl) {
    const prev = prevByUrl.get(url);
    if (!prev) {
      added.push(next);
      continue;
    }
    const safeChanged: string[] = [];
    const unsafeChanged: string[] = [];
    for (const f of SAFE_REPO_FIELDS) {
      if (prev[f] !== next[f]) safeChanged.push(f);
    }
    for (const f of UNSAFE_REPO_FIELDS) {
      if (prev[f] !== next[f]) unsafeChanged.push(f);
    }
    if (safeChanged.length > 0) {
      modifiedSafe.push({ prev, repo: next, fields: safeChanged });
    }
    if (unsafeChanged.length > 0) {
      modifiedUnsafe.push({ prev, repo: next, fields: unsafeChanged });
    }
  }
  for (const [url, prev] of prevByUrl) {
    if (!nextByUrl.has(url)) removed.push(prev);
  }

  return { added, removed, modifiedSafe, modifiedUnsafe };
}

/**
 * SHA-256 of the JSON-stringified config, for audit observability.
 *
 * Used only for the `config.reloaded` audit event payload — advisory, not
 * load-bearing for any routing decision. The hash assumes both inputs come
 * from `JSON.parse(readFileSync(...))` so key insertion order matches the
 * file's; we don't normalise nested key ordering here.
 */
export function hashConfig(cfg: UserLevelConfig): string {
  return createHash("sha256").update(JSON.stringify(cfg)).digest("hex");
}

export interface ConfigWatcherOpts {
  /** Absolute path to `config.json`. */
  path: string;
  /** Debounce window for fs.watch fires. Default 1000ms. */
  debounceMs?: number;
  /**
   * Reader override (tests pass a stub that returns the next config without
   * touching the disk). Default reads + zod-validates via
   * `readUserLevelConfig()`.
   */
  reader?: () => UserLevelConfig | null;
  /** Logger (defaults to console). */
  log?: (msg: string) => void;
}

export class ConfigWatcher extends EventEmitter {
  private watcher: FSWatcher | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private current: UserLevelConfig;
  private readonly debounceMs: number;
  private readonly read: () => UserLevelConfig | null;
  private readonly log: (msg: string) => void;

  constructor(
    initial: UserLevelConfig,
    private readonly opts: ConfigWatcherOpts,
  ) {
    super();
    this.current = initial;
    this.debounceMs = opts.debounceMs ?? 1000;
    this.read = opts.reader ?? readUserLevelConfig;
    this.log = opts.log ?? ((m) => console.log(m));
  }

  start(): void {
    if (this.watcher) return;
    this.watcher = watch(this.opts.path, () => this.scheduleReload());
  }

  /**
   * Cancels any pending debounce timer and schedules a fresh one. Called
   * internally by `start()`'s fs.watch handler and exposed publicly so the
   * unit tests can exercise debounce coalescing deterministically (fake
   * timers can't drive fs.watch on the OS).
   */
  scheduleReload(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(
      () => this.handleChange(),
      this.debounceMs,
    );
  }

  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  /** Current in-memory config (last successfully validated). */
  getCurrent(): UserLevelConfig {
    return this.current;
  }

  /**
   * Force a reload regardless of fs.watch firing. Useful for tests and for
   * operators who want to verify the watcher is working (`ura repo reload`
   * could call into this in a future iteration).
   */
  reloadNow(): void {
    this.handleChange();
  }

  private handleChange(): void {
    let next: UserLevelConfig | null;
    try {
      next = this.read();
    } catch (err) {
      this.log(
        `config-watcher: schema validation failed; keeping previous config. ${(err as Error).message}`,
      );
      this.emit("error", err);
      return;
    }
    if (!next) {
      this.log(
        "config-watcher: config file disappeared; keeping previous in-memory config",
      );
      return;
    }
    const diff = diffRepos(this.current, next);
    const isEmpty =
      diff.added.length === 0 &&
      diff.removed.length === 0 &&
      diff.modifiedSafe.length === 0 &&
      diff.modifiedUnsafe.length === 0;
    this.current = next;
    if (!isEmpty) {
      this.emit("applied", diff);
    }
  }
}
