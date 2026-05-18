-- BEC-136: QA agent — Linear issue idempotency for missing QA workflows.

CREATE TABLE IF NOT EXISTS qa_gap_issues (
  id TEXT PRIMARY KEY,
  repo_url TEXT NOT NULL,
  branch TEXT NOT NULL,
  workflow_path TEXT NOT NULL,
  linear_issue_id TEXT NOT NULL,
  filed_at INTEGER NOT NULL,
  resolved_at INTEGER
);

-- Partial UNIQUE: at most one open gap issue per (repo, branch, workflow) at a time.
-- Once resolved (resolved_at IS NOT NULL), the row is preserved for audit but a new
-- issue can be filed for the same gap in the future.
CREATE UNIQUE INDEX IF NOT EXISTS idx_qa_gap_issues_unique_open
  ON qa_gap_issues(repo_url, branch, workflow_path)
  WHERE resolved_at IS NULL;

-- Lookup index for "is there an open gap for this (repo, branch, workflow)?" — partial too.
CREATE INDEX IF NOT EXISTS idx_qa_gap_issues_lookup
  ON qa_gap_issues(repo_url, branch, workflow_path, resolved_at);
