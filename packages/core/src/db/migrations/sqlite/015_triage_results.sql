-- 013_triage_results.sql
-- BEC-223: persist triage v2 prediction at triage time so the runner Tier 6e
-- hook reads from DB instead of parsing the description (which gets truncated
-- by mapIssueToSchema at 4000 chars, slicing off the appended v2 sections for
-- realistic issues).

CREATE TABLE IF NOT EXISTS triage_results (
  issue_id TEXT PRIMARY KEY,
  v2_prediction TEXT NOT NULL DEFAULT '{}',
  triaged_at INTEGER NOT NULL DEFAULT (unixepoch())
);
