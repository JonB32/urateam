-- Migration: BEC-187 — Add 5 missing hot-path indexes to pipeline_runs + pm_approvals
-- Idempotent: all statements use CREATE INDEX IF NOT EXISTS (supported since Postgres 9.5).

-- pipeline_runs.pr_url: queried on every check_suite, pull_request, and review
-- event in webhook/github-handler.ts to look up the run by PR URL.
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_pr_url
  ON pipeline_runs(pr_url);

-- pipeline_runs.branch: queried alongside pr_url in webhook/github-handler.ts
-- to find runs by branch name on push/CI events.
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_branch
  ON pipeline_runs(branch);

-- pipeline_runs.started_at: range-scanned by pm/actions/db-queries.ts,
-- pm/budget.ts, audit/reader.ts, cost/csv.ts, and runner.ts on every PM tick
-- (60s cadence) and dashboard page load.
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_started_at
  ON pipeline_runs(started_at);

-- pipeline_runs.completed_at: range-scanned by pm/actions/db-queries.ts and
-- cost/aggregate.ts for active-run detection and cost rollup windows.
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_completed_at
  ON pipeline_runs(completed_at);

-- pm_approvals.issue_id: queried by approval-helpers.ts:batchFetchPendingApprovals
-- on every PM tick to find pending approvals for a batch of issue IDs.
CREATE INDEX IF NOT EXISTS idx_pm_approvals_issue_id
  ON pm_approvals(issue_id);
