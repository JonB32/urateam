import pino from "pino";
import type { ObserverStore, QualityFinding } from "./types.js";

const log = pino({ name: "QualityObserver:engine" });

/**
 * Returns true when the observer has never completed a tick.
 * Detects first-run state by checking for an empty findings table
 * or an absent firstTickAt meta row.
 *
 * Exported so callers (e.g. scheduler) can test without accessing the store directly.
 */
export function isFirstTick(store: ObserverStore): boolean {
  return store.isFirstTick();
}

/**
 * Seeds the dedup store with all current findings WITHOUT filing any GitHub issues.
 *
 * Called on the very first tick of a fresh install to prevent historical-batch flooding.
 * After this call, `isFirstTick()` returns false and subsequent ticks file only new patterns.
 *
 * Emits a structured log line:
 *   "first-tick seed: N findings registered for dedup; not filed (observer is fresh-installed)"
 *
 * @param store          - The observer persistence store
 * @param computeFindings - Async factory that returns the current set of findings
 * @returns Number of fingerprints registered
 */
export async function seedDedupOnFirstTick(
  store: ObserverStore,
  computeFindings: () => Promise<QualityFinding[]>
): Promise<{ seeded: number }> {
  const findings = await computeFindings();

  for (const finding of findings) {
    store.registerFingerprint(finding.fingerprint);
  }

  // Persist the firstTickAt timestamp so isFirstTick() returns false from now on
  store.setFirstTickAt();

  log.info(
    `first-tick seed: ${findings.length} findings registered for dedup; not filed (observer is fresh-installed)`
  );

  return { seeded: findings.length };
}

/**
 * Processes a set of findings against the dedup store, filing only new ones via GitHub.
 * Already-registered fingerprints are silently skipped.
 * Each successfully filed finding has its fingerprint registered so it is not re-filed.
 *
 * @param store           - The observer persistence store
 * @param computeFindings - Async factory that returns the current set of findings
 * @param fileIssue       - Async function that files a single finding as a GitHub issue,
 *                          returning the issue URL on success or null on skip/error
 */
export async function processFindings(
  store: ObserverStore,
  computeFindings: () => Promise<QualityFinding[]>,
  fileIssue: (finding: QualityFinding) => Promise<string | null>
): Promise<{ filed: number; skipped: number }> {
  const findings = await computeFindings();
  let filed = 0;
  let skipped = 0;

  for (const finding of findings) {
    if (store.hasFingerprint(finding.fingerprint)) {
      skipped++;
      continue;
    }

    const url = await fileIssue(finding);
    if (url !== null) {
      store.registerFingerprint(finding.fingerprint);
      filed++;
    }
  }

  return { filed, skipped };
}
