-- Migration: BEC-87 - Add retry_count column for transient failure recovery
-- SQLite does not support IF NOT EXISTS on ALTER TABLE.
-- The migration runner catches duplicate-column errors to ensure idempotency.

ALTER TABLE pipeline_runs ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;
