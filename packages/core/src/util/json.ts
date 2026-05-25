/**
 * Parses a JSON string, returning fallback for null, undefined, empty, or invalid JSON.
 * Logs nothing — the caller decides how to handle parse errors.
 */
export function parseJsonOr<T>(raw: string | null | undefined, fallback: T): T {
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
