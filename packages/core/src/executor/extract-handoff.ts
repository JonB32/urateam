import type { HandoffParseResult } from "./handoff.js";
import { parseHandoffArtifact, buildFallback } from "./handoff.js";
import { gitExecSafe, gitExecRaw } from "../repo/git.js";
import { createLogger } from "../logger.js";
import { DecisionArtifactSchema, type DecisionArtifact } from "../types.js";

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
 * Parse `git diff --name-only` output into a list of changed file paths.
 * Newline-separated; one path per line.
 */
function parseGitDiffNames(output: string): string[] {
  if (!output) return [];
  return output.split("\n").map((p) => p.trim()).filter(Boolean);
}

/**
 * Compute "what did the agent change in this branch" by combining the
 * uncommitted worktree state (`git status --porcelain`) with the
 * already-committed-on-the-branch diff against `baseRef` (`git diff
 * --name-only baseRef...HEAD`).
 *
 * Both signals are needed because the runner runs `autoCommitChanges`
 * between stages — which means a review-stage handoff sees a clean
 * worktree, even though the implement stage just modified 15 files. Status
 * alone misses those committed-then-rewound changes.
 *
 * fail-open: gitExecRaw resolves to "" on error, so a missing baseRef
 * (e.g., no `origin/main` configured in a test repo) is silent.
 */
async function gitChangedFilesAcross(
  workdir: string,
  baseRef: string | undefined,
): Promise<string[]> {
  const statusOutput = await gitExecRaw(["status", "--porcelain"], workdir);
  const fromStatus = parseGitPorcelain(statusOutput);
  if (!baseRef) return fromStatus;
  const diffOutput = await gitExecRaw(
    ["diff", "--name-only", `${baseRef}...HEAD`],
    workdir,
  );
  const fromDiff = parseGitDiffNames(diffOutput);
  // Dedupe in case a file shows up in both (unlikely but possible if the
  // agent partially committed and then made more edits).
  return Array.from(new Set([...fromStatus, ...fromDiff]));
}

/**
 * BEC-227 Phase 4 / Track D. Extracts the LAST `<decisions>{ JSON }</decisions>`
 * block from agent output. Returns null on any failure (missing block,
 * malformed JSON, schema mismatch) — graceful degradation by design;
 * Track B's surgical-review-fix path simply omits the "previously decided"
 * preamble when this returns null.
 */
export function parseDecisionsBlock(agentOutput: string): DecisionArtifact | null {
  if (!agentOutput) return null;
  // Match all blocks; take the last (an agent that revises its decisions
  // mid-turn ends with the canonical version).
  const re = /<decisions>([\s\S]*?)<\/decisions>/g;
  let lastMatch: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(agentOutput)) !== null) {
    lastMatch = m[1] ?? null;
  }
  if (lastMatch === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(lastMatch.trim());
  } catch {
    return null;
  }
  const result = DecisionArtifactSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

/**
 * Extract a structured handoff artifact from the stage agent's raw output
 * and the actual worktree state.
 *
 * Strategy:
 * 1. Fast path: if the agent already produced valid JSON, use it — but
 *    cross-check against the union of `git status --porcelain` (uncommitted)
 *    and `git diff --name-only baseRef...HEAD` (committed on this branch
 *    since it diverged from baseRef). Override an empty `filesChanged`
 *    list when git shows real changes (urateam#35). The committed-half
 *    of that union is load-bearing: the runner runs autoCommitChanges
 *    between stages, so by review-stage time the worktree is clean even
 *    though the implement stage modified N files. Status alone misses
 *    that case (gap from PR #95).
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
  /**
   * Optional base ref (e.g., "origin/main") to compare HEAD against for the
   * "agent committed work on the branch" portion of the empty-filesChanged
   * override. When absent, only the worktree (`git status --porcelain`) is
   * consulted — i.e., the PR #95 behavior. Pass the full ref form including
   * any `origin/` prefix the caller wants.
   */
  baseRef?: string,
): Promise<HandoffParseResult> {
  // BEC-227 Phase 4 / Track D — extract the `<decisions>` block from the
  // raw agent output up front so we can attach it to every return below.
  // Returns null when absent / malformed / schema-mismatch; downstream code
  // (executor's implement-stage persistence, surgical-review-fix prompt)
  // already handles null gracefully.
  const decisions = parseDecisionsBlock(agentOutput);

  // Fast path: if the agent already produced valid structured JSON, use it
  const fastResult = parseHandoffArtifact(agentOutput, runId, issueId, stage);
  if (fastResult.structured) {
    // Sanity check against git: an empty `filesChanged` from the agent is
    // the symptom of urateam#35 — the agent's structured output can be
    // malformed (e.g., self-critique JSON leaks into `summary` and
    // `filesChanged: []` is emitted alongside) while the diff is real.
    // Trust git as the authoritative source only when the agent says
    // nothing changed.
    //
    // We deliberately do NOT override a non-empty agent list, even when it
    // disagrees with git — agents may legitimately filter their list (e.g.,
    // exclude generated files), and the rotulus PR #7 symptom that drives
    // this fix is specifically the empty-on-multi-file case.
    //
    // gitExecRaw fails-open to "" on error rather than rejecting, so a
    // missing remote/baseRef is silent. Mutation of fastResult.artifact
    // is safe — fastResult is a local var produced by parseHandoffArtifact
    // and not aliased anywhere else before we return it.
    if (fastResult.artifact.filesChanged.length === 0) {
      const gitFilesChanged = await gitChangedFilesAcross(workdir, baseRef);
      if (gitFilesChanged.length > 0) {
        log.warn(
          { stage, gitFilesChanged: gitFilesChanged.length, baseRef: baseRef ?? "(worktree only)" },
          "agent reported empty filesChanged but git shows real changes — overriding (urateam#35)",
        );
        fastResult.artifact.filesChanged = gitFilesChanged;
      }
    }
    // BEC-227 Phase 4 / Track D — parseHandoffArtifact() never sees the
    // raw agent output (only the handoff JSON block) so it always returns
    // `decisions: null`. Overlay the real value parsed from the outer
    // agentOutput here. Mutation of fastResult is safe — it's a local var
    // and not aliased before this return.
    fastResult.decisions = decisions;
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
    // Slow path uses the same union helper. Necessary for the RALPH call
    // sites in pipeline/runner.ts which always take the slow path
    // (they invoke extractHandoff with agentOutput="" so parseJsonBlock
    // returns null). The fast-path override in PR #95 + this PR's widening
    // were the load-bearing fix for the rotulus#16 PR-body bug; the slow
    // path benefits incidentally.
    //
    // diffStat must scan the same range as filesChanged or the "Modified
    // N files: <stat tail>" approach string can be misleading (empty stat
    // alongside non-empty files when the worktree is autoCommit-clean).
    const statRange = baseRef ? `${baseRef}...HEAD` : "HEAD";
    const [filesChanged, diffStat] = await Promise.all([
      gitChangedFilesAcross(workdir, baseRef),
      gitExecSafe(["diff", "--stat", statRange], workdir),
    ]);

    // Best-effort summary from agent output. Two failure modes are common
    // here (urateam#97):
    //   - Review-stage agents emit review-finding JSON arrays (not the
    //     HandoffArtifact shape) which leak into the rendered PR body
    //     "## Summary" as `"description": "..."` / `"fix": "..."` fragments.
    //   - Implement/test stage agents emit nothing structured; the last few
    //     lines often contain tool noise rather than prose.
    // Detect JSON-fragment-shaped content and replace with a deterministic
    // placeholder. Reviewers got bitten on rotulus#7 by JSON-soup summaries
    // that looked like a structured review (and even flagged a real bug)
    // that nobody acted on.
    const lines = agentOutput.split("\n").filter((l) => l.trim().length > 0);
    const rawTail = lines.length > 0
      ? lines.slice(-5).join(" ").slice(0, 500)
      : "";
    // Heuristics tuned to avoid false positives on common agent prose:
    //   - `[x] tests pass`, `[PASS]`, `[fix] ...` — checklist / tag prefixes
    //   - `Added "env": "production" and "debug": "false"` — config-change prose
    //   - `{ destructured } = result` — JS destructuring prose
    // To trip detection, the tail must look STRUCTURALLY like JSON, not just
    // contain bracket characters. `^\s*[\[{]\s*[{"]` matches `[{...`, `{"...`,
    // and similar real JSON openers but not `[x]` / `{ destruct }` / etc.
    const looksLikeJsonSoup =
      /^\s*[[{]\s*["{]/.test(rawTail) ||
      /"(description|fix|severity|category)"\s*:/.test(rawTail) ||
      // Tighter threshold (3+) for the bare-property-pair heuristic. Two
      // pairs is too low — operators routinely write prose with two quoted
      // attribute references (e.g., "Added \"env\": \"production\" and
      // \"debug\": \"false\""). Three+ is consistent with real review-finding
      // JSON arrays which always emit many such pairs per tail window.
      (rawTail.match(/"\s*:\s*"/g)?.length ?? 0) >= 3;
    const summary = !rawTail
      ? `Stage ${stage} completed`
      : looksLikeJsonSoup
        ? `Stage ${stage} completed — agent output was not parseable prose; see Changes for files modified`
        : rawTail;

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
      decisions, // BEC-227 Phase 4 / Track D — null when no <decisions> block
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error({ stage, err: msg }, "extraction failed");
  }

  return {
    artifact: buildFallback(metadata, `[extraction failed — see stage logs for stage "${stage}"]`),
    structured: false,
    // BEC-227 Phase 4 / Track D — extraction failure means we lost the
    // worktree/git signal; the parsed decisions value from the agent's
    // raw output is still valid and worth surfacing here.
    decisions,
  };
}
