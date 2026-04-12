import type {
  SanitizedIssue,
  RepoConfig,
  HandoffArtifact,
  StageType,
  ReviewFeedbackContext,
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
 * @throws if `stage` is "await-approval" or an unknown stage.
 */
export function assemblePrompt(
  stage: StageType,
  sanitizedIssue: SanitizedIssue,
  repoConfig: RepoConfig,
  handoff?: HandoffArtifact,
  reviewFeedback?: ReviewFeedbackContext,
): string {
  if (stage === "await-approval") {
    throw new Error(
      "await-approval is not an agent stage — no prompt needed",
    );
  }

  if (stage === "implement") {
    return implementTemplate(sanitizedIssue, repoConfig, handoff, reviewFeedback);
  }

  const templateFn = TEMPLATE_MAP[stage];
  if (!templateFn) {
    throw new Error(`Unknown stage: ${stage}`);
  }

  return templateFn(sanitizedIssue, repoConfig, handoff);
}
