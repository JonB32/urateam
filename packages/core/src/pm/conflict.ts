import { existsSync } from "node:fs";
import type { ConflictCheckResult } from "./types.js";
import { parseJsonObject } from "../executor/agent-stream.js";
import { createLogger } from "../logger.js";

const log = createLogger({ component: "PmAgent:conflict" });

function parseGitLines(output: string): string[] {
  return output.split("\n").map((f) => f.trim()).filter(Boolean);
}

export interface ActiveRun {
  issueId: string;
  branch: string;
  /** Local worktree path for this run. Used as fallback when the branch has not yet been pushed to origin. */
  worktreePath?: string;
}

export interface GetActiveFileMapsInput {
  activeRuns: ActiveRun[];
  defaultBranch: string;
  repoDir: string;
  execGit: (args: string[], cwd: string) => Promise<string>;
  /** Injected for testability; defaults to `fs.existsSync`. */
  pathExists?: (p: string) => boolean;
}

export async function getActiveFileMaps(
  input: GetActiveFileMapsInput,
): Promise<Map<string, Set<string>>> {
  const { activeRuns, defaultBranch, repoDir, execGit, pathExists = existsSync } = input;
  const fileMaps = new Map<string, Set<string>>();

  if (activeRuns.length === 0) return fileMaps;

  try {
    await execGit(["fetch", "--quiet"], repoDir);
  } catch {
    log.warn("git fetch failed, proceeding with local refs");
  }

  for (const run of activeRuns) {
    // Deterministically check whether the branch exists on origin before diffing.
    // This avoids conflating "branch not yet pushed" with genuine git failures.
    let branchOnOrigin = false;
    try {
      await execGit(["rev-parse", "--verify", "--quiet", `origin/${run.branch}`], repoDir);
      branchOnOrigin = true;
    } catch {
      // Branch not on origin yet — expected for in-flight runs that haven't pushed.
    }

    if (branchOnOrigin) {
      // Branch already pushed — use the standard origin-diff path.
      try {
        const output = await execGit(
          ["diff", "--name-only", `origin/${defaultBranch}..origin/${run.branch}`],
          repoDir,
        );
        fileMaps.set(run.issueId, new Set(parseGitLines(output)));
      } catch (err) {
        log.warn({ issueId: run.issueId, branch: run.branch, err }, "git diff failed, treating as empty");
        fileMaps.set(run.issueId, new Set());
      }
    } else {
      // Branch not yet on origin — read in-progress files from the local worktree.
      // This is the normal state for runs that are still executing stages.
      log.debug({ issueId: run.issueId, branch: run.branch }, "branch not yet on origin, reading worktree for conflict detection");
      fileMaps.set(run.issueId, await getWorktreeFiles(run, defaultBranch, execGit, pathExists));
    }
  }

  return fileMaps;
}

async function getWorktreeFiles(
  run: ActiveRun,
  defaultBranch: string,
  execGit: (args: string[], cwd: string) => Promise<string>,
  pathExists: (p: string) => boolean,
): Promise<Set<string>> {
  if (!run.worktreePath) return new Set();

  if (!pathExists(run.worktreePath)) {
    log.debug(
      { issueId: run.issueId, worktreePath: run.worktreePath },
      "worktree not yet created (or already cleaned up), skipping conflict-detection for this run",
    );
    return new Set();
  }

  const files = new Set<string>();

  // Run both git operations in parallel — they are independent reads.
  const [diffResult, statusResult] = await Promise.allSettled([
    execGit(["diff", "--name-only", `origin/${defaultBranch}...HEAD`], run.worktreePath),
    execGit(["status", "--porcelain"], run.worktreePath),
  ]);

  if (diffResult.status === "fulfilled") {
    for (const f of parseGitLines(diffResult.value)) {
      files.add(f);
    }
  } else {
    log.warn(
      { issueId: run.issueId, worktreePath: run.worktreePath, err: diffResult.reason },
      "worktree diff failed, skipping committed files; if error shows 'spawn git ENOENT', verify git is installed and in PATH",
    );
  }

  if (statusResult.status === "fulfilled") {
    for (const line of statusResult.value.split("\n")) {
      if (line.length < 4) continue;
      const path = line.slice(3).trim();
      // Renamed files appear as "old -> new"; take the destination name.
      const parts = path.split(" -> ");
      files.add(parts[parts.length - 1]);
    }
  } else {
    log.warn(
      { issueId: run.issueId, worktreePath: run.worktreePath, err: statusResult.reason },
      "worktree status failed, skipping uncommitted files; if error shows 'spawn git ENOENT', verify git is installed and in PATH",
    );
  }

  return files;
}

export interface PredictConflictInput {
  candidateDescription: string;
  activeFileMaps: Map<string, Set<string>>;
  callClaude: (prompt: string) => Promise<string>;
  sanitize?: (text: string) => string;
}

export async function predictConflict(
  input: PredictConflictInput,
): Promise<ConflictCheckResult> {
  const { candidateDescription, activeFileMaps, callClaude, sanitize } = input;

  const allActiveFiles: string[] = [];
  for (const files of activeFileMaps.values()) {
    for (const f of files) allActiveFiles.push(f);
  }

  if (allActiveFiles.length === 0) {
    return { overlapRisk: "none", likelyFiles: [], reasoning: "no active runs with known files" };
  }

  const safeDescription = sanitize ? sanitize(candidateDescription) : candidateDescription;
  const safeFiles = allActiveFiles.map((f) =>
    f.replace(/[^\w/.@_-]/g, "").slice(0, 500),
  );

  const prompt =
    `You are analyzing whether a new issue would conflict with files already being modified.\n\n` +
    `Files currently being modified by in-flight issues:\n${safeFiles.join("\n")}\n\n` +
    `New issue description:\n${safeDescription}\n\n` +
    `Return ONLY a JSON object: { "likelyFiles": ["file paths this issue would touch"], "overlapRisk": "none"|"low"|"high", "reasoning": "one sentence" }`;

  try {
    const response = await callClaude(prompt);
    const parsed = parseJsonObject(response);
    if (!parsed) throw new Error("No JSON found");

    return {
      overlapRisk: parsed.overlapRisk ?? "low",
      likelyFiles: parsed.likelyFiles ?? [],
      reasoning: parsed.reasoning ?? "",
    };
  } catch (err) {
    log.warn({ err }, "conflict prediction failed, defaulting to low risk");
    return { overlapRisk: "low", likelyFiles: [], reasoning: "prediction failed, defaulting to low" };
  }
}
