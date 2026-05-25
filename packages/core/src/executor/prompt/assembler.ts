import type {
  SanitizedIssue,
  RepoConfig,
  HandoffArtifact,
  StageType,
  ReviewFeedbackContext,
  MergeConflictContext,
} from "../../types.js";
import {
  triageTemplate,
  reproduceTemplate,
  implementTemplate,
  testTemplate,
  reviewTemplate,
} from "./templates.js";

const TEMPLATE_MAP: Record<
  string,
  (
    issue: SanitizedIssue,
    repo: RepoConfig,
    handoff?: HandoffArtifact,
    opts?: { suppressHandoff?: boolean },
  ) => string
> = {
  triage: triageTemplate,
  reproduce: reproduceTemplate,
  test: testTemplate,
  review: reviewTemplate,
};

/**
 * Assemble the full prompt for a given pipeline stage.
 *
 * @param reviewFeedback - When provided and stage is "implement", constructs a
 *   focused prompt for addressing PR review comments rather than fresh implementation.
 * @param mergeConflict - When provided and stage is "implement", constructs a
 *   focused prompt for resolving rebase conflicts. Takes precedence over
 *   `reviewFeedback` since conflict resolution is a hard prerequisite.
 * @param opts.suppressHandoff - BEC-227: when `true`, omits the
 *   `<previous-stage-context>` block from the rendered prompt. The runner sets
 *   this on resumed RALPH re-implement iterations where the same handoff is
 *   already visible to the agent through the resumed SDK session's transcript.
 * @throws if `stage` is "await-approval" or an unknown stage.
 */
export function assemblePrompt(
  stage: StageType,
  sanitizedIssue: SanitizedIssue,
  repoConfig: RepoConfig,
  handoff?: HandoffArtifact,
  reviewFeedback?: ReviewFeedbackContext,
  mergeConflict?: MergeConflictContext,
  opts: { suppressHandoff?: boolean } = {},
): string {
  if (stage === "await-approval") {
    throw new Error(
      "await-approval is not an agent stage — no prompt needed",
    );
  }

  if (stage === "implement") {
    return implementTemplate(
      sanitizedIssue,
      repoConfig,
      handoff,
      reviewFeedback,
      mergeConflict,
      { suppressHandoff: opts.suppressHandoff },
    );
  }

  const templateFn = TEMPLATE_MAP[stage];
  if (!templateFn) {
    throw new Error(`Unknown stage: ${stage}`);
  }

  return templateFn(sanitizedIssue, repoConfig, handoff, {
    suppressHandoff: opts.suppressHandoff,
  });
}
