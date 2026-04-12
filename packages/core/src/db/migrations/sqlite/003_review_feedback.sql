-- Migration: BEC-84 - Add columns for review-feedback pipeline support
-- SQLite does not support IF NOT EXISTS on ALTER TABLE.
-- The migration runner catches duplicate-column errors to ensure idempotency.

ALTER TABLE pipeline_runs ADD COLUMN run_type TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE pipeline_runs ADD COLUMN parent_run_id TEXT;
ALTER TABLE pipeline_runs ADD COLUMN feedback_context TEXT;
