-- Migration: Initial schema
-- Creates all base tables and indices for SQLite.
-- Idempotent: all statements use IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS pipeline_runs (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL,
  issue_title TEXT NOT NULL,
  pipeline_key TEXT NOT NULL,
  repo_url TEXT NOT NULL,
  branch TEXT,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL DEFAULT (unixepoch()),
  completed_at INTEGER,
  pr_url TEXT,
  total_input_tokens INTEGER NOT NULL DEFAULT 0,
  total_output_tokens INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  current_stage_index INTEGER,
  resume_payload TEXT
);

CREATE TABLE IF NOT EXISTS stage_runs (
  id TEXT PRIMARY KEY,
  pipeline_run_id TEXT NOT NULL REFERENCES pipeline_runs(id),
  stage TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL DEFAULT (unixepoch()),
  completed_at INTEGER,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  turns INTEGER NOT NULL DEFAULT 0,
  handoff_artifact TEXT,
  error_message TEXT
);

CREATE TABLE IF NOT EXISTS agent_logs (
  id TEXT PRIMARY KEY,
  stage_run_id TEXT NOT NULL REFERENCES stage_runs(id),
  timestamp INTEGER NOT NULL DEFAULT (unixepoch()),
  type TEXT NOT NULL,
  content TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_stage_runs_pipeline_run_id ON stage_runs(pipeline_run_id);
CREATE INDEX IF NOT EXISTS idx_agent_logs_stage_run_id ON agent_logs(stage_run_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_issue_id ON pipeline_runs(issue_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_status ON pipeline_runs(status);

CREATE TABLE IF NOT EXISTS pm_approvals (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT NOT NULL,
  slack_message_ts TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  resolved_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_pm_approvals_status ON pm_approvals(status);

CREATE TABLE IF NOT EXISTS active_work (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE,
  issue_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  files_modified TEXT,
  started_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_active_work_issue_id ON active_work(issue_id);

CREATE TABLE IF NOT EXISTS webhook_dedup (
  id TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
