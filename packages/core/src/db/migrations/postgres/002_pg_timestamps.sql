-- Migration: Convert INTEGER epoch-second timestamp columns to TIMESTAMPTZ
--
-- Only needed for PostgreSQL deployments that were initially created with the
-- legacy INTEGER timestamp schema. Safe to run on fresh installations (no-op).
--
-- Idempotent: each ALTER is guarded by a data_type check.
--
-- NOTE: Must DROP DEFAULT before ALTER TYPE because Postgres cannot auto-cast
-- an integer default expression to timestamptz.

DO $$
BEGIN
  -- pipeline_runs.started_at
  IF (SELECT data_type FROM information_schema.columns
      WHERE table_name = 'pipeline_runs' AND column_name = 'started_at') = 'integer' THEN
    ALTER TABLE pipeline_runs ALTER COLUMN started_at DROP DEFAULT;
    ALTER TABLE pipeline_runs ALTER COLUMN started_at TYPE TIMESTAMPTZ USING to_timestamp(started_at);
    ALTER TABLE pipeline_runs ALTER COLUMN started_at SET DEFAULT now();
  END IF;

  -- pipeline_runs.completed_at
  IF (SELECT data_type FROM information_schema.columns
      WHERE table_name = 'pipeline_runs' AND column_name = 'completed_at') = 'integer' THEN
    ALTER TABLE pipeline_runs ALTER COLUMN completed_at TYPE TIMESTAMPTZ USING to_timestamp(completed_at);
  END IF;

  -- stage_runs.started_at
  IF (SELECT data_type FROM information_schema.columns
      WHERE table_name = 'stage_runs' AND column_name = 'started_at') = 'integer' THEN
    ALTER TABLE stage_runs ALTER COLUMN started_at DROP DEFAULT;
    ALTER TABLE stage_runs ALTER COLUMN started_at TYPE TIMESTAMPTZ USING to_timestamp(started_at);
    ALTER TABLE stage_runs ALTER COLUMN started_at SET DEFAULT now();
  END IF;

  -- stage_runs.completed_at
  IF (SELECT data_type FROM information_schema.columns
      WHERE table_name = 'stage_runs' AND column_name = 'completed_at') = 'integer' THEN
    ALTER TABLE stage_runs ALTER COLUMN completed_at TYPE TIMESTAMPTZ USING to_timestamp(completed_at);
  END IF;

  -- agent_logs.timestamp
  IF (SELECT data_type FROM information_schema.columns
      WHERE table_name = 'agent_logs' AND column_name = 'timestamp') = 'integer' THEN
    ALTER TABLE agent_logs ALTER COLUMN timestamp DROP DEFAULT;
    ALTER TABLE agent_logs ALTER COLUMN timestamp TYPE TIMESTAMPTZ USING to_timestamp(timestamp);
    ALTER TABLE agent_logs ALTER COLUMN timestamp SET DEFAULT now();
  END IF;

  -- pm_approvals.created_at
  IF (SELECT data_type FROM information_schema.columns
      WHERE table_name = 'pm_approvals' AND column_name = 'created_at') = 'integer' THEN
    ALTER TABLE pm_approvals ALTER COLUMN created_at DROP DEFAULT;
    ALTER TABLE pm_approvals ALTER COLUMN created_at TYPE TIMESTAMPTZ USING to_timestamp(created_at);
    ALTER TABLE pm_approvals ALTER COLUMN created_at SET DEFAULT now();
  END IF;

  -- pm_approvals.resolved_at (nullable, no default)
  IF (SELECT data_type FROM information_schema.columns
      WHERE table_name = 'pm_approvals' AND column_name = 'resolved_at') = 'integer' THEN
    ALTER TABLE pm_approvals ALTER COLUMN resolved_at TYPE TIMESTAMPTZ USING to_timestamp(resolved_at);
  END IF;

  -- active_work.started_at
  IF (SELECT data_type FROM information_schema.columns
      WHERE table_name = 'active_work' AND column_name = 'started_at') = 'integer' THEN
    ALTER TABLE active_work ALTER COLUMN started_at DROP DEFAULT;
    ALTER TABLE active_work ALTER COLUMN started_at TYPE TIMESTAMPTZ USING to_timestamp(started_at);
    ALTER TABLE active_work ALTER COLUMN started_at SET DEFAULT now();
  END IF;

  -- active_work.updated_at
  IF (SELECT data_type FROM information_schema.columns
      WHERE table_name = 'active_work' AND column_name = 'updated_at') = 'integer' THEN
    ALTER TABLE active_work ALTER COLUMN updated_at DROP DEFAULT;
    ALTER TABLE active_work ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING to_timestamp(updated_at);
    ALTER TABLE active_work ALTER COLUMN updated_at SET DEFAULT now();
  END IF;
END $$;
