#!/bin/bash
# Script to commit test changes for BEC-187

echo "=== Preparing to commit test changes for BEC-187 ==="
echo ""
echo "Files to be committed:"
echo "  - packages/core/src/__tests__/db-migrations.test.ts (NEW - 11 test cases)"
echo ""
echo "Checking git status..."

git status --short

echo ""
echo "Running: git add packages/core/src/__tests__/db-migrations.test.ts"
git add packages/core/src/__tests__/db-migrations.test.ts

echo ""
echo "Creating commit with message..."
git commit -m "test(db): add migration tests for BEC-187 index creation

Add comprehensive test coverage for the 5 new database indexes:
- idx_pipeline_runs_pr_url (webhook PR-URL lookups)
- idx_pipeline_runs_branch (agent branch lookups)
- idx_pipeline_runs_started_at (PM tick range scans)
- idx_pipeline_runs_completed_at (active-run detection)
- idx_pm_approvals_issue_id (approval batch fetch)

Test cases cover:
- Migration file loading and sequencing
- Idempotent migration execution (can run multiple times)
- All 5 indexed columns with actual query patterns
- SQLite and Postgres parity

Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>"

echo ""
echo "=== Commit complete ==="
echo ""
echo "Final git status:"
git status --short
