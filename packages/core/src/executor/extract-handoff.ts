import type { HandoffParseResult } from "./handoff.js";
import { parseHandoffArtifact, buildFallback } from "./handoff.js";
import { gitExecSafe, gitExecRaw } from "../repo/git.js";
import { createLogger } from "../logger.js";

const log = createLogger({ component: "ExtractHandoff" });

/**
 * Parse `git status --porcelain` output into a list of changed file paths.
 * Handles renames ("XY old -> new" — emit `new`).
 */
function parseGitPorcelain(statusOutput: string): string[] {
  if (!statusOutput) return [];
  return statusOutput
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const path = line.substring(3);
      const arrowIdx = path.indexOf(" -> ");
      return arrowIdx >= 0 ? path.substring(arrowIdx + 4) : path;
    })
    .filter(Boolean);
}

/**
 * Extract a structured handoff artifact from the stage agent's raw output
 * and the actual worktree state.
 *
 * Strategy:
 * 1. Fast path: if the agent already produced valid JSON, use it — but
 *    cross-check against `git status --porcelain` and override an empty
 *    `filesChanged` list when the worktree actually has changes (urateam#35).
 *    Without this guard, an agent that emits `filesChanged: []` for a
 *    multi-file PR (or self-critique JSON in `summary`) leaves the PR body
 *    rendered as "No file changes recorded" + "No test changes" even though
 *    the diff has 15+ files.
 * 2. Otherwise, run git commands to get actual file changes and build the
 *    handoff programmatically from the diff + agent's raw text output
 *
 * No agent subprocess needed — this is fast and deterministic.
 */
export async function extractHandoff(
  agentOutput: string,
  runId: string,
  issueId: string,
  stage: string,
  workdir: string,
): Promise<HandoffParseResult> {
  // Fast path: if the agent already produced valid structured JSON, use it
  const fastResult = parseHandoffArtifact(agentOutput, runId, issueId, stage);
  if (fastResult.structured) {
    // Sanity check against the worktree: an empty `filesChanged` from the
    // agent is the symptom of urateam#35 — the agent's structured output
    // can be malformed (e.g., self-critique JSON leaks into `summary` and
    // `filesChanged: []` is emitted alongside) while the diff is real.
    // Trust git as the authoritative source of "what changed in the
    // worktree" only when the agent says nothing changed.
    //
    // We deliberately do NOT override a non-empty agent list, even when it
    // disagrees with git — agents may legitimately filter their list (e.g.,
    // exclude generated files), and the rotulus PR #7 symptom that drives
    // this fix is specifically the empty-on-multi-file case.
    //
    // No try/catch: gitExecRaw fails-open to "" on error rather than
    // rejecting (see git.ts), and `parseGitPorcelain("")` returns []. So a
    // git failure naturally short-circuits the override without throwing.
    // Mutation of fastResult.artifact is safe — fastResult is a local var
    // produced by parseHandoffArtifact and not aliased anywhere else before
    // we return it.
    if (fastResult.artifact.filesChanged.length === 0) {
      const statusOutput = await gitExecRaw(["status", "--porcelain"], workdir);
      const gitFilesChanged = parseGitPorcelain(statusOutput);
      if (gitFilesChanged.length > 0) {
        log.warn(
          { stage, gitFilesChanged: gitFilesChanged.length },
          "agent reported empty filesChanged but git shows real changes — overriding with git diff (urateam#35)",
        );
        fastResult.artifact.filesChanged = gitFilesChanged;
      }
    }
    return fastResult;
  }

  log.info({ stage }, "building handoff from git diff");

  const metadata = {
    runId,
    issueId,
    stage,
    timestamp: new Date().toISOString(),
  };

  try {
    // Run both git commands in parallel — they're independent
    const [statusOutput, diffStat] = await Promise.all([
      gitExecRaw(["status", "--porcelain"], workdir),
      gitExecSafe(["diff", "--stat", "HEAD"], workdir),
    ]);

    // Parse porcelain output: "XY filename" — 2 status chars + 1 space + path
    // For renames: "XY old -> new"
    const filesChanged = parseGitPorcelain(statusOutput);

    // Best-effort summary from agent output. The last few lines often contain
    // tool noise rather than meaningful prose. filesChanged is the reliable signal.
    const lines = agentOutput.split("\n").filter((l) => l.trim().length > 0);
    const summary = lines.length > 0
      ? lines.slice(-5).join(" ").slice(0, 500)
      : `Stage ${stage} completed`;

    const approach = diffStat
      ? `Modified ${filesChanged.length} file(s): ${diffStat.split("\n").pop() || ""}`
      : filesChanged.length > 0
        ? `${filesChanged.length} file(s) changed (new/untracked)`
        : "No file changes detected";

    log.info({ stage, filesChanged: filesChanged.length }, "handoff built");

    return {
      artifact: {
        ...metadata,
        summary,
        filesChanged,
        approach,
        context: { issueIntent: "", constraints: [], assumptions: [] },
        tokenBudget: { contextTokensUsed: 0, recommendedMaxTurns: 10 },
      },
      structured: false, // programmatically constructed from git, not agent-produced JSON
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error({ stage, err: msg }, "extraction failed");
  }

  return {
    artifact: buildFallback(metadata, `[extraction failed — see stage logs for stage "${stage}"]`),
    structured: false,
  };
}
