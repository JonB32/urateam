-- Enterprise feature 4.5: cost rollups
CREATE TABLE IF NOT EXISTS cost_rollups_daily (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  pipeline_key TEXT NOT NULL,
  linear_team_id TEXT,
  repo_url TEXT NOT NULL,
  runs INTEGER NOT NULL DEFAULT 0,
  prs_merged INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  dollars DOUBLE PRECISION NOT NULL DEFAULT 0,
  time_saved_hours DOUBLE PRECISION NOT NULL DEFAULT 0,
  computed_at TIMESTAMPTZ NOT NULL,
  UNIQUE (date, pipeline_key, linear_team_id, repo_url)
);

CREATE INDEX IF NOT EXISTS idx_cost_rollups_date ON cost_rollups_daily(date);
CREATE INDEX IF NOT EXISTS idx_cost_rollups_date_pipeline ON cost_rollups_daily(date, pipeline_key);
