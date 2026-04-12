-- Migration: BEC-95 - Add auto-merge audit log columns
-- Idempotent: each column addition is guarded by information_schema check.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_name = 'pipeline_runs' AND column_name = 'auto_merged') THEN
    ALTER TABLE pipeline_runs ADD COLUMN auto_merged BOOLEAN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_name = 'pipeline_runs' AND column_name = 'auto_merge_reason') THEN
    ALTER TABLE pipeline_runs ADD COLUMN auto_merge_reason TEXT;
  END IF;
END $$;
