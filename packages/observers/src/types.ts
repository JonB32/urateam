/**
 * A quality finding represents a pattern detected in pipeline run data
 * that may warrant filing a GitHub issue.
 */
export interface QualityFinding {
  /** Unique dedup key for this finding — same pattern across ticks produces the same fingerprint */
  fingerprint: string;
  /** GitHub issue title */
  title: string;
  /** GitHub issue body (markdown) */
  body: string;
  /** Optional GitHub labels to apply */
  labels?: string[];
}

/**
 * Result of a scheduler tick.
 */
export interface TickResult {
  /** Whether this tick was detected as the first tick (empty store) */
  firstTick: boolean;
  /** Number of fingerprints seeded (first-tick only, 0 otherwise) */
  seeded: number;
  /** Number of GitHub issues filed */
  filed: number;
  /** Number of findings skipped because fingerprint was already registered */
  skipped: number;
}

/**
 * Persistence layer for observer state (dedup fingerprints and metadata).
 */
export interface ObserverStore {
  /**
   * Returns true when the observer has never successfully completed a tick.
   * True when observer_findings is empty OR meta.firstTickAt row is absent.
   */
  isFirstTick(): boolean;
  /** Returns true if a finding with this fingerprint has already been registered */
  hasFingerprint(fingerprint: string): boolean;
  /** Registers a fingerprint so future ticks will recognise it as a duplicate */
  registerFingerprint(fingerprint: string): void;
  /** Records that the first tick has completed (persists firstTickAt in meta) */
  setFirstTickAt(): void;
  /** Returns the total number of registered fingerprints */
  countFingerprints(): number;
  /** Closes the underlying database connection */
  close(): void;
}
