/**
 * Parses a string as a positive integer, returning fallback for undefined, empty, NaN,
 * or non-positive values. NaN-safe: uses Number.isFinite before accepting the result.
 */
export function parseIntOr(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Parses a string as a non-negative float, returning fallback for undefined, empty, NaN,
 * or negative values. NaN-safe: uses Number.isFinite before accepting the result.
 */
export function parseFloatOr(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = parseFloat(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Parses a string as a positive integer, returning undefined for undefined, empty, NaN,
 * or non-positive values. NaN-safe: uses Number.isFinite before accepting the result.
 */
export function parsePositiveIntOrUndefined(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
