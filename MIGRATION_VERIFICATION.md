# Migration Prefix Fix Verification

This document describes the verification script for BEC-149, which resolves duplicate migration prefixes in the urateam database migration system.

## Problem Statement (BEC-149)

The migration files had duplicate numeric prefixes due to incomplete renumbering:

**SQLite Migrations Before Fix:**
- `007_sso.sql` (new) and `007_cost_rollups.sql` (old) — **DUPLICATE**
- `008_review_model_runs.sql` (new) and `008_sso.sql` (renamed from old 007)
- `009_release_manager.sql` (new) and `009_review_model_runs.sql` (renamed from old 008)
- ... and so on

**Root Cause:** The new migrations were created with sequential numbering (007, 008, 009...) without first renumbering the old files that had been partially renamed in prior PRs.

## Solution (BEC-149)

The fix involves three components:

### 1. File Renaming
Renamed old migration files to avoid conflicts:

**SQLite:**
- `007_sso.sql` → `008_sso.sql`
- `008_review_model_runs.sql` → `009_review_model_runs.sql`
- `009_release_manager.sql` → `010_release_manager.sql`
- `010_qa_run_columns.sql` → `011_qa_run_columns.sql`
- `011_qa_gap_issues.sql` → `012_qa_gap_issues.sql`

**Postgres:**
- `008_sso.sql` → `009_sso.sql`
- `009_review_model_runs.sql` → `010_review_model_runs.sql`
- `010_release_manager.sql` → `011_release_manager.sql`
- `011_qa_run_columns.sql` → `012_qa_run_columns.sql`
- `012_qa_gap_issues.sql` → `013_qa_gap_issues.sql`

### 2. Deprecated File Stubs
Old files (with original names) are kept as stubs for git history. The `loadMigrationFiles()` function excludes them from processing.

### 3. Migration Tracking Rename
The `runMigrationsSqlite()` and `runMigrationsPostgres()` functions update existing deployment records:

```
UPDATE schema_migrations SET name = 'new_name' WHERE name = 'old_name'
```

This ensures:
- Old deployments with `007_sso` in their tracking table are updated to `008_sso`
- No duplicate migrations are re-run
- New deployments load only the final, deduplicated set

## Verification Script

### Scripts Available

**Option 1: TypeScript Source Analysis (Recommended)**
```bash
node verify-migration-fix-ts.mjs
```
Works directly with TypeScript source files without requiring a build step.

**Option 2: Compiled JavaScript**
```bash
node verify-migration-fix.mjs
```
Works after `pnpm build` is run (requires built dist/ files).

### What the Script Verifies

#### 1. Rename Maps Validation
- Extracts `SQLITE_MIGRATION_RENAMES` and `POSTGRES_MIGRATION_RENAMES` from source
- Verifies both maps are non-empty and properly formatted
- Displays all old → new mappings

#### 2. SQLite Migration Loading
- Loads all migration files from `packages/core/src/db/migrations/sqlite/`
- Verifies deprecated files (old names) are excluded
- Checks:
  - No null values in loaded migrations
  - All migrations have numeric prefixes (NNN_name format)
  - All numeric prefixes are **unique** (no duplicates)
  - Prefixes are in range 1-12
- Lists all loaded migrations with their numeric prefixes

#### 3. Postgres Migration Loading
- Same checks as SQLite, but for Postgres migrations
- Verifies prefixes are in range 1-13 (Postgres has one extra migration: `002_pg_timestamps`)

#### 4. Migration Rename Compatibility Test
- Creates a temporary SQLite database
- Inserts old migration names into `schema_migrations` table
- Applies the rename logic (simulating `runMigrationsSqlite()`)
- Verifies:
  - All old names are successfully renamed
  - No old names remain in the table
  - All expected new names are present

### Expected Output

```
╔════════════════════════════════════════════════════════════╗
║     MIGRATION PREFIX FIX VERIFICATION (BEC-149)            ║
╚════════════════════════════════════════════════════════════╝

============================================================
VERIFYING RENAME MAPS
============================================================

SQLite Renames (5 entries):
  007_sso → 008_sso
  008_review_model_runs → 009_review_model_runs
  009_release_manager → 010_release_manager
  010_qa_run_columns → 011_qa_run_columns
  011_qa_gap_issues → 012_qa_gap_issues

Postgres Renames (5 entries):
  008_sso → 009_sso
  009_review_model_runs → 010_review_model_runs
  010_release_manager → 011_release_manager
  011_qa_run_columns → 012_qa_run_columns
  012_qa_gap_issues → 013_qa_gap_issues

============================================================
VERIFYING SQLITE MIGRATIONS
============================================================

✓ Loaded 12 migrations
✓ No null values in migrations
✓ All migrations have numeric prefixes
✓ All 12 numeric prefixes are unique

Migrations (sqlite):
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

Prefix range: 1-12 (expected: 1-12)

============================================================
VERIFYING POSTGRES MIGRATIONS
============================================================

✓ Loaded 13 migrations
✓ No null values in migrations
✓ All migrations have numeric prefixes
✓ All 13 numeric prefixes are unique

Migrations (postgres):
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

Prefix range: 1-13 (expected: 1-13)

============================================================
TESTING MIGRATION RENAME COMPATIBILITY
============================================================

Creating test database at /tmp/urateam-migration-test-.../test.db

Inserting old migration names:
  - 007_sso
  - 008_review_model_runs
  - 009_release_manager
  - 010_qa_run_columns
  - 011_qa_gap_issues

Before rename compatibility fix: 5 rows
  - 007_sso
  - 008_review_model_runs
  - 009_release_manager
  - 010_qa_run_columns
  - 011_qa_gap_issues

Applying migration rename mapping:
  ✓ 007_sso → 008_sso
  ✓ 008_review_model_runs → 009_review_model_runs
  ✓ 009_release_manager → 010_release_manager
  ✓ 010_qa_run_columns → 011_qa_run_columns
  ✓ 011_qa_gap_issues → 012_qa_gap_issues

After rename compatibility fix: 5 rows
  - 008_sso
  - 009_review_model_runs
  - 010_release_manager
  - 011_qa_run_columns
  - 012_qa_gap_issues

✓ Migration rename compatibility test PASSED

Cleaned up test database

============================================================
FINAL RESULTS
============================================================

Rename maps validation:   ✓ PASS
SQLite migrations:        ✓ PASS
Postgres migrations:      ✓ PASS
Migration rename test:    ✓ PASS

✓ Overall: ALL TESTS PASSED
```

### Exit Codes

- `0` - All tests passed
- `1` - One or more tests failed

## Technical Details

### File Locations

- **Migration files:** `packages/core/src/db/migrations/{sqlite,postgres}/*.sql`
- **Migrator code:** `packages/core/src/db/migrator.ts`
- **Rename maps:** Defined in `SQLITE_MIGRATION_RENAMES` and `POSTGRES_MIGRATION_RENAMES` constants

### How the Fix Works

1. **File System State**
   - Old files (e.g., `007_sso.sql`) remain as stubs for git history
   - New files have the correct names (e.g., `008_sso.sql`)

2. **loadMigrationFiles(driver)**
   - Reads the `schema_migrations` table via `UPDATE` queries
   - Filters out deprecated old names from the list
   - Returns only the deduplicated set

3. **runMigrationsSqlite(db) / runMigrationsPostgres(client)**
   - On startup, updates any existing tracking records
   - Maps old → new names so they align with current file names
   - Prevents re-running renamed migrations
   - Prevents duplicate migrations from running

### Idempotency Guarantees

- Running the rename logic twice is safe (UPDATE idempotent)
- If a migration was never recorded, it's not renamed
- If a migration was recorded and is being renamed, it updates atomically
- New deployments start with a clean slate (no old names to rename)

## Testing Integration

The verification script can be integrated into CI:

```bash
# In GitHub Actions / CI pipeline
- name: Verify Migration Fix
  run: node verify-migration-fix-ts.mjs
```

This ensures the BEC-149 fix remains correct across all deployments.

## Troubleshooting

### "Loaded 0 migrations"
- Check that `packages/core/src/db/migrations/` directory exists
- Ensure `.sql` files are present
- Verify file permissions

### "DUPLICATE PREFIXES FOUND"
- Old deprecated stub files weren't properly excluded
- Run `git status` to verify all files are in place
- Check `loadMigrationFiles()` filtering logic

### "Migration rename test FAILED"
- Verify `better-sqlite3` is installed
- Check temporary directory permissions
- Review the UPDATE SQL syntax

## References

- **Issue:** BEC-149 — Duplicate migration prefixes (007, 008, etc.)
- **Solution:** Renumber old migrations + exclude deprecated files + update tracking records
- **PR:** Includes file renames + code changes to `packages/core/src/db/migrator.ts`
- **Verification:** This script validates the entire solution

## Future Considerations

1. **Squashing Migrations:** As the codebase grows, old migrations can be squashed into a single schema DDL snapshot
2. **Migration Hooks:** Could add pre/post-migration hooks for custom logic
3. **Rollback Support:** Currently migrations are append-only; rollbacks would require new downtime migrations
4. **Deprecation Handling:** Deprecated file stubs could be removed after a deployment cycle
