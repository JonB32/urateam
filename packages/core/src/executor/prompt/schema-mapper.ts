import type { SanitizedIssue } from "../../types.js";
import { sanitize } from "./sanitizer.js";

/**
 * Generate a URL-safe slug from a title string.
 * Lowercase, alphanumeric + hyphens only, max 50 chars.
 */
function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

/**
 * Parse acceptance criteria from a description.
 * Looks for a "## Acceptance Criteria" section and extracts checkbox items.
 */
function parseAcceptanceCriteria(description: string): string[] {
  if (!description) return [];

  const sectionMatch = description.match(
    /## Acceptance Criteria\s*\n([\s\S]*?)(?=\n## |\n---|\s*$)/i,
  );
  if (!sectionMatch) return [];

  const section = sectionMatch[1];
  const items: string[] = [];
  const checkboxPattern = /- \[[ x]\]\s+(.+)/gi;
  let match: RegExpExecArray | null;
  while ((match = checkboxPattern.exec(section)) !== null) {
    items.push(match[1].trim());
  }
  return items;
}

/**
 * Maps a raw issue object (e.g. from Linear API) to a SanitizedIssue,
 * extracting only allowed fields and sanitizing text content.
 */
export function mapIssueToSchema(
  rawIssue: Record<string, any>,
): SanitizedIssue {
  const id = rawIssue.identifier ?? rawIssue.id ?? "";
  const title = rawIssue.title ?? "";
  const description = rawIssue.description ?? "";
  const priority = rawIssue.priority ?? 0;

  const labels: string[] = Array.isArray(rawIssue.labels)
    ? rawIssue.labels.map((l: any) =>
        typeof l === "string" ? l : l.name ?? "",
      )
    : [];

  const MAX_DESCRIPTION_LENGTH = 4000;
  const sanitizedDesc = sanitize(description);
  const trimmedDesc = sanitizedDesc.length > MAX_DESCRIPTION_LENGTH
    ? sanitizedDesc.slice(0, MAX_DESCRIPTION_LENGTH) + "… (trimmed)"
    : sanitizedDesc;

  return {
    id: String(id),
    slug: slugify(title),
    title: sanitize(title),
    description: trimmedDesc,
    acceptanceCriteria: parseAcceptanceCriteria(description).map(sanitize),
    labels,
    priority: Number(priority),
  };
}
