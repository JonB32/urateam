/**
 * Shared env-var parsing utilities (extracted per BEC-188).
 * Use these instead of bare parseInt/parseFloat to avoid silent NaN propagation.
 */

/** Parse a non-negative integer, returning `fallback` for missing/invalid input. */
export function parseIntOr(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Parse a positive (> 0) integer, returning `fallback` for missing/invalid input. */
export function parsePosIntOr(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Parse a non-negative float, returning `fallback` for missing/invalid input. */
export function parseFloatOr(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = parseFloat(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Parse a positive integer, returning `undefined` for missing/invalid input. */
export function parseOptPosInt(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Split a comma-separated string, trimming whitespace and dropping empty entries. */
export function parseCsv(raw: string): string[] {
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}
