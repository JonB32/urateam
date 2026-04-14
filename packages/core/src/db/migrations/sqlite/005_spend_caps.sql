-- Spend caps & alerts (Phase 1, feature 4.3)
-- Adds linear_team_id to pipeline_runs for per-team budget scoping,
-- and creates budget_alerts for threshold-crossing dedup.

ALTER TABLE pipeline_runs ADD COLUMN linear_team_id TEXT;

CREATE TABLE IF NOT EXISTS budget_alerts (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  scope TEXT NOT NULL,
  threshold INTEGER NOT NULL,
  fired_at INTEGER NOT NULL,
  UNIQUE(date, scope, threshold)
);

CREATE INDEX IF NOT EXISTS idx_budget_alerts_date_scope ON budget_alerts(date, scope);
