import type { Octokit } from "@octokit/rest";
import { addPRComment } from "../../repo/github.js";
import type { ReviewModelRun } from "./review-provider.js";
import { createLogger } from "../../logger.js";

const log = createLogger({ component: "PostFanoutComments" });

export interface PostFanoutResult {
  /** Number of runs where raw-output fallback was used (structured parse failed). */
  fallbackCount: number;
  /**
   * Number of per-model comments suppressed because the model returned empty findings
   * with no rawOutput (i.e. the model legitimately found nothing to report).
   * Suppression rule: `findings.length === 0 && rawOutput === undefined && status !== "failed"`.
   * Audit events (`review.fanout_model_completed`) still fire for suppressed runs.
   */
  suppressedEmptyCount: number;
}

export async function postFanoutCommentsToPR(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  runs: ReviewModelRun[],
): Promise<PostFanoutResult> {
  const toPost: ReviewModelRun[] = [];
  let suppressedEmptyCount = 0;

  for (const run of runs) {
    const shouldSuppress =
      run.status !== "failed" &&
      run.findings.length === 0 &&
      run.rawOutput === undefined;
    if (shouldSuppress) {
      suppressedEmptyCount++;
      log.debug(
        { modelId: run.modelId },
        "fanout: suppressing empty-findings comment (no findings, no rawOutput)",
      );
    } else {
      toPost.push(run);
    }
  }

  const results = await Promise.allSettled(
    toPost.map((run) =>
      addPRComment(octokit, owner, repo, prNumber, renderRunMarkdown(run)),
    ),
  );
  results.forEach((res, i) => {
    if (res.status === "rejected") {
      const err = res.reason instanceof Error ? res.reason.message : String(res.reason);
      log.warn(
        { modelId: toPost[i]!.modelId, err },
        "failed to post fanout PR comment",
      );
    }
  });
  const fallbackCount = runs.filter((r) => r.rawOutput !== undefined).length;
  return { fallbackCount, suppressedEmptyCount };
}

export function renderRunMarkdown(run: ReviewModelRun): string {
  const tokens = `${run.inputTokens.toLocaleString()} in / ${run.outputTokens.toLocaleString()} out tokens`;
  const seconds = (run.durationMs / 1000).toFixed(1);
  const header = `🔎 Review by \`${run.modelId}\` (via OpenRouter)\n\n`;
  if (run.status === "failed") {
    return [
      header,
      `Status: failed · ${run.errorMessage ?? "unknown error"} · ${seconds}s\n\n`,
      "_Advisory only — does not block merge._\n",
    ].join("");
  }
  const truncationNote =
    run.truncatedFiles && run.truncatedFiles > 0
      ? `\n\n_Note: input truncated; ${run.truncatedFiles} file ${run.truncatedFiles === 1 ? "body" : "bodies"} dropped to fit context window._`
      : "";
  // Fallback: raw output when structured parse failed
  if (run.rawOutput !== undefined) {
    return [
      header,
      `Status: completed (raw output, structured parse failed) · ${tokens} · ${seconds}s\n\n`,
      run.rawOutput,
      truncationNote,
      "\n\n_Advisory only — does not block merge. See deep-review for blocking findings._\n",
    ].join("");
  }
  const table =
    run.findings.length === 0
      ? "_No findings._\n"
      : [
          "| Severity | File | Line | Category | Description |",
          "|---|---|---|---|---|",
          ...run.findings.map(
            (f) =>
              `| ${f.severity} | ${escapeCell(f.file)} | ${f.line} | ${escapeCell(f.category)} | ${escapeCell(f.description)} |`,
          ),
        ].join("\n");
  return [
    header,
    `Status: completed · ${tokens} · ${seconds}s\n\n`,
    table,
    truncationNote,
    "\n\n_Advisory only — does not block merge. See deep-review for blocking findings._\n",
  ].join("");
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}
