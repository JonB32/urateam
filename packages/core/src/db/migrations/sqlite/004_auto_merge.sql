-- Migration: BEC-95 - Add auto-merge audit log columns
-- SQLite does not support IF NOT EXISTS on ALTER TABLE.
-- The migration runner catches duplicate-column errors to ensure idempotency.

ALTER TABLE pipeline_runs ADD COLUMN auto_merged INTEGER;
ALTER TABLE pipeline_runs ADD COLUMN auto_merge_reason TEXT;
