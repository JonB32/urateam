# BEC-149: Migration Prefix Fix

> Fix for duplicate migration prefixes in the urateam database migration system.

## The Issue

The database migration system had files with duplicate numeric prefixes (007, 008, 009, etc.), causing:
- Risk of duplicate migrations being executed
- Potential data corruption on re-runs
- Inconsistent database schema across deployments

## The Solution

Three complementary components:

1. **File Renaming:** Old files renamed to sequential numbers (007 → 008, 008 → 009, etc.)
2. **Code Updates:** Added filtering and rename maps to migrator.ts
3. **Migration Tracking:** Existing deployments get automatic rename on startup

## Quick Start

### Verify the Fix Works

```bash
node verify-migration-fix-ts.mjs
```

Expected output:
```
✓ Overall: ALL TESTS PASSED
```

Exit code 0 = success, exit code 1 = failure

### Run Tests

```bash
cd packages/core
npx vitest run src/__tests__/migration-prefix-fix.test.ts
```

### Key Files

| File | Purpose |
|------|---------|
| `verify-migration-fix-ts.mjs` | Primary verification script (no build needed) |
| `packages/core/src/__tests__/migration-prefix-fix.test.ts` | Comprehensive test suite |
| `packages/core/src/db/migrator.ts` | Updated with BEC-149 fix |
| `QUICK-START-VERIFICATION.md` | 2-minute quick reference |
| `BEC-149-SOLUTION-SUMMARY.md` | Complete technical explanation |
| `BEC-149-INDEX.md` | Documentation index & roadmap |

## What Gets Verified

The verification script checks:

✓ No duplicate numeric prefixes in migration files
✓ All migrations have valid names (NNN_description format)
✓ Correct prefix ranges (1-12 SQLite, 1-13 Postgres)
✓ Deprecated files are properly excluded
✓ Migration rename logic works correctly
✓ Rename logic is idempotent (safe to run multiple times)
✓ Sequential numbering with no gaps

## How It Works

### For New Deployments

1. Server starts
2. Migration system loads 12 (SQLite) or 13 (Postgres) deduplicated migrations
3. All migrations run in sequence
4. Each is recorded in schema_migrations

### For Existing Deployments

1. Server starts
2. Migration system checks for old migration names in tracking table
3. Automatically renames them to new names (e.g., 007_sso → 008_sso)
4. Loads deduplicated migrations
5. Skips any already recorded (they were renamed)
6. Runs any new migrations

## Why It's Safe

- ✓ Backward compatible with existing deployments
- ✓ Idempotent (can run multiple times safely)
- ✓ Non-breaking changes to migration logic
- ✓ Old files preserved as stubs for git history
- ✓ Zero downtime deployment
- ✓ Automatic fix on server startup
- ✓ Comprehensive test coverage

## Migration Sequence

### SQLite (12 total)
```
001_initial_schema
002_retry_count
003_review_feedback
004_auto_merge
005_spend_caps
006_audit_events
007_cost_rollups
008_sso             ← Renamed from 007_sso
009_review_model_runs
010_release_manager
011_qa_run_columns
012_qa_gap_issues
```

### Postgres (13 total)
```
001_initial_schema
002_pg_timestamps
003_retry_count
004_review_feedback
005_auto_merge
006_spend_caps
007_audit_events
008_cost_rollups
009_sso             ← Renamed from 008_sso
010_review_model_runs
011_release_manager
012_qa_run_columns
013_qa_gap_issues
```

## Documentation

### Quick References
- **`QUICK-START-VERIFICATION.md`** — 2-minute overview and troubleshooting
- **`BEC-149-INDEX.md`** — Complete documentation index and roadmap

### Technical Deep Dives
- **`BEC-149-SOLUTION-SUMMARY.md`** — Executive summary (15 min read)
- **`MIGRATION_VERIFICATION.md`** — Complete technical guide (30 min read)
- **`ARTIFACTS-SUMMARY.md`** — Overview of deliverables

### For Reviewers
- **`BEC-149-PR-CHECKLIST.md`** — Complete PR review checklist

## Verification Examples

### Minimal Verification
```bash
# Takes ~5 seconds
node verify-migration-fix-ts.mjs
# Exit code 0 = all checks passed
```

### Complete Verification
```bash
# Run verification script
node verify-migration-fix-ts.mjs

# Run tests
cd packages/core
npx vitest run src/__tests__/migration-prefix-fix.test.ts

# Both should show all tests passing
```

### CI/CD Integration
```yaml
- name: Verify BEC-149 Migration Fix
  run: node verify-migration-fix-ts.mjs
```

## Deployment

### Pre-Deployment
1. Run verification script: `node verify-migration-fix-ts.mjs`
2. Run test suite: `cd packages/core && npx vitest run src/__tests__/migration-prefix-fix.test.ts`
3. Review PR changes in `packages/core/src/db/migrator.ts`

### Deployment
1. Merge PR
2. Deploy to production
3. Monitor logs for successful migration startup

### Post-Deployment
1. Verify no migration errors in logs
2. Confirm migration tracking table has correct names
3. Verify no duplicate migrations detected

## Troubleshooting

### "Loaded 0 migrations"
- Check: `ls packages/core/src/db/migrations/`
- Should show `sqlite/` and `postgres/` directories

### "DUPLICATE PREFIXES FOUND"
- This shouldn't happen with the fix
- Run: `node verify-migration-fix-ts.mjs` to debug
- See troubleshooting in `QUICK-START-VERIFICATION.md`

### Script won't run
- Check Node.js version: `node --version` (need 18+)
- Install dependencies: `npm install better-sqlite3`

## Code Changes Summary

### Modified Files
- **`packages/core/src/db/migrator.ts`**
  - Added `SQLITE_MIGRATION_RENAMES` map (lines 33-39)
  - Added `POSTGRES_MIGRATION_RENAMES` map (lines 41-47)
  - Updated `loadMigrationFiles()` filtering (lines 86-108)
  - Updated `runMigrationsSqlite()` rename logic (lines 122-128)
  - Updated `runMigrationsPostgres()` rename logic (lines 235-240)

### Renamed Files (10 total)
- SQLite: 5 files renamed (007→008, 008→009, 009→010, 010→011, 011→012)
- Postgres: 5 files renamed (008→009, 009→010, 010→011, 011→012, 012→013)
- Old files kept as stubs for git history

### New Files
- **`packages/core/src/__tests__/migration-prefix-fix.test.ts`** — Comprehensive test suite
- **`verify-migration-fix-ts.mjs`** — Primary verification script
- **`verify-migration-fix.mjs`** — Alternative verification script

## Testing

### Test Suite Coverage
- SQLite migration deduplication
- Postgres migration deduplication
- Deprecated file exclusion
- Migration rename compatibility
- Idempotency validation
- Prefix uniqueness
- Sequential numbering

### Run Tests
```bash
cd packages/core

# Run BEC-149 tests specifically
npx vitest run src/__tests__/migration-prefix-fix.test.ts

# Run all tests
pnpm test
```

## FAQ

**Q: Do I need to rebuild the project?**
A: Not for verification. The TypeScript script reads source files directly.

**Q: Will this break existing migrations?**
A: No. Existing migrations are renamed but the SQL content is unchanged.

**Q: Do I need to do anything special for deployment?**
A: No. The fix is automatic. On startup, tracking records are updated if needed.

**Q: Is this production-ready?**
A: Yes. Thoroughly tested and verified. Safe to deploy immediately.

**Q: Can I rollback if something goes wrong?**
A: Yes. The fix is safe to rollback. No data loss occurs.

**Q: What if I'm running an old version?**
A: The fix is backward compatible. Your tracking records get automatically updated.

## Next Steps

1. **Verify:** Run `node verify-migration-fix-ts.mjs`
2. **Review:** Read documentation appropriate for your role
3. **Test:** Run the test suite
4. **Deploy:** Follow deployment notes
5. **Monitor:** Watch for successful migration operations

## Support

For more information, see:
- **Quick Reference:** `QUICK-START-VERIFICATION.md`
- **Complete Guide:** `BEC-149-SOLUTION-SUMMARY.md`
- **Technical Details:** `MIGRATION_VERIFICATION.md`
- **Documentation Index:** `BEC-149-INDEX.md`
- **Code:** `packages/core/src/db/migrator.ts`

## Status

✓ Code changes complete
✓ Tests written and passing
✓ Verification scripts created
✓ Documentation comprehensive
✓ Production ready
✓ Safe to deploy

---

**Run verification:** `node verify-migration-fix-ts.mjs`

**Expected result:** `✓ Overall: ALL TESTS PASSED`

**Exit code:** 0 (success) or 1 (failure)
