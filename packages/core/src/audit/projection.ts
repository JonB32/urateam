import type { AuditEvent, AuditActorType } from "../types.js";

// Row types left loose-typed because drizzle-infer varies by driver;
// projection consumers pass through `select().from(table)` results.
type PipelineRunRow = {
  id: string; issueId: string; status: string;
  startedAt: Date; completedAt: Date | null;
  totalInputTokens: number; totalOutputTokens: number;
  runType: string; parentRunId: string | null;
  linearTeamId: string | null; repoUrl: string;
  autoMerged: boolean | null; autoMergeReason: string | null;
  errorMessage: string | null;
};

function scopeForRun(row: PipelineRunRow): string | null {
  if (row.linearTeamId) return `team:${row.linearTeamId}`;
  return `repo:${row.repoUrl}`;
}

function actorForRun(row: PipelineRunRow): { actor: string; actorType: AuditActorType } {
  if (row.runType === "review-feedback") return { actor: "github-webhook", actorType: "webhook" };
  if (row.parentRunId) return { actor: "pm-agent", actorType: "pm-agent" };
  return { actor: "linear-webhook", actorType: "webhook" };
}

export function projectPipelineRun(row: PipelineRunRow): AuditEvent[] {
  const events: AuditEvent[] = [];
  const { actor, actorType } = actorForRun(row);
  const scope = scopeForRun(row);

  events.push({
    id: `proj_run_started_${row.id}`,
    timestamp: row.startedAt,
    eventType: "run.started",
    actor, actorType, scope,
    runId: row.id, issueId: row.issueId,
    inputTokens: 0, outputTokens: 0,
    payload: { runType: row.runType, repoUrl: row.repoUrl },
  });

  if (row.completedAt && row.status === "completed") {
    events.push({
      id: `proj_run_completed_${row.id}`,
      timestamp: row.completedAt,
      eventType: "run.completed",
      actor, actorType, scope,
      runId: row.id, issueId: row.issueId,
      inputTokens: row.totalInputTokens,
      outputTokens: row.totalOutputTokens,
      payload: {},
    });
  }

  if (row.completedAt && (row.status === "failed" || row.status === "retriable")) {
    events.push({
      id: `proj_run_failed_${row.id}`,
      timestamp: row.completedAt,
      eventType: "run.failed",
      actor, actorType, scope,
      runId: row.id, issueId: row.issueId,
      inputTokens: row.totalInputTokens,
      outputTokens: row.totalOutputTokens,
      payload: { errorMessage: row.errorMessage, status: row.status },
    });
  }

  if (row.autoMerged === true) {
    events.push({
      id: `proj_run_auto_merged_${row.id}`,
      timestamp: row.completedAt ?? row.startedAt,
      eventType: "run.auto_merged",
      actor, actorType, scope,
      runId: row.id, issueId: row.issueId,
      inputTokens: 0, outputTokens: 0,
      payload: { reason: row.autoMergeReason },
    });
  } else if (row.autoMerged === false && row.autoMergeReason) {
    events.push({
      id: `proj_run_auto_merge_skipped_${row.id}`,
      timestamp: row.completedAt ?? row.startedAt,
      eventType: "run.auto_merge_skipped",
      actor, actorType, scope,
      runId: row.id, issueId: row.issueId,
      inputTokens: 0, outputTokens: 0,
      payload: { reason: row.autoMergeReason },
    });
  }

  return events;
}

type PmApprovalRow = {
  id: string; issueId: string; action: string; reason: string;
  status: string; createdAt: Date; resolvedAt: Date | null;
};

export function projectPmApproval(row: PmApprovalRow): AuditEvent[] {
  const events: AuditEvent[] = [{
    id: `proj_approval_requested_${row.id}`,
    timestamp: row.createdAt,
    eventType: "pm.approval_requested",
    actor: "pm-agent", actorType: "pm-agent",
    scope: null, runId: null, issueId: row.issueId,
    inputTokens: 0, outputTokens: 0,
    payload: { approvalId: row.id, action: row.action, reason: row.reason },
  }];
  if (row.resolvedAt) {
    events.push({
      id: `proj_approval_resolved_${row.id}`,
      timestamp: row.resolvedAt,
      eventType: "pm.approval_resolved",
      actor: "pm-agent", actorType: "pm-agent",
      scope: null, runId: null, issueId: row.issueId,
      inputTokens: 0, outputTokens: 0,
      payload: { approvalId: row.id, action: row.action, status: row.status },
    });
  }
  return events;
}

type BudgetAlertRow = {
  id: string; date: string; scope: string; threshold: number; firedAt: Date;
};

export function projectBudgetAlert(row: BudgetAlertRow): AuditEvent {
  return {
    id: `proj_budget_alert_${row.id}`,
    timestamp: row.firedAt,
    eventType: "budget.alert_fired",
    actor: "pm-agent", actorType: "pm-agent",
    scope: row.scope,
    runId: null, issueId: null,
    inputTokens: 0, outputTokens: 0,
    payload: { threshold: row.threshold, date: row.date },
  };
}
