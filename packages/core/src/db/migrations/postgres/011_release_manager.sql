-- BEC-135: Release Manager agent — decision log + one-shot approvals.

CREATE TABLE IF NOT EXISTS release_decisions (
  id TEXT PRIMARY KEY,
  repo_url TEXT NOT NULL,
  branch TEXT NOT NULL,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decision TEXT NOT NULL,
  reason TEXT NOT NULL,
  trigger_state_json TEXT NOT NULL,
  proposed_version TEXT,
  fired_tag TEXT,
  fired_sha TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_release_decisions_repo_branch_decided
  ON release_decisions(repo_url, branch, decided_at DESC);

CREATE INDEX IF NOT EXISTS idx_release_decisions_decision_decided
  ON release_decisions(decision, decided_at);

CREATE TABLE IF NOT EXISTS release_approvals (
  id TEXT PRIMARY KEY,
  repo_url TEXT NOT NULL,
  branch TEXT NOT NULL,
  approved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_by TEXT NOT NULL,
  consumed_at TIMESTAMPTZ,
  consumed_by_decision_id TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_release_approvals_unique_fresh
  ON release_approvals(repo_url, branch, approved_by)
  WHERE consumed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_release_approvals_repo_branch_consumed
  ON release_approvals(repo_url, branch, consumed_at);
