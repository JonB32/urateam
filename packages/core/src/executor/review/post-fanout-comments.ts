import type { Octokit } from "@octokit/rest";
import { addPRComment } from "../../repo/github.js";
import type { ReviewModelRun } from "./review-provider.js";

export async function postFanoutCommentsToPR(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  runs: ReviewModelRun[],
): Promise<void> {
  for (const run of runs) {
    await addPRComment(octokit, owner, repo, prNumber, renderRunMarkdown(run));
  }
}

function renderRunMarkdown(run: ReviewModelRun): string {
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
  const table =
    run.findings.length === 0
      ? "_No findings._\n"
      : [
          "| Severity | File | Line | Category | Description |",
          "|---|---|---|---|---|",
          ...run.findings.map(
            (f) =>
              `| ${f.severity} | ${escapePipe(f.file)} | ${f.line} | ${escapePipe(f.category)} | ${escapePipe(f.description)} |`,
          ),
        ].join("\n");
  const truncationNote =
    run.truncatedFiles && run.truncatedFiles > 0
      ? `\n\n_Note: input truncated; ${run.truncatedFiles} file ${run.truncatedFiles === 1 ? "body" : "bodies"} dropped to fit context window._`
      : "";
  return [
    header,
    `Status: completed · ${tokens} · ${seconds}s\n\n`,
    table,
    truncationNote,
    "\n\n_Advisory only — does not block merge. See deep-review for blocking findings._\n",
  ].join("");
}

function escapePipe(s: string): string {
  return s.replace(/\|/g, "\\|");
}
