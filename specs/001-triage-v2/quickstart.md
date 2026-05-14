# Quickstart: Triage v2

**Audience**: Anyone implementing or reviewing Tier 6 work.

**Prerequisites**: Read [`spec.md`](./spec.md) (the user-facing requirements)
and [`plan.md`](./plan.md) (the implementation strategy) first.

## TL;DR

1. **Add 5 optional fields** to `TriageResult` in `packages/core/src/pm/types.ts`.
2. **Extract the v1 prompt** out of `triage.ts` into `triage-prompt.ts`.
3. **Add the v2 prompt** — XML-delineated sections, role priming,
   multishot examples, scratchpad CoT, JSON prefill.
4. **Add a `isV2Disabled()` env-var check**; default uses v2, env-var
   `URATEAM_DISABLE_TRIAGE_V2=true` falls back to v1.
5. **Extract the Linear comment renderer** into `triage-render.ts` and
   add the 5 new sections (Assumptions / Examples / Affected Files /
   Test Strategy / Risk Assessment), with `(none)` placeholders.
6. **Extend the description appender** to write the same 5 sections to
   the issue description (so the implement-stage agent's prompt
   naturally includes them via the existing description-in-prompt path).
7. **Add the prediction-quality utility** as a pure function in
   `pm/triage-prediction-quality.ts`.
8. **Add tests**: prompt snapshot, schema validation, renderer, env-var
   toggle, prediction-quality utility, regression on existing tests.
9. **Update CLAUDE.md** to document the new fields, the env var, and
   the comment template. Tier 1d count stays at 51 (no new audit
   events in this scope).

## Local Dev Loop

```bash
# Run only the triage-related tests (fast iteration)
cd packages/core && npx vitest watch src/__tests__/triage

# Workspace typecheck
pnpm -w typecheck

# Full core test sweep (before pushing)
pnpm --filter @urateam/core test
```

## Smoke Test (Pre-PR)

The triage prompt is in the hot path of every Linear issue. Before
pushing the PR, smoke-test against a synthetic Haiku call:

```bash
# (No CLI binding for this — direct vitest invocation runs the smoke test
#  test that constructs a fake Haiku response and verifies parse + render)
cd packages/core && npx vitest run src/__tests__/triage-v2-smoke.test.ts
```

## Dogfood Smoke Test (Post-Deploy)

After deploying to the dogfood:

1. Create a synthetic Linear issue with a clearly-specifiable title
   (e.g., "Sort the user list by lastSignInAt descending in
   `/users` dashboard route").
2. Wait for the next PM tick (≤ 30 min).
3. Verify the Linear comment contains all 5 new sections:
   `### Assumptions`, `### Examples`, `### Affected Files`,
   `### Test Strategy`, `### Risk Assessment`.
4. Verify the issue description was appended with the same sections in
   `**Label:**` style.
5. If wrong: set `URATEAM_DISABLE_TRIAGE_V2=true` in the dogfood `.env`
   and the next tick uses v1. No daemon restart needed.

## Files Touched

| File | Action |
|---|---|
| `packages/core/src/pm/types.ts` | Modify — extend `TriageResult` interface |
| `packages/core/src/pm/actions/triage.ts` | Modify — wire v2 prompt + env-var check |
| `packages/core/src/pm/actions/triage-prompt.ts` | NEW — prompt template |
| `packages/core/src/pm/actions/triage-render.ts` | NEW — comment + description renderer |
| `packages/core/src/pm/triage-prediction-quality.ts` | NEW — prediction-quality utility (pure) |
| `packages/core/src/__tests__/triage.test.ts` | Modify — regression: v1 still works |
| `packages/core/src/__tests__/triage-v2-prompt.test.ts` | NEW |
| `packages/core/src/__tests__/triage-v2-schema.test.ts` | NEW |
| `packages/core/src/__tests__/triage-v2-render.test.ts` | NEW |
| `packages/core/src/__tests__/triage-v2-env-toggle.test.ts` | NEW |
| `packages/core/src/__tests__/triage-v2-prediction.test.ts` | NEW |
| `CLAUDE.md` | Modify — document new fields, env var, comment template |

## Rollout

1. Open PR; `pnpm test` + `pnpm -w typecheck` green.
2. Dispatch Sonnet `feature-dev:code-reviewer` per Constitution Principle
   III workflow.
3. Address BLOCKING findings in-PR.
4. Merge.
5. Cut v0.1.57 patch release.
6. npm publish.
7. Deploy v0.1.57 to the dogfood.
8. Dogfood smoke test per the section above.
9. If smoke test fails: flip `URATEAM_DISABLE_TRIAGE_V2=true` in the
   dogfood `.env`. The next PM tick uses v1. File a follow-up Linear
   ticket for the v2 prompt fix.
