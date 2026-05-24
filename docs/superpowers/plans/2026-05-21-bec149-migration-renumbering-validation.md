# BEC-149 Migration Renumbering — Validation Plan

**PR**: #334
**Branch**: `agent/BEC-149-tech-debt-duplicate-migration-prefixes-007-008-in-`
**Last build state**: green (29/29 migrator tests, 11/11 db-migrations tests, full `pnpm -w typecheck` clean).

## Goal

Verify that PR #334 (migration renumbering with tombstone+rename mechanism) is safe to merge by exercising the upgrade path against the actual dogfood `schema_migrations` table contents.

The merge is non-trivial because:
- Dogfood DB has 15 rows in `schema_migrations` referencing the OLD migration names (`007_sso`, `008_review_model_runs`, ..., `013_triage_results`).
- The PR renames 8 of those to new prefixes, and the migrator's rename step must rewrite each `schema_migrations` entry from old→new without re-applying any DDL.
- If the rename map is wrong (missing an entry, wrong target name) the migrator would treat the new-prefix file as "pending" and re-run its DDL on the existing schema — most are `CREATE TABLE IF NOT EXISTS` (safe) but a few have `ALTER TABLE ADD COLUMN` (would error on second apply).

## Current dogfood `schema_migrations` rows

```
001_initial_schema           004_auto_merge        007_cost_rollups     010_qa_run_columns
002_retry_count              005_spend_caps        007_sso              011_qa_gap_issues
003_review_feedback          006_audit_events      008_review_model_runs 012_stage_runs_cache_tokens
                                                   009_release_manager  013_missing_indexes
                                                                        013_triage_results
```

The 8 names slated to be rewritten by the rename map (after my fix extends the map):

| Old | New |
|-----|-----|
| `007_sso` | `008_sso` |
| `008_review_model_runs` | `009_review_model_runs` |
| `009_release_manager` | `010_release_manager` |
| `010_qa_run_columns` | `011_qa_run_columns` |
| `011_qa_gap_issues` | `012_qa_gap_issues` |
| `012_stage_runs_cache_tokens` | `013_stage_runs_cache_tokens` |
| `013_missing_indexes` | `014_missing_indexes` |
| `013_triage_results` | `015_triage_results` |

## Phase 1 — local validation against a dogfood DB snapshot

This is the most important check. The dogfood DB is on Hetzner; we can copy a snapshot of `dogfood.db` to a local laptop and boot the urateam container against it with PR #334's code.

1. **Snapshot dogfood DB:**
   ```bash
   ssh -i ~/.ssh/id_rsa deploy@178.156.149.132 \
     "docker exec urateam-dogfood sqlite3 /home/ura/data/dogfood.db .dump" \
     > /tmp/dogfood-snapshot-pre334.sql
   ```
   Reproduces the on-disk state so any downstream test is operating on real history.

2. **Restore into a local SQLite file:**
   ```bash
   sqlite3 /tmp/dogfood-snapshot-pre334.db < /tmp/dogfood-snapshot-pre334.sql
   sqlite3 /tmp/dogfood-snapshot-pre334.db "SELECT name FROM schema_migrations ORDER BY name;"
   ```
   Expected: 15 rows matching the list above.

3. **Boot urateam-core against the snapshot on PR #334:**
   ```bash
   cd /Users/jonb/projects/urateam
   git fetch origin pull/334/head:pr-334-review
   git checkout pr-334-review
   git merge main --no-edit
   pnpm install && pnpm -w build
   DATABASE_URL=/tmp/dogfood-snapshot-pre334.db \
     pnpm --filter @urateam/core run start  # or whichever entry point runs createDb()
   ```
   Watch for `Migration: applying X` log lines — there should be ZERO. Every active migration must be reported as `already applied`.

4. **Inspect `schema_migrations` after the boot:**
   ```bash
   sqlite3 /tmp/dogfood-snapshot-pre334.db "SELECT name FROM schema_migrations ORDER BY name;"
   ```
   Expected — exactly 15 rows again, but with the renamed entries:
   ```
   001_initial_schema          007_cost_rollups       011_qa_run_columns
   002_retry_count             008_sso                012_qa_gap_issues
   003_review_feedback         009_review_model_runs  013_stage_runs_cache_tokens
   004_auto_merge              010_release_manager    014_missing_indexes
   005_spend_caps                                     015_triage_results
   006_audit_events
   ```

5. **Diff the schema:**
   ```bash
   sqlite3 /tmp/dogfood-snapshot-pre334.db ".schema" > /tmp/dogfood-schema-after.sql
   ssh -i ~/.ssh/id_rsa deploy@178.156.149.132 \
     "docker exec urateam-dogfood sqlite3 /home/ura/data/dogfood.db .schema" \
     > /tmp/dogfood-schema-before.sql
   diff /tmp/dogfood-schema-before.sql /tmp/dogfood-schema-after.sql
   ```
   Expected: empty diff. If anything differs, a migration DDL re-ran when it shouldn't have.

## Phase 2 — fresh-DB validation

For new installs (Pro/OSS users adopting urateam for the first time):

1. **Boot urateam against an empty DB on PR #334:**
   ```bash
   DATABASE_URL=/tmp/fresh-test.db pnpm --filter @urateam/core run start
   ```

2. **Verify `schema_migrations` matches the active migration list:**
   ```bash
   sqlite3 /tmp/fresh-test.db "SELECT name FROM schema_migrations ORDER BY name;"
   ```
   Expected — only the NEW names (no tombstones):
   ```
   001_initial_schema, 002_retry_count, ..., 007_cost_rollups,
   008_sso, 009_review_model_runs, 010_release_manager, 011_qa_run_columns,
   012_qa_gap_issues, 013_stage_runs_cache_tokens, 014_missing_indexes,
   015_triage_results
   ```

3. **Idempotency check:** restart the container and confirm zero migrations apply on the second boot.

## Phase 3 — Postgres path (defer if dogfood is SQLite-only)

The dogfood instance uses SQLite per `DATABASE_URL=/home/ura/data/dogfood.db`. The Postgres path matters for managed-runtime customers but is not on the critical-path here. Validate via the existing `migrator.test.ts` Postgres tests when `TEST_POSTGRES_URL` is configured — they were green in my run, but they're SKIPPED locally without that env var.

If a Postgres customer is identified before merge, repeat Phase 1 against a snapshot of their DB.

## Phase 4 — dogfood deploy validation

After merging + cutting a release with PR #334:

1. **Pre-deploy SQL backup:**
   ```bash
   ssh -i ~/.ssh/id_rsa deploy@178.156.149.132 \
     "docker exec urateam-dogfood cp /home/ura/data/dogfood.db /home/ura/data/dogfood.db.pre-bec149-backup"
   ```

2. **Deploy** (follow `reference_dogfood_deploy` memory):
   ```bash
   ssh -i ~/.ssh/id_rsa deploy@178.156.149.132
   cd /home/deploy/urateam
   git fetch origin --tags
   git stash push -m "operator-mods-pre-vX.Y.Z" Dockerfile docker-compose.dogfood.yml
   git checkout vX.Y.Z
   git stash pop
   docker compose -f docker-compose.dogfood.yml up -d --build
   ```

3. **Post-deploy verification:**
   ```bash
   ssh -i ~/.ssh/id_rsa deploy@178.156.149.132 "docker logs --tail 100 urateam-dogfood | grep -iE 'migration|schema_migrations'"
   # Expect: "renaming X → Y" lines for each rename map entry, then "no pending migrations"
   ssh -i ~/.ssh/id_rsa deploy@178.156.149.132 \
     "docker exec urateam-dogfood sqlite3 /home/ura/data/dogfood.db 'SELECT name FROM schema_migrations ORDER BY name;'"
   # Expect: the 15 NEW names from Phase 1 step 4
   ```

4. **Smoke check:** trigger one PM tick by creating a Linear test issue, watch the pipeline succeed. The pipeline exercises every relevant table — if a migration DDL silently re-ran and corrupted a column, the pipeline will surface it within one run.

## Rollback plan

If Phase 1 or Phase 4 reveals an issue:

1. Container restart with the pre-deploy backup:
   ```bash
   ssh -i ~/.ssh/id_rsa deploy@178.156.149.132 \
     "docker exec urateam-dogfood cp /home/ura/data/dogfood.db.pre-bec149-backup /home/ura/data/dogfood.db"
   ssh -i ~/.ssh/id_rsa deploy@178.156.149.132 "docker restart urateam-dogfood"
   ```

2. Revert the PR commit on main and cut a patch release.

The rename map is the ONLY thing that needs to be correct — the DDL in the new-prefix files is identical to the DDL in the old-prefix files (verified by `cp` rather than rewrite). So if the rename map is incomplete, the failure mode is "some DDL re-runs" — and most of those DDLs are idempotent (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`).

## Risk assessment after Phase 1

| Phase 1 result | Decision |
|----------------|----------|
| Empty schema diff + 15 renamed entries | Safe to merge. Proceed to release. |
| Schema diff shows new columns/tables created twice | Migrator rename logic bug — block merge, file follow-up. |
| Migrator logs "applying X" for a migration name already in schema_migrations under its old name | Rename map missing an entry — extend it and re-run Phase 1. |
| Boot fails with SQL error | Non-idempotent migration tried to re-apply — block merge, investigate the specific migration. |

## Out of scope

- The Postgres test path under `TEST_POSTGRES_URL` (defer to managed-runtime ticket).
- Validating against any DB other than dogfood (no other production deployments at the moment).
- The "tombstone files retained for git history" decision — already locked in by precedent (the original PR's `007_sso.sql` tombstone).
