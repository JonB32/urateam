import type { HandoffParseResult } from "./handoff.js";
import { parseHandoffArtifact, buildFallback } from "./handoff.js";
import { gitExecSafe, gitExecRaw } from "../repo/git.js";
import { createLogger } from "../logger.js";

const log = createLogger({ component: "ExtractHandoff" });

/**
 * Extract a structured handoff artifact from the stage agent's raw output
 * and the actual worktree state.
 *
 * Strategy:
 * 1. Fast path: if the agent already produced valid JSON, use it directly
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
    const filesChanged = statusOutput
      ? statusOutput.split("\n")
          .filter(Boolean)
          .map((line) => {
            const path = line.substring(3);
            const arrowIdx = path.indexOf(" -> ");
            return arrowIdx >= 0 ? path.substring(arrowIdx + 4) : path;
          })
          .filter(Boolean)
      : [];

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
