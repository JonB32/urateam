-- BEC-136: QA agent — track in-flight workflow runs on the release_decisions table.

ALTER TABLE release_decisions ADD COLUMN IF NOT EXISTS qa_run_id INTEGER;
ALTER TABLE release_decisions ADD COLUMN IF NOT EXISTS qa_run_sha TEXT;

CREATE INDEX IF NOT EXISTS idx_release_decisions_qa_run_id
  ON release_decisions(repo_url, branch, qa_run_id, decided_at DESC)
  WHERE qa_run_id IS NOT NULL;
