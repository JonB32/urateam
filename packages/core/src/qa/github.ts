import type { Octokit } from "@octokit/rest";
import type { AnyDb } from "../db/client.js";
import { logAuditEventUnchecked } from "../audit/writer.js";
import { qaRunTriggeredEvent } from "../audit/events.js";
import { createLogger } from "../logger.js";

const log = createLogger({ component: "Qa:github" });

export interface WorkflowFileExistsInput {
  octokit: Octokit;
  owner: string;
  repo: string;
  path: string;
  ref: string;
}

/**
 * Returns true when the workflow file exists at the given ref, false on 404,
 * rethrows on other errors. The workflow file existence check uses the
 * contents API rather than the actions API because the actions API requires
 * the workflow to also be registered (i.e., GitHub must have parsed it on a
 * push event), which can lag behind the file appearing in the repo.
 */
export async function workflowFileExists(input: WorkflowFileExistsInput): Promise<boolean> {
  const { octokit, owner, repo, path, ref } = input;
  try {
    await octokit.repos.getContent({ owner, repo, path, ref });
    return true;
  } catch (err: any) {
    if (err?.status === 404) return false;
    throw err;
  }
}

export interface TriggerWorkflowInput {
  octokit: Octokit;
  db: AnyDb;
  owner: string;
  repo: string;
  repoUrl: string;
  branch: string;
  workflow: string;          // e.g. ".github/workflows/smoke.yml"
  ref: string;               // SHA to dispatch against
  inputs?: Record<string, string>;
}

export type TriggerWorkflowResult =
  | { kind: "ok"; runId: number }
  | { kind: "dispatch_404" }
  | { kind: "dispatch_422"; message: string }
  | { kind: "dispatch_error"; message: string }
  | { kind: "dispatch_pending"; message: string }; // GitHub eventual-consistency window

/**
 * Trigger a workflow_dispatch and find the resulting run.
 *
 * GitHub's workflow_dispatch API returns 204 No Content on success — it does
 * NOT return the run ID. To discover the run, we list runs for the workflow
 * filtered by SHA + workflow path and take the most-recent. There's a brief
 * eventual-consistency window (typically <5s) where the run may not appear yet;
 * the caller's tick will retry naturally on the next iteration.
 *
 * On dispatch failure, the result is classified into 3 kinds so the scheduler
 * can route appropriately:
 *   - dispatch_404: drop into the qa_no_workflow path (file gap issue)
 *   - dispatch_422: workflow exists but lacks `on: workflow_dispatch` — write skip
 *   - dispatch_error: 5xx / rate limit — retry on next tick (uses retry counter)
 *
 * Emits qa.run_triggered audit event on the "ok" path.
 */
export async function triggerWorkflow(
  input: TriggerWorkflowInput,
): Promise<TriggerWorkflowResult> {
  const { octokit, db, owner, repo, repoUrl, branch, workflow, ref, inputs } = input;

  try {
    await octokit.actions.createWorkflowDispatch({
      owner,
      repo,
      workflow_id: workflow,
      ref,
      ...(inputs ? { inputs } : {}),
    });
  } catch (err: any) {
    const status = err?.status;
    const msg = err?.message ?? String(err);
    if (status === 404) return { kind: "dispatch_404" };
    if (status === 422) return { kind: "dispatch_422", message: msg };
    return { kind: "dispatch_error", message: msg };
  }

  // Find the just-triggered run. List the most recent runs for this workflow
  // filtered by head SHA. Take the first match (most recent dispatch on this SHA).
  let runId: number | null = null;
  try {
    const list = await octokit.actions.listWorkflowRuns({
      owner,
      repo,
      workflow_id: workflow as any, // octokit accepts string filename
      head_sha: ref,
      per_page: 5,
    });
    const runs = (list as any).data?.workflow_runs ?? [];
    runId = runs[0]?.id ?? null;
  } catch (err) {
    log.warn({ err, workflow, ref }, "listWorkflowRuns failed after dispatch — run will be picked up next tick");
  }

  if (runId === null) {
    // Eventual-consistency window. Treat as needs-retry without burning the retry budget.
    return { kind: "dispatch_pending", message: "dispatch succeeded but run not found yet" };
  }

  void logAuditEventUnchecked(
    db,
    qaRunTriggeredEvent({ repoUrl, branch, workflow, runId, sha: ref }),
  );

  return { kind: "ok", runId };
}

export interface PollWorkflowRunInput {
  octokit: Octokit;
  owner: string;
  repo: string;
  runId: number;
}

export type PollWorkflowRunResult =
  | { kind: "running" }
  | { kind: "completed"; conclusion: string; durationMs: number; startedAt: Date };

export async function pollWorkflowRun(
  input: PollWorkflowRunInput,
): Promise<PollWorkflowRunResult> {
  const { octokit, owner, repo, runId } = input;
  const res = await octokit.actions.getWorkflowRun({ owner, repo, run_id: runId });
  const data = (res as any).data;
  const status: string = data?.status ?? "queued";
  const conclusion: string | null = data?.conclusion ?? null;

  if (status !== "completed") return { kind: "running" };

  // Completed run — compute duration from run_started_at to updated_at.
  const startedAtStr = data?.run_started_at ?? data?.created_at;
  const updatedAtStr = data?.updated_at ?? new Date().toISOString();
  const startedAt = startedAtStr ? new Date(startedAtStr) : new Date();
  const updatedAt = new Date(updatedAtStr);
  const durationMs = Math.max(0, updatedAt.getTime() - startedAt.getTime());

  return {
    kind: "completed",
    conclusion: conclusion ?? "neutral",
    durationMs,
    startedAt,
  };
}
