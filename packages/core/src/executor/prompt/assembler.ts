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
  (issue: SanitizedIssue, repo: RepoConfig, handoff?: HandoffArtifact) => string
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
 * @throws if `stage` is "await-approval" or an unknown stage.
 */
export function assemblePrompt(
  stage: StageType,
  sanitizedIssue: SanitizedIssue,
  repoConfig: RepoConfig,
  handoff?: HandoffArtifact,
  reviewFeedback?: ReviewFeedbackContext,
  mergeConflict?: MergeConflictContext,
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
    );
  }

  const templateFn = TEMPLATE_MAP[stage];
  if (!templateFn) {
    throw new Error(`Unknown stage: ${stage}`);
  }

  return templateFn(sanitizedIssue, repoConfig, handoff);
}
