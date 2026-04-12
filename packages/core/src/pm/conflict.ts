import type { ConflictCheckResult } from "./types.js";
import { parseJsonObject } from "../executor/agent-stream.js";
import { createLogger } from "../logger.js";

const log = createLogger({ component: "PmAgent:conflict" });

export interface ActiveRun {
  issueId: string;
  branch: string;
}

export interface GetActiveFileMapsInput {
  activeRuns: ActiveRun[];
  defaultBranch: string;
  repoDir: string;
  execGit: (args: string[], cwd: string) => Promise<string>;
}

export async function getActiveFileMaps(
  input: GetActiveFileMapsInput,
): Promise<Map<string, Set<string>>> {
  const { activeRuns, defaultBranch, repoDir, execGit } = input;
  const fileMaps = new Map<string, Set<string>>();

  if (activeRuns.length === 0) return fileMaps;

  try {
    await execGit(["fetch", "--quiet"], repoDir);
  } catch {
    log.warn("git fetch failed, proceeding with local refs");
  }

  for (const run of activeRuns) {
    try {
      const output = await execGit(
        ["diff", "--name-only", `origin/${defaultBranch}..origin/${run.branch}`],
        repoDir,
      );
      const files = output
        .split("\n")
        .map((f) => f.trim())
        .filter(Boolean);
      fileMaps.set(run.issueId, new Set(files));
    } catch (err) {
      log.warn({ issueId: run.issueId, branch: run.branch, err }, "git diff failed, treating as empty");
      fileMaps.set(run.issueId, new Set());
    }
  }

  return fileMaps;
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
