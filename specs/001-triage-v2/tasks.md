---

description: "Triage v2 (Tier 6a + 6b) — TDD task list"

---

# Tasks: Triage v2 — Structured Requirements for Autonomous Coding Agents

**Input**: Design documents from `/specs/001-triage-v2/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md),
[research.md](./research.md), [data-model.md](./data-model.md),
[contracts/](./contracts/triage-result.schema.md),
[quickstart.md](./quickstart.md).

**Tests**: TDD is required by Constitution Principle II. Every task that
adds or modifies behavior MUST have a failing test that proves the gap
before the implementation. Each task's `— Verification:` clause runs the
relevant test(s).

**Organization**: Tasks are grouped by user story from `spec.md`:

- **US1** (P1): Operator reads a structured Linear comment.
- **US2** (P1): Implement agent receives concrete examples.
- **US3** (P1): Env-var escape hatch (`URATEAM_DISABLE_TRIAGE_V2`).
- **US4** (P2): Triage prediction error as a quality signal.

## Format: `[ID] [P?] [Story] Description — Verification: <command|gate|artifact>`

- **[P]**: Can run in parallel (different files, no dependencies on
  incomplete tasks).
- **[Story]**: Which user story this task belongs to (US1/US2/US3/US4).
  Setup, Foundational, and Polish phases have no story label.
- File paths are absolute relative to the repo root.

---

## Phase 1: Setup

No setup tasks required — `@urateam/core` is an existing package with
working test infra. The branch `001-triage-v2` is already created.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Schema additions + prompt-file scaffold. Both blocking
prerequisites for any user-story phase.

- [ ] **T001** Add `TriageV2ExtensionsSchema` zod schema + a `parseTriageV2Extensions(raw: unknown)` helper that applies `slice(0, N)` truncation before validation. File: `packages/core/src/pm/types.ts` (schema is co-located with the `TriageResult` interface for discoverability). Pre-zod truncation behavior: per [`data-model.md`](./data-model.md), `assumptions ≤ 10`, `examples ≤ 3`, `affectedFiles ≤ 20`, `riskAssessment.areas ≤ 5`. Test file: `packages/core/src/__tests__/triage-v2-schema.test.ts`. — Verification: `pnpm --filter @urateam/core test src/__tests__/triage-v2-schema.test.ts`

- [ ] **T002** Extend the `TriageResult` interface in `packages/core/src/pm/types.ts` with the five optional Tier-6b fields per [`data-model.md`](./data-model.md). Add JSDoc per field documenting it as Tier 6b. Co-locate with `TriageV2ExtensionsSchema` from T001 so a `z.infer<>` keeps the interface and zod schema in sync. — Verification: `pnpm -w typecheck` (compiler accepts the new fields; existing call sites still typecheck because every new field is `?:` optional)

- [ ] **T003** Create `packages/core/src/pm/actions/triage-prompt.ts` as an empty extraction target. Move the existing v1 prompt string (currently a multi-line literal inside `triageNewIssues` in `triage.ts`, lines ~150-165) into an exported function `buildTriageV1Prompt(issue: { identifier, title, description }, sanitize): string`. This task is a pure refactor — no behavior change. Test file: `packages/core/src/__tests__/triage-v2-prompt.test.ts` asserts `buildTriageV1Prompt` produces the same string that the v1 inline literal produced (snapshot). — Verification: `pnpm --filter @urateam/core test src/__tests__/triage-v2-prompt.test.ts` plus `pnpm --filter @urateam/core test src/__tests__/triage.test.ts` (regression — existing triage tests must still pass)

---

## Phase 3: US3 — Env-var Escape Hatch (P1)

**Story goal**: Operator can flip `URATEAM_DISABLE_TRIAGE_V2=true` to fall back to the v1 prompt + schema with no daemon restart.

**Independent test**: With the env var set, the next triage call uses the v1 prompt and schema; with it unset, v2 runs.

- [ ] **T004** [US3] Add `isV2Disabled(env: NodeJS.ProcessEnv = process.env): boolean` export to `packages/core/src/pm/actions/triage-prompt.ts`. Strict equality check on the string `"true"`. Test cases: env unset → false; env `"true"` → true; env `"1"` / `"yes"` / `""` / `"false"` → false; env literal `"TRUE"` (different case) → false. Test file: `packages/core/src/__tests__/triage-v2-env-toggle.test.ts`. — Verification: `pnpm --filter @urateam/core test src/__tests__/triage-v2-env-toggle.test.ts`

---

## Phase 4: US1 + US2 — Structured Triage Output (P1)

**Story goal**: The triage Haiku call produces structured v2 fields; the Linear comment renders them as headed sections; the issue description is appended with the same content so the implement-stage agent reads it via the existing description-in-prompt path.

**Independent test**: A `TriageResult` with all five new fields populated produces a Linear comment containing 5 `### …` headings and an issue description with 5 `**Label:**` sections.

- [ ] **T005** [US1] Add `buildTriageV2Prompt(input: { issue, sanitize }): string` to `packages/core/src/pm/actions/triage-prompt.ts`. Implements the XML-delineated, role-primed, multishot, scratchpad-CoT, JSON-prefilled prompt skeleton from [`plan.md`](./plan.md) §"Phase 1 — Triage Prompt Template Skeleton" and the multishot details from [`research.md`](./research.md) §1-§4. Hard cap: prefix (everything before `<issue>`) ≤ 15K tokens. Test: snapshot test on `buildTriageV2Prompt` output for a canonical input fixture; character-count assertion on the prefix portion. Test file: `packages/core/src/__tests__/triage-v2-prompt.test.ts` (extended from T003). — Verification: `pnpm --filter @urateam/core test src/__tests__/triage-v2-prompt.test.ts`

- [ ] **T006** [P] [US1] Add `parseTriageV2Output(raw: unknown): Partial<TriageResult>` to `packages/core/src/pm/actions/triage-prompt.ts`. Calls `parseTriageV2Extensions` from T001 and merges its output into the v1-shape result. Handles malformed JSON (zod safe-parse), truncates excess list entries (pre-zod `slice`), and drops the entire `riskAssessment` block when severity enum fails. Test file: `packages/core/src/__tests__/triage-v2-schema.test.ts` (extended from T001 to add full-output-parse cases). — Verification: `pnpm --filter @urateam/core test src/__tests__/triage-v2-schema.test.ts`

- [ ] **T007** [P] [US1] Create `packages/core/src/pm/actions/triage-render.ts` exporting `renderTriageComment(result: TriageResult, opts: { forceNeedsDesign: boolean; pipelineLabel: string }): string`. Implements the markdown contract from [`contracts/triage-result.schema.md`](./contracts/triage-result.schema.md) §2. Empty v2 fields render `(none)`. Test: snapshot of full v2 result; snapshot of v1-shaped result (no v2 fields → `(none)` placeholders); snapshot of `forceNeedsDesign: true`. Test file: `packages/core/src/__tests__/triage-v2-render.test.ts`. — Verification: `pnpm --filter @urateam/core test src/__tests__/triage-v2-render.test.ts`

- [ ] **T008** [P] [US2] In `packages/core/src/pm/actions/triage-render.ts`, add `appendTriageSectionsToDescription(existingDesc: string, result: TriageResult): string`. Implements the description-append contract from [`contracts/triage-result.schema.md`](./contracts/triage-result.schema.md) §3. Idempotent: skips any section whose `**Label:**` marker already appears in `existingDesc`. Appends `**Acceptance Criteria:**` (today's behavior, preserved), then `**Examples:**`, `**Affected Files:**`, `**Test Strategy:**`, `**Risk Assessment:**`. Test: round-trip (description twice → no duplication); v1 input (only AC appended); v2 input (all 5 sections appended); edge: `existingDesc` already has `**Examples:**` from a manual operator edit → skip. Test file: `packages/core/src/__tests__/triage-v2-render.test.ts` (extended from T007). — Verification: `pnpm --filter @urateam/core test src/__tests__/triage-v2-render.test.ts`

- [ ] **T009** [US1] Wire v2 into `packages/core/src/pm/actions/triage.ts`. Replace the inline prompt literal with a call to `buildTriageV2Prompt` (or `buildTriageV1Prompt` when `isV2Disabled()` is true). Replace the inline JSON parse with `parseTriageV2Output`. Replace the inline comment-building with `renderTriageComment` (always called; the renderer itself handles the v1 vs v2 detection internally via the presence/absence of v2 fields on `result`). Replace the inline description-append logic with `appendTriageSectionsToDescription`. Preserve all existing flow: observer-marker gate, force-needs-design, label resolution, audit event emission. Test: regression — existing `triage.test.ts` still passes; new tests verify the wiring branches on `URATEAM_DISABLE_TRIAGE_V2`. Test file: `packages/core/src/__tests__/triage.test.ts` (extended). — Verification: `pnpm --filter @urateam/core test src/__tests__/triage.test.ts`

---

## Phase 5: US4 — Prediction-Quality Utility (P2)

**Story goal**: A pure function computes the diff between triage's predicted `affectedFiles` and the actual diff at completion time. Foundation for Tier 6e.

**Independent test**: `computeAffectedFilesPredictionQuality(["a.ts", "b.ts"], ["a.ts", "c.ts"])` returns `{predicted: 2, actual: 2, intersection: 1, missed: ["b.ts"], unexpected: ["c.ts"], hasV2Prediction: true}`.

- [ ] **T010** [P] [US4] Add `packages/core/src/pm/triage-prediction-quality.ts` exporting `computeAffectedFilesPredictionQuality(predicted: string[] | undefined, actualDiff: string[]): PredictionQualityResult` per [`contracts/triage-result.schema.md`](./contracts/triage-result.schema.md) §5. Pure function. No DB writes. Returns `hasV2Prediction: false` when `predicted === undefined` (v1 triage). Test cases: happy path, perfect prediction, complete miss, undefined predicted, empty predicted, empty actual, both empty. Test file: `packages/core/src/__tests__/triage-v2-prediction.test.ts`. — Verification: `pnpm --filter @urateam/core test src/__tests__/triage-v2-prediction.test.ts`

---

## Phase 6: Polish & Cross-Cutting

- [ ] **T011** Update `CLAUDE.md` PM Agent section to document: (a) the five new `TriageResult` fields, (b) the `URATEAM_DISABLE_TRIAGE_V2=true` escape hatch, (c) the markdown comment template (5 new headed sections + `(none)` placeholders), (d) the description-append idempotency contract. Bump the Tier 1d audit-event count nowhere (no new event types in this scope; count stays at 51). — Verification: `pnpm --filter @urateam/core test src/__tests__/audit-immutability.test.ts` (Tier 1d guard remains green)

- [ ] **T012** Full workspace sweep before PR. — Verification: `pnpm -w typecheck && pnpm --filter @urateam/core test`

- [ ] **T013** Commit + push branch to remote. — Verification: `git push -u origin 001-triage-v2 2>&1 | tail -3` shows the push acknowledgement

- [ ] **T014** Open PR with the 9-category convention self-review block. — Verification: `gh pr create --title "feat(pm): Triage v2 — structured requirements for downstream agents" --body "$(cat <<EOF
...
EOF
)"` returns a PR URL; the PR body contains the 9-category convention checklist per Constitution Principle III workflow

- [ ] **T015** Dispatch Sonnet `feature-dev:code-reviewer` (model: sonnet) with the spec + plan + contracts as the brief. Address every BLOCKING finding before lifting draft status (if any). — Verification: `gh pr view <num> --comments` shows the reviewer's `VERDICT: READY TO MERGE`; if `VERDICT: REQUIRES CHANGES`, the BLOCKING findings have been addressed in follow-up commits

- [ ] **T016** Merge PR after CI green. — Verification: `gh pr view <num> --json state` returns `"MERGED"`

- [ ] **T017** Cut v0.1.57 release. — Verification: `pnpm cut-release patch` succeeds and creates the release branch + tag candidate

- [ ] **T018** Publish + deploy to dogfood. — Verification: `npm view @urateam/cli@<new-version> version` confirms the publish; `ssh deploy@178.156.149.132 'docker exec urateam-dogfood ura --version'` confirms the new version is running

---

## Dependencies & Story Completion Order

```text
T001 (schema) ── T002 (interface) ── T003 (v1 prompt extraction)
                                         │
                                         ├─ Phase 3 (US3) ─ T004 (env var)
                                         │
                                         ├─ Phase 4 (US1+US2)
                                         │   ├─ T005 (v2 prompt)
                                         │   ├─ T006 (parser)
                                         │   ├─ T007 (renderer)
                                         │   ├─ T008 (description appender)
                                         │   └─ T009 (triage.ts wiring) ── depends on T004-T008
                                         │
                                         └─ Phase 5 (US4) ─ T010 (prediction)

T001-T010 ── T011 (CLAUDE.md) ── T012 (sweep) ── T013 (push) ── T014 (PR) ── T015 (review) ── T016 (merge) ── T017 (release) ── T018 (deploy)
```

## Parallel Opportunities

- T006, T007, T008 can run in parallel (independent files; T006 in `triage-prompt.ts`, T007+T008 both in `triage-render.ts`).
- T010 (prediction utility) is fully independent and can run in parallel with any of T004-T009.
- Phase 6 tasks (T011-T018) are strictly sequential by design.

## MVP Scope

US1 + US2 + US3 (T001-T009 + T011-T013 + the PR) is the MVP. US4 (T010) is foundation for Tier 6e and can be deferred to a follow-up PR if scope-trimming becomes necessary. T015-T018 (release + deploy) are the standard ship cycle.

## Independent Test Criteria per Story

- **US1**: Generate a `TriageResult` with all 5 new fields; call `renderTriageComment`; assert 5 `### …` headings appear in the output.
- **US2**: Generate a `TriageResult` with `examples` populated; call `appendTriageSectionsToDescription`; assert `**Examples:**` section is in the output and the existing implement template's prompt (built via `templates.ts:issueDataBlock`) will naturally include this content.
- **US3**: Set `URATEAM_DISABLE_TRIAGE_V2=true`; assert `isV2Disabled()` returns `true` and `buildTriageV1Prompt` is selected; unset it; assert v2 path runs.
- **US4**: Construct `computeAffectedFilesPredictionQuality(["a.ts","b.ts"], ["a.ts","c.ts"])`; assert the expected quality result.
