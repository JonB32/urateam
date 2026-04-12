import { eq, sql } from "drizzle-orm";
import { activeWork } from "../db/schema.js";
import type { AnyDb } from "../db/client.js";
import { createLogger, getLogContext } from "../logger.js";
import { gitExecRaw, gitExecSafe } from "../repo/git.js";

const baseLog = createLogger({ component: "coordination" });

/** Return a logger enriched with the current ALS context (issueId, runId) if present. */
function getLog() {
  const ctx = getLogContext();
  return ctx ? baseLog.child(ctx) : baseLog;
}

export interface ActiveWorkEntry {
  id: string;
  runId: string;
  issueId: string;
  stage: string;
  filesModified: string[] | null;
  startedAt: Date;
  updatedAt: Date;
}

export interface FileOverlapResult {
  hasOverlap: boolean;
  overlappingFiles: string[];
  conflictingRunIds: string[];
}

/**
 * Register or update an active work entry for a pipeline run.
 * Call this before each stage starts.
 */
export async function upsertActiveWork(
  db: AnyDb,
  entry: {
    runId: string;
    issueId: string;
    stage: string;
    filesModified?: string[];
  },
): Promise<void> {
  const id = entry.runId;
  const filesJson = entry.filesModified
    ? JSON.stringify(entry.filesModified)
    : null;

  try {
    await db
      .insert(activeWork)
      .values({
        id,
        runId: entry.runId,
        issueId: entry.issueId,
        stage: entry.stage,
        filesModified: filesJson,
        // Let DB defaults handle timestamps (avoids SQLite/PG schema mismatch)
      })
      .onConflictDoUpdate({
        target: activeWork.runId,
        set: {
          stage: entry.stage,
          filesModified: filesJson,
          // crossTimestamp.toDriver() serialises correctly for both drivers.
          updatedAt: new Date(),
        },
      });
  } catch (err) {
    getLog().warn({ err, runId: entry.runId }, "upsertActiveWork failed");
  }
}

/**
 * Remove an active work entry once a pipeline run completes or fails.
 */
export async function removeActiveWork(
  db: AnyDb,
  runId: string,
): Promise<void> {
  try {
    await db.delete(activeWork).where(eq(activeWork.runId, runId));
  } catch (err) {
    getLog().warn({ err, runId }, "removeActiveWork failed");
  }
}

/**
 * Check whether any currently-active runs are modifying the given files.
 * Returns overlap details so the caller can decide to wait or adjust scope.
 */
export async function checkFileOverlap(
  db: AnyDb,
  runId: string,
  files: string[],
): Promise<FileOverlapResult> {
  if (files.length === 0) {
    return { hasOverlap: false, overlappingFiles: [], conflictingRunIds: [] };
  }

  try {
    const others = await db
      .select({
        runId: activeWork.runId,
        filesModified: activeWork.filesModified,
      })
      .from(activeWork)
      .where(
        sql`${activeWork.runId} != ${runId} AND ${activeWork.filesModified} IS NOT NULL`,
      );

    const fileSet = new Set(files);
    const overlappingFiles: string[] = [];
    const conflictingRunIds: string[] = [];

    for (const row of others) {
      let otherFiles: string[] = [];
      try {
        otherFiles = JSON.parse(row.filesModified ?? "[]");
      } catch {
        continue;
      }

      const overlap = otherFiles.filter((f: string) => fileSet.has(f));
      if (overlap.length > 0) {
        for (const f of overlap) {
          if (!overlappingFiles.includes(f)) overlappingFiles.push(f);
        }
        conflictingRunIds.push(row.runId);
      }
    }

    return {
      hasOverlap: overlappingFiles.length > 0,
      overlappingFiles,
      conflictingRunIds,
    };
  } catch (err) {
    getLog().warn({ err, runId }, "checkFileOverlap failed, returning no overlap");
    return { hasOverlap: false, overlappingFiles: [], conflictingRunIds: [] };
  }
}

/**
 * Get all currently-active work entries (for dashboard display).
 */
export async function getActiveWork(db: AnyDb): Promise<ActiveWorkEntry[]> {
  try {
    const rows = await db.select().from(activeWork);
    return rows.map((r: any) => ({
      id: r.id,
      runId: r.runId,
      issueId: r.issueId,
      stage: r.stage,
      filesModified: r.filesModified ? JSON.parse(r.filesModified) : null,
      startedAt: r.startedAt,
      updatedAt: r.updatedAt,
    }));
  } catch (err) {
    getLog().warn({ err }, "getActiveWork failed");
    return [];
  }
}

/**
 * Get the list of files modified in the worktree — both uncommitted working
 * tree changes and any commits pushed ahead of origin on this branch.
 *
 * Combines two sources:
 *   1. `git status --porcelain`  — staged and unstaged working-tree changes
 *   2. `git log --name-only origin..HEAD` — files in branch-local commits
 *
 * Results are deduplicated. Returns [] on error (non-throwing).
 */
export async function getModifiedFiles(worktreePath: string): Promise<string[]> {
  try {
    const [statusOutput, logOutput] = await Promise.all([
      gitExecRaw(["status", "--porcelain"], worktreePath),
      gitExecSafe(["log", "--name-only", "--format=", "origin..HEAD"], worktreePath),
    ]);

    // Parse porcelain status lines: "XY filename" or "XY old -> new" (renames)
    const workingTree: string[] = statusOutput
      ? statusOutput
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const path = line.substring(3);
            const arrowIdx = path.indexOf(" -> ");
            return arrowIdx >= 0 ? path.substring(arrowIdx + 4) : path;
          })
          .filter(Boolean)
      : [];

    // Parse log output: one filename per line, blank lines between commits
    const committed: string[] = logOutput
      ? logOutput.split("\n").filter(Boolean)
      : [];

    return [...new Set([...workingTree, ...committed])];
  } catch (err) {
    getLog().warn({ err, worktreePath }, "getModifiedFiles failed");
    return [];
  }
}
