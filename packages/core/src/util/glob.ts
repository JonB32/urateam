/**
 * Test whether a file path matches any of the provided glob patterns.
 * Supports `**` (any path segments), `*` (any chars except `/`), and `?`
 * (any single char except `/`). Used for auto-merge exclusion patterns.
 */
export function matchesAnyPattern(filePath: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    const regexStr = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, "\x00")
      .replace(/\*/g, "[^/]*")
      .replace(/\?/g, "[^/]")
      .replace(/\/\x00\//g, "(?:/|/.+/)")
      .replace(/^\x00\//, "(?:.+/)?")
      .replace(/\/\x00$/, "(?:/.+)?")
      .replace(/\x00/g, ".*");
    return new RegExp(`^${regexStr}$`).test(filePath);
  });
}
