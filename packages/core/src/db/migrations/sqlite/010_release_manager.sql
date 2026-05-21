-- BEC-135: Release Manager agent — decision log + one-shot approvals.

CREATE TABLE IF NOT EXISTS release_decisions (
  id TEXT PRIMARY KEY,
  repo_url TEXT NOT NULL,
  branch TEXT NOT NULL,
  decided_at INTEGER NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT NOT NULL,
  trigger_state_json TEXT NOT NULL,
  proposed_version TEXT,
  fired_tag TEXT,
  fired_sha TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0
);

-- Index for /release status: fast lookup of the most recent N decisions per (repo, branch).
CREATE INDEX IF NOT EXISTS idx_release_decisions_repo_branch_decided
  ON release_decisions(repo_url, branch, decided_at DESC);

-- Index for retry sweep: find fire-pending rows.
CREATE INDEX IF NOT EXISTS idx_release_decisions_decision_decided
  ON release_decisions(decision, decided_at);

CREATE TABLE IF NOT EXISTS release_approvals (
  id TEXT PRIMARY KEY,
  repo_url TEXT NOT NULL,
  branch TEXT NOT NULL,
  approved_at INTEGER NOT NULL,
  approved_by TEXT NOT NULL,
  consumed_at INTEGER,
  consumed_by_decision_id TEXT
);

-- Partial UNIQUE: one fresh (un-consumed) approval per (repo, branch, user).
-- Once consumed, the row stays for audit but no longer blocks new approves.
CREATE UNIQUE INDEX IF NOT EXISTS idx_release_approvals_unique_fresh
  ON release_approvals(repo_url, branch, approved_by)
  WHERE consumed_at IS NULL;

-- Lookup index for fresh-approval check at decision time.
CREATE INDEX IF NOT EXISTS idx_release_approvals_repo_branch_consumed
  ON release_approvals(repo_url, branch, consumed_at);
