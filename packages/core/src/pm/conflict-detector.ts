import { createLogger } from "../logger.js";

const log = createLogger({ component: "PmAgent:conflict-detector" });

// ---------------------------------------------------------------------------
// Issue file parsing
// ---------------------------------------------------------------------------

/**
 * Parse the `**Files**:` section from a Linear issue description.
 * Matches the pattern:  **Files**: path/a.ts, path/b.ts
 * or multi-value forms like:
 *   **Files**: `path/a.ts`, `packages/core/src/b.ts`
 */
export function parseIssueFiles(description: string): string[] {
  if (!description) return [];

  // Match **Files**: followed by a value on the same line
  const match = description.match(/\*\*Files\*\*:\s*([^\n]+)/i);
  if (!match) return [];

  const raw = match[1];

  // Split by comma, strip backticks, whitespace, and sanitize each path
  return raw
    .split(",")
    .map((f) =>
      f
        .replace(/`/g, "")
        .replace(/[^\w/.@_-]/g, "")
        .trim(),
    )
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Conflict matrix
// ---------------------------------------------------------------------------

export interface IssueWithFiles {
  issueId: string;
  /** Linear priority: 1 = urgent, 2 = high, 3 = medium, 4 = low, 0 = no priority */
  priority: number;
  files: string[];
}

/**
 * Build a conflict matrix for a list of issues.
 * Returns a Map of issueId -> array of issueIds it conflicts with.
 * Conflict = at least one shared file path.
 */
export function buildConflictMatrix(
  issues: IssueWithFiles[],
): Map<string, string[]> {
  const matrix = new Map<string, string[]>();

  for (let i = 0; i < issues.length; i++) {
    const a = issues[i];
    if (!matrix.has(a.issueId)) matrix.set(a.issueId, []);

    for (let j = i + 1; j < issues.length; j++) {
      const b = issues[j];

      const aFiles = new Set(a.files);
      const hasOverlap = b.files.some((f) => aFiles.has(f));

      if (hasOverlap) {
        matrix.get(a.issueId)!.push(b.issueId);

        if (!matrix.has(b.issueId)) matrix.set(b.issueId, []);
        matrix.get(b.issueId)!.push(a.issueId);

        log.debug(
          { issueA: a.issueId, issueB: b.issueId },
          "conflict detected between issues",
        );
      }
    }
  }

  return matrix;
}

// ---------------------------------------------------------------------------
// Active-run file overlap detection
// ---------------------------------------------------------------------------

export interface FileOverlapResult {
  hasConflict: boolean;
  overlappingFiles: string[];
  conflictingRunIds: string[];
}

/**
 * Check whether a candidate's files overlap with any currently active run.
 *
 * @param candidateFiles - Files the new issue is expected to touch.
 * @param activeWorkMap  - runId → Set<filePath> from PipelineRunner.
 */
export function detectFileOverlap(
  candidateFiles: string[],
  activeWorkMap: ReadonlyMap<string, ReadonlySet<string>>,
): FileOverlapResult {
  const overlappingFiles: string[] = [];
  const conflictingRunIds: string[] = [];

  const candidateSet = new Set(candidateFiles);

  for (const [runId, files] of activeWorkMap) {
    const shared: string[] = [];
    for (const f of files) {
      if (candidateSet.has(f)) shared.push(f);
    }
    if (shared.length > 0) {
      overlappingFiles.push(...shared);
      conflictingRunIds.push(runId);
    }
  }

  return {
    hasConflict: conflictingRunIds.length > 0,
    overlappingFiles: [...new Set(overlappingFiles)],
    conflictingRunIds,
  };
}

// ---------------------------------------------------------------------------
// Priority-aware issue ordering
// ---------------------------------------------------------------------------

/**
 * Sort issues for parallel assignment:
 * 1. Higher priority issues first (lower numeric value = higher priority).
 * 2. When two issues conflict, the one with higher priority is kept for
 *    immediate assignment; the other is deferred.
 *
 * Returns an ordered list where each selected issue has no file overlap with
 * any previously selected issue in the slice.
 */
export function sortAndFilterNonConflicting(
  issues: IssueWithFiles[],
): IssueWithFiles[] {
  // Sort: priority ascending (1 = urgent first), then stable by original order
  const sorted = [...issues].sort((a, b) => {
    const pa = a.priority === 0 ? 999 : a.priority;
    const pb = b.priority === 0 ? 999 : b.priority;
    return pa - pb;
  });

  const selected: IssueWithFiles[] = [];
  const assignedFiles = new Set<string>();

  for (const issue of sorted) {
    const overlap = issue.files.some((f) => assignedFiles.has(f));
    if (!overlap) {
      selected.push(issue);
      for (const f of issue.files) assignedFiles.add(f);
    } else {
      log.info(
        { issueId: issue.issueId, priority: issue.priority },
        "deferring issue — file conflict with higher-priority assignment",
      );
    }
  }

  return selected;
}
