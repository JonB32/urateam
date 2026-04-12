-- Migration: BEC-87 - Add retry_count column for transient failure recovery
-- Idempotent: guarded by information_schema check.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_name = 'pipeline_runs' AND column_name = 'retry_count') THEN
    ALTER TABLE pipeline_runs ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;
  END IF;
END $$;
