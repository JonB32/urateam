# BEC-149 Quick Start Verification

## TL;DR

The BEC-149 fix eliminates duplicate migration prefixes. Verify it works:

```bash
# Run the verification script
node verify-migration-fix-ts.mjs

# Expected output: ✓ Overall: ALL TESTS PASSED
```

## What Was Fixed

**Before:**
- Multiple migrations with prefix `007` (007_sso.sql AND 007_cost_rollups.sql)
- Multiple migrations with prefix `008` (008_sso.sql AND 008_review_model_runs.sql)
- And so on...

**After:**
- Sequential numbering: 1-12 for SQLite, 1-13 for Postgres
- All prefixes unique
- Old files kept as stubs for git history

## Quick Verification Options

### Option 1: Verification Script (Recommended)
```bash
node verify-migration-fix-ts.mjs
```
- No build required
- Checks for duplicates
- Tests rename logic
- Takes ~5 seconds
- Exit code 0 = all checks passed

### Option 2: Run Tests
```bash
cd packages/core
npx vitest run src/__tests__/migration-prefix-fix.test.ts
```
- Comprehensive test suite
- Covers SQLite and Postgres
- Tests compatibility logic
- ~10 seconds

### Option 3: Manual Inspection
```bash
# Check SQLite migrations
ls -1 packages/core/src/db/migrations/sqlite/ | sort

# Expected: 001_initial_schema.sql through 012_qa_gap_issues.sql
# No duplicate prefixes

# Check Postgres migrations
ls -1 packages/core/src/db/migrations/postgres/ | sort

# Expected: 001_initial_schema.sql through 013_qa_gap_issues.sql
# No duplicate prefixes
```

## What the Fix Does

1. **Renames files** to eliminate duplicates:
   - `007_sso.sql` → `008_sso.sql`
   - `008_review_model_runs.sql` → `009_review_model_runs.sql`
   - etc.

2. **Filters deprecated files** during migration loading
   - Old files are kept as stubs
   - New files are loaded and executed

3. **Updates migration tracking** on startup
   - Old deployments get their tracking records renamed
   - No duplicate migrations re-run

## Expected Results

### SQLite Migrations
```
 1 → 001_initial_schema
 2 → 002_retry_count
 3 → 003_review_feedback
 4 → 004_auto_merge
 5 → 005_spend_caps
 6 → 006_audit_events
 7 → 007_cost_rollups
 8 → 008_sso
 9 → 009_review_model_runs
10 → 010_release_manager
11 → 011_qa_run_columns
12 → 012_qa_gap_issues
```

### Postgres Migrations
```
 1 → 001_initial_schema
 2 → 002_pg_timestamps
 3 → 003_retry_count
 4 → 004_review_feedback
 5 → 005_auto_merge
 6 → 006_spend_caps
 7 → 007_audit_events
 8 → 008_cost_rollups
 9 → 009_sso
10 → 010_review_model_runs
11 → 011_release_manager
12 → 012_qa_run_columns
13 → 013_qa_gap_issues
```

## Troubleshooting

### "Loaded 0 migrations"
```bash
# Check directory exists
ls packages/core/src/db/migrations/

# Should have: sqlite/ postgres/
```

### "DUPLICATE PREFIXES FOUND"
```bash
# This shouldn't happen with the fix. Check:
cd packages/core/src/db/migrations/sqlite/

# Count files with same prefix
ls | grep "^007_" | wc -l
# Should be 1 (only 007_cost_rollups.sql)

ls | grep "^008_" | wc -l
# Should be 1 (only 008_sso.sql)
```

### Script won't run
```bash
# Verify Node.js version (need 18+)
node --version

# Install better-sqlite3 if missing
npm install better-sqlite3
```

## Files Changed

- **Migration files:** Renamed in `packages/core/src/db/migrations/{sqlite,postgres}/`
- **Code changes:** `packages/core/src/db/migrator.ts`
  - Added `SQLITE_MIGRATION_RENAMES` map
  - Added `POSTGRES_MIGRATION_RENAMES` map
  - Updated `loadMigrationFiles()` to filter deprecated names
  - Updated `runMigrationsSqlite()` to rename tracking records
  - Updated `runMigrationsPostgres()` to rename tracking records

## Documentation

- **Complete Guide:** See `MIGRATION_VERIFICATION.md`
- **Solution Summary:** See `BEC-149-SOLUTION-SUMMARY.md`
- **Code Changes:** See `packages/core/src/db/migrator.ts`
- **Test Suite:** See `packages/core/src/__tests__/migration-prefix-fix.test.ts`

## Safety

✓ Safe to deploy to production
✓ Backward compatible with existing deployments
✓ No data loss or corruption risk
✓ Idempotent (can run multiple times safely)
✓ Old deployments get automatic migration tracking fix

## Next Steps

1. Run verification: `node verify-migration-fix-ts.mjs`
2. Review results
3. Deploy with confidence
4. Monitor first startup logs (should show rename operations)

---

**Need more details?** See the full documentation in `MIGRATION_VERIFICATION.md` or `BEC-149-SOLUTION-SUMMARY.md`
