-- Migration: BEC-84 - Add columns for review-feedback pipeline support
-- Idempotent: each column addition is guarded by information_schema check.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_name = 'pipeline_runs' AND column_name = 'run_type') THEN
    ALTER TABLE pipeline_runs ADD COLUMN run_type TEXT NOT NULL DEFAULT 'standard';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_name = 'pipeline_runs' AND column_name = 'parent_run_id') THEN
    ALTER TABLE pipeline_runs ADD COLUMN parent_run_id TEXT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_name = 'pipeline_runs' AND column_name = 'feedback_context') THEN
    ALTER TABLE pipeline_runs ADD COLUMN feedback_context TEXT;
  END IF;
END $$;
