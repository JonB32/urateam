import { z } from "zod";

export const QaCheckConfigSchema = z.object({
  /** Path to the workflow file in the repo (e.g., ".github/workflows/smoke.yml"). */
  workflow: z.string().min(1),
  /** Max time to wait for a single workflow run before reporting timed_out. Default 30. */
  timeoutMinutes: z.number().int().positive().default(30),
  /** Linear team UUID for filing gap issues. Required for the gap-issue path. */
  linearTeamId: z.string().min(1),
  /** Optional inputs passed to workflow_dispatch (e.g., { environment: "preview" }). */
  workflowInputs: z.record(z.string(), z.string()).optional(),
});
export type QaCheckConfig = z.infer<typeof QaCheckConfigSchema>;

/**
 * Result of evalQaCheck. Six kinds — more nuanced than the other triggers'
 * { pass, reason } because the async lifecycle requires the scheduler to
 * dispatch different actions per kind.
 */
export type QaTriggerResult =
  | { pass: true; reason: string }
  | { pass: false; reason: "qa_failed"; runId: number; conclusion: string }
  | { pass: false; reason: "qa_running"; runId: number }
  | { pass: false; reason: "qa_timed_out"; runId: number }
  | { pass: false; reason: "qa_needs_trigger" }
  | { pass: false; reason: "qa_no_workflow" };

/** Snapshot of the most-recent in-flight QA run for (repo, branch). Null when nothing in flight. */
export interface QaRunSnapshot {
  runId: number;
  runSha: string;
  /** When the run was triggered (decided_at on the persisting row). Used for timeout calculation. */
  triggeredAt: Date;
}
