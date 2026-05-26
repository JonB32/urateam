-- 013_stage_runs_cache_tokens.sql
-- BEC: cache telemetry — capture prompt-cache token usage from the
-- Anthropic Agent SDK so we can measure hit-rate per stage.

ALTER TABLE stage_runs ADD COLUMN cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE stage_runs ADD COLUMN cache_read_input_tokens INTEGER NOT NULL DEFAULT 0;
