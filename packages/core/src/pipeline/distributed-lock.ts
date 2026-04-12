/**
 * Distributed branch lock — prevents simultaneous push+PR creation for the
 * same branch across multiple server instances.
 *
 * Strategy:
 *   - PostgreSQL: `pg_try_advisory_lock(hashtext(branch))` with a poll/retry
 *     loop until the configurable timeout is reached.
 *   - SQLite: no-op adapter (SQLite is single-process; the in-process pushQueue
 *     already provides the necessary serialisation).
 */

import { sql } from "drizzle-orm";
import { isPostgres } from "../db/client.js";
import type { AnyDb } from "../db/client.js";
import { createLogger } from "../logger.js";

const log = createLogger({ component: "DistributedLock" });

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface LockAdapter {
  /** Attempt to acquire the lock for `key`. Returns true if acquired. */
  tryAcquire(key: string): Promise<boolean>;
  /** Release a previously acquired lock for `key`. */
  release(key: string): Promise<void>;
}

export class LockTimeoutError extends Error {
  constructor(key: string, timeoutMs: number) {
    super(
      `Could not acquire distributed lock for branch "${key}" within ${timeoutMs}ms — another instance may be creating the PR`,
    );
    this.name = "LockTimeoutError";
  }
}

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

/**
 * No-op adapter used for SQLite (single-process deployments).
 * The in-process pushQueue already serialises within a single process.
 */
export function createNoopLockAdapter(): LockAdapter {
  return {
    async tryAcquire(_key: string): Promise<boolean> {
      return true;
    },
    async release(_key: string): Promise<void> {},
  };
}

/**
 * PostgreSQL advisory lock adapter.
 * Uses session-level `pg_try_advisory_lock` so the lock is automatically
 * freed if the connection drops unexpectedly.
 */
export function createPgLockAdapter(db: AnyDb): LockAdapter {
  return {
    async tryAcquire(key: string): Promise<boolean> {
      try {
        const result = await db.execute(
          sql`SELECT pg_try_advisory_lock(hashtext(${key})) AS acquired`,
        );
        return result?.[0]?.acquired === true;
      } catch (err) {
        log.warn({ err, key }, "pg_try_advisory_lock failed — treating as not acquired");
        return false;
      }
    },

    async release(key: string): Promise<void> {
      try {
        await db.execute(
          sql`SELECT pg_advisory_unlock(hashtext(${key}))`,
        );
      } catch (err) {
        // Best-effort; session-level locks are released when the connection
        // closes anyway, so this is not critical.
        log.warn({ err, key }, "pg_advisory_unlock failed (best-effort)");
      }
    },
  };
}

/**
 * Returns the appropriate lock adapter for the given database driver.
 */
export function createBranchLockAdapter(db: AnyDb): LockAdapter {
  if (isPostgres(db)) {
    return createPgLockAdapter(db);
  }
  return createNoopLockAdapter();
}

// ---------------------------------------------------------------------------
// Core: withBranchLock
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 250;

/**
 * Acquire a distributed lock keyed by `key`, run `fn`, then release the lock.
 *
 * - If the lock is not available, the function polls every ~250 ms until
 *   `timeoutMs` elapses, then throws `LockTimeoutError`.
 * - The lock is always released in a `finally` block — including when `fn`
 *   throws — so deadlocks cannot occur due to application errors.
 *
 * @param adapter   Lock backend (Postgres advisory lock or no-op for SQLite)
 * @param key       Unique lock key (typically the git branch name)
 * @param timeoutMs Maximum time to wait for the lock before failing
 * @param fn        Work to perform while the lock is held
 */
export async function withBranchLock<T>(
  adapter: LockAdapter,
  key: string,
  timeoutMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;

  // Poll until we acquire the lock or the deadline passes.
  while (true) {
    const acquired = await adapter.tryAcquire(key);

    if (acquired) {
      log.debug({ key }, "distributed lock acquired");
      try {
        return await fn();
      } finally {
        await adapter.release(key);
        log.debug({ key }, "distributed lock released");
      }
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new LockTimeoutError(key, timeoutMs);
    }

    log.debug({ key, remaining }, "distributed lock not available, retrying");
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.min(POLL_INTERVAL_MS, remaining)),
    );
  }
}
