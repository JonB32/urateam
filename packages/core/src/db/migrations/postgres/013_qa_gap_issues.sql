-- BEC-136: QA agent — Linear issue idempotency for missing QA workflows.

CREATE TABLE IF NOT EXISTS qa_gap_issues (
  id TEXT PRIMARY KEY,
  repo_url TEXT NOT NULL,
  branch TEXT NOT NULL,
  workflow_path TEXT NOT NULL,
  linear_issue_id TEXT NOT NULL,
  filed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_qa_gap_issues_unique_open
  ON qa_gap_issues(repo_url, branch, workflow_path)
  WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_qa_gap_issues_lookup
  ON qa_gap_issues(repo_url, branch, workflow_path, resolved_at);
