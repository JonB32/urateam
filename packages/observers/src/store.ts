import Database from "better-sqlite3";
import type { ObserverStore } from "./types.js";

/**
 * Creates a SQLite-backed observer store at the given path.
 * Pass ":memory:" for an in-memory store (useful in tests).
 *
 * Tables created on first open:
 *   observer_findings  — one row per registered fingerprint
 *   observer_meta      — key/value pairs for scheduler metadata (e.g. firstTickAt)
 */
export function createObserverStore(dbPath: string): ObserverStore {
  const db = new Database(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS observer_findings (
      fingerprint  TEXT    PRIMARY KEY,
      registered_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    );

    CREATE TABLE IF NOT EXISTS observer_meta (
      key        TEXT    PRIMARY KEY,
      value      TEXT    NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    );
  `);

  return {
    isFirstTick(): boolean {
      const row = db
        .prepare("SELECT COUNT(*) as n FROM observer_findings")
        .get() as { n: number };
      const meta = db
        .prepare("SELECT value FROM observer_meta WHERE key = 'firstTickAt'")
        .get();
      // True when findings table is empty OR firstTickAt row is absent
      return row.n === 0 || !meta;
    },

    hasFingerprint(fingerprint: string): boolean {
      return !!db
        .prepare("SELECT 1 FROM observer_findings WHERE fingerprint = ?")
        .get(fingerprint);
    },

    registerFingerprint(fingerprint: string): void {
      db.prepare(
        "INSERT OR IGNORE INTO observer_findings (fingerprint) VALUES (?)"
      ).run(fingerprint);
    },

    setFirstTickAt(): void {
      db.prepare(
        `INSERT INTO observer_meta (key, value)
         VALUES ('firstTickAt', ?)
         ON CONFLICT (key) DO UPDATE
           SET value = excluded.value,
               updated_at = strftime('%s', 'now')`
      ).run(new Date().toISOString());
    },

    countFingerprints(): number {
      const row = db
        .prepare("SELECT COUNT(*) as n FROM observer_findings")
        .get() as { n: number };
      return row.n;
    },

    close(): void {
      db.close();
    },
  };
}
