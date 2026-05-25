/**
 * PM Agent — bulk issue creation via Claude analysis.
 *
 * Responsibility: given a free-text request from a Slack user, ask Claude Sonnet
 * to produce a structured list of issue specifications that can be bulk-created
 * in Linear.
 *
 * Extracted from `slack-interface.ts` (BEC-195) so that this single concern has
 * its own file and can be unit-tested independently.
 */

import { createLogger } from "../logger.js";
import { sanitize } from "../executor/prompt/sanitizer.js";

const log = createLogger({ component: "PmAgent:slack-bulk" });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Valid numeric priority values accepted by Linear (1=Urgent … 4=Low). */
const VALID_PRIORITIES = [1, 2, 3, 4] as const;

/** Default priority used when a generated issue omits or has an invalid value. */
const DEFAULT_PRIORITY = 3;

/** Maximum allowed character length for an issue title. */
const MAX_ISSUE_TITLE_LENGTH = 200;

/** Maximum allowed character length for an issue description. */
const MAX_ISSUE_DESCRIPTION_LENGTH = 5000;

/** Maximum number of acceptance criteria strings per issue. */
const MAX_ACCEPTANCE_CRITERIA_COUNT = 10;

/** Maximum number of issue specs returned by a single bulk create request. */
const MAX_BULK_ISSUE_SPECS = 10;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single issue specification produced by `analyzeBulkCreateRequest`.
 * Each field maps directly to a Linear issue field; `acceptanceCriteria` are
 * appended to the issue description as a checklist.
 */
export interface BulkIssueSpec {
  title: string;
  description: string;
  priority: number;
  acceptanceCriteria: string[];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Uses a capable Claude model (Sonnet) to analyze a bulk create request and
 * produce a structured list of issue specifications ready for Linear creation.
 *
 * @param request - Free-text user request describing what issues to create
 *   (e.g. "find all gaps in error handling and create tickets for them").
 * @param callClaudeSonnet - Callable that sends a prompt to Claude Sonnet and
 *   returns the raw text response.
 * @returns Array of up to 10 `BulkIssueSpec` objects, or an empty array when
 *   the request cannot be analyzed or Claude returns malformed JSON.
 */
export async function analyzeBulkCreateRequest(
  request: string,
  callClaudeSonnet: (prompt: string) => Promise<string>,
): Promise<BulkIssueSpec[]> {
  const safe = sanitize(request);
  const prompt =
    `You are a software PM Agent. A user asked: "${safe}"\n\n` +
    `Analyze this request and generate a list of concrete, actionable software issues to create.\n` +
    `Each issue must have a clear title, description, priority (1=urgent, 2=high, 3=medium, 4=low), and acceptance criteria.\n\n` +
    `Respond ONLY with a JSON array (no other text), e.g.:\n` +
    `[\n` +
    `  {\n` +
    `    "title": "Issue title",\n` +
    `    "description": "Clear description of what needs to be done",\n` +
    `    "priority": 2,\n` +
    `    "acceptanceCriteria": ["Criterion 1", "Criterion 2"]\n` +
    `  }\n` +
    `]\n\n` +
    `Rules:\n` +
    `- Generate between 1 and 10 issues\n` +
    `- Each issue must be specific and actionable\n` +
    `- Priority must be 1, 2, 3, or 4\n` +
    `- acceptanceCriteria must be a non-empty array of strings\n` +
    `- Respond ONLY with the JSON array, no markdown fences or explanation`;

  try {
    const raw = await callClaudeSonnet(prompt);
    // Parse the array — look for a JSON array in the response
    const arrayMatch = raw.match(/\[[\s\S]*\]/);
    if (!arrayMatch) {
      log.warn({ responsePreview: raw.slice(0, 200) }, "bulk create: no JSON array in Claude response");
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(arrayMatch[0]);
    } catch {
      log.warn({ responsePreview: raw.slice(0, 200) }, "bulk create: failed to parse JSON array");
      return [];
    }
    if (!Array.isArray(parsed)) return [];

    const specs: BulkIssueSpec[] = [];
    for (const item of parsed) {
      if (typeof item !== "object" || item === null) continue;
      const title = typeof item.title === "string" ? item.title.trim() : "";
      const description = typeof item.description === "string" ? item.description.trim() : "";
      const priority =
        typeof item.priority === "number" && (VALID_PRIORITIES as readonly number[]).includes(item.priority)
          ? item.priority
          : DEFAULT_PRIORITY;
      const acceptanceCriteria = Array.isArray(item.acceptanceCriteria)
        ? item.acceptanceCriteria.filter((c: unknown) => typeof c === "string" && c.trim().length > 0)
        : [];
      if (!title) continue;
      // Cap field lengths to prevent excessively large Linear issues.
      specs.push({
        title: title.slice(0, MAX_ISSUE_TITLE_LENGTH),
        description: description.slice(0, MAX_ISSUE_DESCRIPTION_LENGTH),
        priority,
        acceptanceCriteria: acceptanceCriteria.slice(0, MAX_ACCEPTANCE_CRITERIA_COUNT),
      });
    }

    return specs.slice(0, MAX_BULK_ISSUE_SPECS);
  } catch (err) {
    log.warn({ err }, "bulk create: failed to analyze request");
    return [];
  }
}
