import { randomUUID } from "node:crypto";
import { eq, and, isNull } from "drizzle-orm";
import type { LinearClient } from "@linear/sdk";
import type { AnyDb } from "../db/client.js";
import { qaGapIssues } from "../db/schema.js";
import { logAuditEventUnchecked } from "../audit/writer.js";
import { qaGapIssueFiledEvent } from "../audit/events.js";
import { createLogger } from "../logger.js";

const log = createLogger({ component: "Qa:gap" });

export interface FileGapIssueInput {
  db: AnyDb;
  linear: LinearClient;
  repoUrl: string;
  branch: string;
  workflowPath: string;
  linearTeamId: string;
}

export type FileGapIssueResult =
  | { kind: "filed"; linearIssueId: string }
  | { kind: "already_filed"; linearIssueId: string }
  | { kind: "linear_error"; message: string };

const ISSUE_TITLE_PREFIX = "QA workflow missing";
const ISSUE_BODY_TEMPLATE = `# QA workflow missing

The Release Manager attempted to verify a QA workflow for this branch but could not find the configured file.

**Repo:** {repoUrl}
**Branch:** {branch}
**Expected workflow path:** \`{workflowPath}\`

## What this means

When the Release Manager fires a release on this branch, it expects a GitHub Actions workflow at the path above to verify the merge commit before tagging. The file is currently missing, so the agent has paused all release activity for this branch until you add it.

## How to resolve

1. Add a workflow file at \`{workflowPath}\` that:
   - Has \`on: workflow_dispatch\` (so the Release Manager can trigger it)
   - Runs your smoke / integration tests against the merge commit
   - Exits zero on success and non-zero on failure

2. Commit and push the workflow file. The Release Manager will detect it on the next tick and resume normal release decisions.

3. Once the workflow has run green at least once, this Linear issue can be closed manually.

## Reference

The Release Manager and QA agent are documented at \`docs/superpowers/specs/2026-05-04-bec-136-qa-agent-design.md\` in the urateam repo. v1 only supports rule-based detection (file exists / file missing) — there is no automatic test scaffolding in v1.

🤖 Filed by urateam Release Manager (BEC-136).`;

export async function fileGapIssue(input: FileGapIssueInput): Promise<FileGapIssueResult> {
  const { db, linear, repoUrl, branch, workflowPath, linearTeamId } = input;

  // Idempotency check: is there already an open gap row for this (repo, branch, workflow)?
  const existing = await (db as any)
    .select({ linearIssueId: qaGapIssues.linearIssueId })
    .from(qaGapIssues)
    .where(
      and(
        eq(qaGapIssues.repoUrl, repoUrl),
        eq(qaGapIssues.branch, branch),
        eq(qaGapIssues.workflowPath, workflowPath),
        isNull(qaGapIssues.resolvedAt),
      ),
    )
    .limit(1);
  if (existing?.[0]?.linearIssueId) {
    return { kind: "already_filed", linearIssueId: existing[0].linearIssueId };
  }

  // No open row — file a new Linear issue.
  let identifier: string;
  try {
    const body = ISSUE_BODY_TEMPLATE
      .replace("{repoUrl}", repoUrl)
      .replace(/{branch}/g, branch)
      .replace(/{workflowPath}/g, workflowPath);
    const created = await linear.createIssue({
      teamId: linearTeamId,
      title: `${ISSUE_TITLE_PREFIX} for ${repoUrl} (${branch})`,
      description: body,
    });
    const issue = await (created as any).issue;
    identifier = issue?.identifier ?? "";
    if (!identifier) {
      return { kind: "linear_error", message: "Linear createIssue returned no identifier" };
    }
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    log.error({ err, repoUrl, branch, workflowPath }, "Linear createIssue failed");
    return { kind: "linear_error", message: msg };
  }

  // Persist the qa_gap_issues row to enforce idempotency.
  await (db as any).insert(qaGapIssues).values({
    id: `qg_${randomUUID()}`,
    repoUrl,
    branch,
    workflowPath,
    linearIssueId: identifier,
    filedAt: new Date(),
  });

  void logAuditEventUnchecked(
    db,
    qaGapIssueFiledEvent({ repoUrl, branch, workflowPath, linearIssueId: identifier }),
  );

  return { kind: "filed", linearIssueId: identifier };
}

/** Mark the open gap-issue row as resolved (called when the workflow file appears). */
export async function markGapResolved(input: {
  db: AnyDb;
  repoUrl: string;
  branch: string;
  workflowPath: string;
}): Promise<void> {
  const { db, repoUrl, branch, workflowPath } = input;
  await (db as any)
    .update(qaGapIssues)
    .set({ resolvedAt: new Date() })
    .where(
      and(
        eq(qaGapIssues.repoUrl, repoUrl),
        eq(qaGapIssues.branch, branch),
        eq(qaGapIssues.workflowPath, workflowPath),
        isNull(qaGapIssues.resolvedAt),
      ),
    );
}
