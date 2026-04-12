/** Maximum number of automatic retries for transient failures. */
export const MAX_TRANSIENT_RETRIES = 3;

const TRANSIENT_PATTERNS = [
  /401/i,
  /authentication/i,
  /unauthorized/i,
  /429/i,
  /rate.?limit/i,
  /ECONNRESET/,
  /ETIMEDOUT/,
  /ECONNREFUSED/,
  /socket hang up/i,
  /network.?timeout/i,
  /fetch failed/i,
  /unable to access/i,
];

/**
 * Returns true if the error message matches a known transient failure pattern
 * (auth, network, rate limit). These failures are safe to retry with the
 * existing worktree preserved.
 */
export function isTransientError(message: string): boolean {
  return TRANSIENT_PATTERNS.some((p) => p.test(message));
}
