import type { HandoffArtifact } from "../types.js";
import type { ReviewFeedbackComment } from "../webhook/github-handler.js";
import type { addPRComment } from "../repo/github.js";
import type { Logger } from "pino";

// Task 3 will extend HandoffArtifact.context with addressedComments in the
// Zod schema. Until then, we read it via a local augmented type.
type HandoffContext = HandoffArtifact["context"] & {
  addressedComments?: { commentId: string; response: string }[];
};

// Task 4 will add htmlUrl to ReviewFeedbackComment. Until then, we accept it
// via a locally augmented type so the dispatcher can pass it through.
type ReviewFeedbackCommentWithUrl = ReviewFeedbackComment & {
  htmlUrl?: string;
};

/**
 * Markdown-special characters escaped before rendering user-controlled
 * strings (author names, file paths, comment bodies). Conservative — escapes
 * anything that could affect markdown rendering.
 */
// `.` is omitted from the escape set: it is only markdown-special at the
// start of a line in ordered-list contexts (e.g. `1.`) — not in author
// names or file-paths rendered inline within link text.
function escapeMd(s: string): string {
  return s.replace(/[\\`*_{}\[\]()<>#+\-!|]/g, (ch) => `\\${ch}`);
}

/** Collapse all newlines (and runs of whitespace) into single spaces. */
function singleLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Build a comment-URL fallback when ReviewFeedbackComment.htmlUrl is missing.
 * Inline review comments (have filePath) are anchored to the Files Changed
 * tab via #discussion_rNNN; general PR comments use #issuecomment-NNN.
 *
 * The base PR URL must be supplied via input.prUrl. If absent, returns "".
 */
function buildCommentUrl(
  prUrl: string | undefined,
  comment: ReviewFeedbackCommentWithUrl,
): string {
  if (comment.htmlUrl) return comment.htmlUrl;
  if (!prUrl) return "";
  const anchor = comment.filePath
    ? `#discussion_r${comment.commentId}`
    : `#issuecomment-${comment.commentId}`;
  return `${prUrl}${anchor}`;
}

export interface ChangeSummaryInput {
  handoff: HandoffArtifact;
  run: { id: string; totalInputTokens: number; totalOutputTokens: number };
  triggeringComments: ReviewFeedbackComment[];
  dashboardBaseUrl: string;
  /** PR URL — used as the base for fallback comment URL construction. */
  prUrl?: string;
}

/**
 * Render the markdown body of the per-PR change-summary comment. Pure
 * function — no I/O, no GitHub calls.
 */
export function renderChangeSummary(input: ChangeSummaryInput): string {
  const { handoff, run, triggeringComments, dashboardBaseUrl, prUrl } = input;

  const summary = singleLine(handoff.summary);

  // TODO Task 3: schema extension makes addressedComments properly typed.
  const ctx = handoff.context as HandoffContext;
  const addressedById = new Map<string, string>();
  for (const ac of ctx.addressedComments ?? []) {
    addressedById.set(ac.commentId, ac.response);
  }

  const comments = triggeringComments as ReviewFeedbackCommentWithUrl[];

  const responseLines = comments.map((c) => {
    const url = buildCommentUrl(prUrl, c);
    const linkText = c.filePath
      ? `@${escapeMd(c.author)}'s comment on \`${escapeMd(c.filePath)}${
          c.lineNumber !== undefined ? `:${c.lineNumber}` : ""
        }\``
      : `@${escapeMd(c.author)}'s general comment`;
    const link = url ? `[${linkText}](${url})` : linkText;
    const response = addressedById.get(c.commentId);
    // Agent-emitted responses are interpolated raw — they are pipeline-
    // controlled output (not third-party user input) and may legitimately
    // contain markdown formatting (e.g. backticks for code references).
    // The agent prompt instructs ≤12 words per response, limiting injection
    // surface. If we ever discover prompt-injection paths from PR comments
    // that survive into `response`, revisit this decision.
    return response ? `- ${link} — ${response}` : `- ${link}`;
  });

  // Show the fallback disclaimer when there are triggering comments but none
  // with a matched response.
  const hasAnyResponse =
    Array.isArray(ctx.addressedComments) &&
    ctx.addressedComments.length > 0 &&
    triggeringComments.some((c) => addressedById.has(c.commentId));

  const fallbackLine =
    triggeringComments.length > 0 && !hasAnyResponse
      ? "\n_(per-comment responses unavailable; see diff)_"
      : "";

  const inResponseSection =
    triggeringComments.length > 0
      ? `\n**In response to:**\n${responseLines.join("\n")}${fallbackLine}\n`
      : "";

  // File paths rendered inside backtick code spans — no markdown escaping needed.
  const filesSection =
    handoff.filesChanged.length > 0
      ? `\n**Files changed:**\n${handoff.filesChanged.map((f) => `- \`${f}\``).join("\n")}\n`
      : "";

  const runLink = dashboardBaseUrl
    ? `[${run.id}](${dashboardBaseUrl}/runs/${run.id})`
    : run.id;
  const footer = `\n<sub>Run ${runLink} · auto-generated</sub>`;

  return `## 🤖 Addressed PR feedback\n\n${summary}\n${inResponseSection}${filesSection}${footer}`;
}

/**
 * Thin dispatcher called from runner.onPipelineComplete. Decides whether to
 * post the change summary, builds the input, calls renderChangeSummary, and
 * posts via addPRComment. Best-effort: any failure is logged at warn level
 * and the function returns (no throw).
 */
export interface MaybePostChangeSummaryDeps {
  run: {
    id: string;
    runType?: string | null;
    prUrl?: string | null;
    feedbackContext?: string | null;
    totalInputTokens: number;
    totalOutputTokens: number;
  };
  handoff: HandoffArtifact | null | undefined;
  prNumber: number | null;
  owner: string;
  repo: string;
  octokit: Parameters<typeof addPRComment>[0];
  postPRComment: typeof addPRComment;
  dashboardBaseUrl: string;
  logger: Pick<Logger, "info" | "warn" | "error">;
}

export async function maybePostChangeSummary(
  deps: MaybePostChangeSummaryDeps,
): Promise<void> {
  const {
    run,
    handoff,
    prNumber,
    owner,
    repo,
    octokit,
    postPRComment,
    dashboardBaseUrl,
    logger,
  } = deps;

  if (run.runType !== "review-feedback") return;

  if (!run.prUrl || prNumber === null) {
    logger.info(
      { runId: run.id },
      "skipped change summary: no PR URL on run",
    );
    return;
  }

  if (!handoff) {
    logger.info(
      { runId: run.id },
      "skipped change summary: no handoff persisted",
    );
    return;
  }

  let triggeringComments: ReviewFeedbackComment[] = [];
  if (run.feedbackContext) {
    try {
      const parsed = JSON.parse(run.feedbackContext) as unknown;
      if (Array.isArray(parsed)) triggeringComments = parsed as ReviewFeedbackComment[];
    } catch (err) {
      logger.error(
        {
          runId: run.id,
          err: err instanceof Error ? err.message : String(err),
        },
        "failed to parse feedback_context — posting degraded change summary",
      );
    }
  }

  let body: string;
  try {
    body = renderChangeSummary({
      handoff,
      run: {
        id: run.id,
        totalInputTokens: run.totalInputTokens,
        totalOutputTokens: run.totalOutputTokens,
      },
      triggeringComments,
      dashboardBaseUrl,
      prUrl: run.prUrl,
    });
  } catch (err) {
    logger.error(
      { runId: run.id, err: err instanceof Error ? err.message : String(err) },
      "failed to render change summary — skipping post",
    );
    return;
  }

  try {
    await postPRComment(octokit, owner, repo, prNumber, body);
    logger.info(
      { runId: run.id, prNumber },
      "posted PR change summary for review-feedback run",
    );
  } catch (err) {
    logger.warn(
      { runId: run.id, prNumber, err: err instanceof Error ? err.message : String(err) },
      "PR change summary post failed (non-fatal)",
    );
  }
}
