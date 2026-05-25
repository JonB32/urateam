/**
 * Truncate `text` to at most `maxLen` characters, appending an ellipsis
 * character (`…`) when truncation occurs. The returned string is never longer
 * than `maxLen`.
 *
 * Examples:
 *   truncateWithEllipsis("hello", 10) → "hello"
 *   truncateWithEllipsis("hello world", 8) → "hello w…"
 *
 * Shared helper used by Slack digest formatting (slack.ts) and the Tier 5
 * escalation comment (promote.ts) to keep truncation semantics consistent.
 */
export function truncateWithEllipsis(text: string, maxLen: number): string {
  if (maxLen <= 0) return "";
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + "…";
}
