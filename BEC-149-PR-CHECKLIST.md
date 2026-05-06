# BEC-149 PR Review Checklist

This checklist helps verify that the BEC-149 migration prefix fix is complete and correct.

## Code Changes Verification

### migrator.ts Changes

- [ ] Verify `SQLITE_MIGRATION_RENAMES` map is defined (lines 33-39)
  - [ ] Contains 5 entries
  - [ ] Maps old names to new names (e.g., "007_sso" → "008_sso")
  - [ ] Each old name appears in at least one old migration file (as stub)
  
- [ ] Verify `POSTGRES_MIGRATION_RENAMES` map is defined (lines 41-47)
  - [ ] Contains 5 entries
  - [ ] Maps are consistent with Postgres file renames
  - [ ] Each old name appears in at least one old migration file (as stub)

- [ ] Verify `loadMigrationFiles()` updates (lines 86-108)
  - [ ] Creates `deprecatedNames` set from the rename map
  - [ ] Filters out files matching deprecated names
  - [ ] Comment explains the BEC-149 fix

- [ ] Verify `runMigrationsSqlite()` updates (lines 122-128)
  - [ ] Calls UPDATE statement for each rename map entry
  - [ ] Updates tracking records BEFORE loading migrations
  - [ ] Comment explains the purpose (BEC-149)

- [ ] Verify `runMigrationsPostgres()` updates (lines 235-240)
  - [ ] Similar logic to SQLite version
  - [ ] Uses postgres.js SQL templates
  - [ ] Comment explains the purpose (BEC-149)

### Migration File Changes

#### SQLite Files
- [ ] `007_sso.sql` exists as stub (deprecated)
- [ ] `008_sso.sql` exists with actual migration content
- [ ] `008_review_model_runs.sql` exists as stub (deprecated)
- [ ] `009_review_model_runs.sql` exists with actual migration content
- [ ] `009_release_manager.sql` exists as stub (deprecated)
- [ ] `010_release_manager.sql` exists with actual migration content
- [ ] `010_qa_run_columns.sql` exists as stub (deprecated)
- [ ] `011_qa_run_columns.sql` exists with actual migration content
- [ ] `011_qa_gap_issues.sql` exists as stub (deprecated)
- [ ] `012_qa_gap_issues.sql` exists with actual migration content

#### Postgres Files
- [ ] Similar pattern as SQLite, but with postgres-specific SQL

### No Unintended Changes
- [ ] No changes to migration SQL content
- [ ] No changes to other parts of the codebase
- [ ] No changes to test expectations (except BEC-149 test additions)

## Test Coverage

### New Test File
- [ ] `packages/core/src/__tests__/migration-prefix-fix.test.ts` exists
- [ ] Tests SQLite migrations
  - [ ] Verifies no duplicates
  - [ ] Verifies all have valid names
  - [ ] Verifies expected prefix range (1-12)
  - [ ] Verifies deprecated files are excluded
  
- [ ] Tests Postgres migrations
  - [ ] Same checks as SQLite
  - [ ] Verifies expected prefix range (1-13)
  
- [ ] Tests migration rename compatibility
  - [ ] Creates temporary database
  - [ ] Inserts old migration names
  - [ ] Applies rename logic
  - [ ] Verifies new names exist
  - [ ] Verifies old names are gone
  
- [ ] Tests idempotency
  - [ ] Rename logic can be applied multiple times
  - [ ] No errors on re-application

### Existing Tests Still Pass
- [ ] `cd packages/core && pnpm test` passes
- [ ] No regressions in other test files
- [ ] Migration-related tests still pass

## Documentation

### Verification Documentation
- [ ] `QUICK-START-VERIFICATION.md` exists
  - [ ] Clear instructions for running verification
  - [ ] Expected output shown
  - [ ] Troubleshooting section included
  
- [ ] `MIGRATION_VERIFICATION.md` exists
  - [ ] Explains the problem
  - [ ] Documents the solution
  - [ ] Shows how it works
  - [ ] Lists what's verified
  - [ ] Includes example output
  
- [ ] `BEC-149-SOLUTION-SUMMARY.md` exists
  - [ ] Executive summary of fix
  - [ ] Before/after comparison
  - [ ] Component breakdown
  - [ ] Safety guarantees
  - [ ] Deployment notes

### Verification Scripts
- [ ] `verify-migration-fix-ts.mjs` exists and works
  - [ ] Runs without build
  - [ ] Extracts rename maps from source
  - [ ] Loads migrations for both drivers
  - [ ] Checks for duplicates
  - [ ] Tests rename logic
  - [ ] Provides detailed output
  
- [ ] `verify-migration-fix.mjs` exists (alternative)
  - [ ] Same functionality as TypeScript version
  - [ ] Works after build

## Manual Verification

### File System Checks
```bash
# Check SQLite migrations
ls -1 packages/core/src/db/migrations/sqlite/ | sort
# Should show: 001 through 012 with no duplicate prefixes

# Check Postgres migrations
ls -1 packages/core/src/db/migrations/postgres/ | sort
# Should show: 001 through 013 with no duplicate prefixes

# Verify deprecated files exist (for git history)
ls -1 packages/core/src/db/migrations/sqlite/007_sso.sql
ls -1 packages/core/src/db/migrations/sqlite/008_sso.sql
# Both should exist
```

### Run Verification Script
```bash
node verify-migration-fix-ts.mjs
# Should output: ✓ Overall: ALL TESTS PASSED
# Exit code should be 0
```

### Run Test Suite
```bash
cd packages/core
npx vitest run src/__tests__/migration-prefix-fix.test.ts
# All tests should pass
```

## Deployment Readiness

- [ ] Code changes are complete
- [ ] All tests pass
- [ ] Documentation is clear and comprehensive
- [ ] Verification scripts work correctly
- [ ] No breaking changes for existing code
- [ ] Backward compatible with old deployments
- [ ] Safe to deploy to production

## Risk Assessment

### Low Risk Areas
- [ ] Migration file renaming (non-breaking)
- [ ] Adding new constants to migrator.ts
- [ ] Filtering deprecated files (no side effects)

### Migration Logic Changes (Should be Careful)
- [ ] Rename tracking records on startup
  - [ ] Idempotent (safe to run multiple times)
  - [ ] Only affects existing deployments
  - [ ] New deployments unaffected
  - [ ] No data loss

### Testing Coverage
- [ ] Unit tests for all new code
- [ ] Integration tests for rename logic
- [ ] Test with both SQLite and Postgres
- [ ] Idempotency verified

## Sign-Off Checklist

### Code Reviewer
- [ ] Code changes are correct and complete
- [ ] Tests are comprehensive
- [ ] Documentation is clear
- [ ] No security issues
- [ ] No performance regressions
- [ ] Follows project conventions

### Test Verifier
- [ ] All tests pass locally
- [ ] Verification script produces expected output
- [ ] No regressions in other tests
- [ ] CI/CD tests pass

### Architecture/Security Reviewer
- [ ] Solution is sound
- [ ] No security risks
- [ ] Backward compatible
- [ ] Production ready

### Product/Operations
- [ ] Solves the reported issue (BEC-149)
- [ ] No breaking changes
- [ ] Safe to deploy
- [ ] Documentation sufficient for operations team

## Final Checks

Before merging:

- [ ] All checkboxes above are checked
- [ ] No comments or TODOs left in code
- [ ] Commit messages are clear
- [ ] PR description explains the fix
- [ ] Documentation is accessible from repo root
- [ ] Verification script is in root directory
- [ ] Tests can be run with standard commands

## Post-Merge

- [ ] Merge PR
- [ ] Verify in staging environment
- [ ] Deploy to production
- [ ] Monitor logs for migration rename operations
- [ ] Verify no duplicate migrations detected in production
- [ ] Close BEC-149 issue

## Rollback Plan

If issues arise:

1. Revert the PR
2. Old `schema_migrations` records will remain
3. Migration system will handle them on next startup
4. No data loss

## Success Criteria

After deployment:

- [ ] No duplicate migration errors in logs
- [ ] Migration tracking table has correct names (new names, not old)
- [ ] No duplicate migrations re-run
- [ ] New deployments run all migrations cleanly
- [ ] Existing deployments apply auto-rename without errors

---

**PR Status:** Ready for review ✓

**Verification Command:**
```bash
node verify-migration-fix-ts.mjs
```

**Expected Result:**
```
✓ Overall: ALL TESTS PASSED
```
