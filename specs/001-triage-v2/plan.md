# Implementation Plan: Triage v2 — Structured Requirements for Autonomous Coding Agents

**Branch**: `001-triage-v2` | **Date**: 2026-05-13 | **Spec**: [`spec.md`](./spec.md)

**Input**: Feature specification from [`/specs/001-triage-v2/spec.md`](./spec.md)

## Summary

Upgrade the PM Agent's triage stage to produce spec-kit-quality structured
requirements for downstream Claude coding agents. Replace the current
ad-hoc prompt with an Anthropic-best-practices template (XML-delineated
sections, role priming, scratchpad reasoning, multishot examples per
pipeline label, JSON prefill). Extend the `TriageResult` schema with five
optional fields (`assumptions`, `examples`, `affectedFiles`, `testStrategy`,
`riskAssessment`) that travel into the Linear comment and the issue
description so both the operator and the implement-stage agent can act on
structured guidance. Ship behind `URATEAM_DISABLE_TRIAGE_V2=true` escape
hatch for one release.

## Technical Context

**Language/Version**: TypeScript 5.7 on Node 22.

**Primary Dependencies**: `@linear/sdk` (Linear API), `zod` (schema
validation), `pino` (structured logging), `vitest` (testing). All already
present; no new dependencies.

**Storage**: Existing `pipeline_runs` / `audit_events` tables. **No DB
schema mutations.** New optional `TriageResult` fields live only in the
result type and the Linear issue body / comment text — no persistence.

**Testing**: `vitest` (unit + snapshot). Tests live in
`packages/core/src/__tests__/`. Triage-specific tests added at
`triage-v2.test.ts`; existing `triage.test.ts` validates regression.

**Target Platform**: Node 22 server-side (`@urateam/core`). Runs in:
the daemon (`ura start`), the dogfood Docker container, and the CLI
(`ura run` / `ura dev`). The Haiku call path is identical across all
three.

**Project Type**: TypeScript library (`@urateam/core`) — single package
in a pnpm monorepo. Triage v2 ships entirely within `packages/core/`.

**Performance Goals**: Triage tick latency stays within today's envelope
(< 30s per issue, < 90s per tick of 3 issues batched). Cache-prefix hit
ratio on the triage Haiku prompt prefix stays above 80% (the multishot
examples are a one-time prefix cost; the per-issue suffix is short).

**Constraints**: Haiku 4.5 only (the existing `callClaude` factory binds
to Haiku for triage; we don't upgrade the model in this scope). Prompt
size budget: prefix + multishot examples + repo-context ≤ 15K tokens to
leave room for issue body in the suffix. Output token budget: existing
v1 produces ~400 tokens; v2 adds ~500 tokens for the new fields, so
budget cap stays at the existing implicit ~3K.

**Scale/Scope**: All triaged issues across all teams configured in
`PM_AGENT_TEAM_IDS`. Today's dogfood runs ~10 issues per PM tick on a
30-minute interval, so ~480 triage calls per day per deployment. Cost
target: < $0.005 per triage call (Haiku 4.5 with prefix caching).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- [x] **I. Specify Before Implementing** — `spec.md` exists with structured
      ACs, four user stories (Given/When/Then), 10 functional requirements,
      5 success criteria, 8 assumptions. No `[NEEDS CLARIFICATION]` markers.
      Spec quality checklist all-green.
- [x] **II. Verification Before Completion (NON-NEGOTIABLE)** — every task
      in `tasks.md` (to be produced by `/speckit-tasks`) will end with a
      `— Verification:` clause per the constitution-aligned tasks template.
      Plan additionally specifies the verification commands per
      implementation step in Phase 2 below.
- [x] **III. Convention Gates Run Before Push** — no convention-gate
      disables required. The new code uses `execFile` (not `exec`),
      structured `createLogger` logging (the existing PM Agent logger is
      preserved), `failPipeline()` is not invoked because triage failures
      gracefully degrade (the existing error-handling path returns `null`
      for the failed issue and continues — same pattern as v1). No `as any`,
      no credential-named exported fields, no bare throws.
- [x] **IV. Operator Sovereignty** — `URATEAM_DISABLE_TRIAGE_V2=true`
      env-var escape hatch falls back to the v1 prompt + schema. Default
      is v2 enabled. The toggle is documented in CLAUDE.md and the spec.
- [x] **V. Audit What Matters Operationally** — no new audit-event types in
      this scope. Tier 1d count stays at 51. The audit event for triage
      quality (`pm.triage_quality_score`) is Tier 6e and deferred.
- [x] **VI. Fail Visibly With Classification** — triage failures already
      handled by the existing try/catch in `triageNewIssues` (returns
      `null`, logs error). v2 prompt failures (zod-parse errors on the
      new optional fields) silently fall back to v1-shaped output via
      `.optional()` semantics — visible in logs but non-fatal.
- [x] **VII. Reversible vs One-Way Doors** — fully reversible. No DB
      schema mutations, no public-API removals (additions only), no
      credential rotations, no cross-cutting refactors. The env-var
      escape hatch + optional schema fields mean a v2 prompt that
      misbehaves can be rolled back without redeploy.

> All checks pass. Proceeding to Phase 0.

## Project Structure

### Documentation (this feature)

```text
specs/001-triage-v2/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/
│   └── triage-result.schema.md   # Zod schema as a contract doc
├── checklists/
│   └── requirements.md  # Already produced by /speckit-specify
└── tasks.md             # /speckit-tasks output (not /speckit-plan)
```

### Source Code (repository root)

```text
packages/core/src/
├── pm/
│   ├── actions/
│   │   ├── triage.ts                  # Modify — wire v2 prompt
│   │   ├── triage-prompt.ts           # NEW — extracted prompt template
│   │   └── triage-render.ts           # NEW — Linear comment + description
│   │                                  #       renderer for the new fields
│   ├── types.ts                       # Modify — extend TriageResult
│   └── ...
├── executor/
│   └── prompt/
│       └── schema-mapper.ts           # Modify — parse new sections from
│                                     #          description (optional);
│                                     #          falls back to v1 shape
└── __tests__/
    ├── triage.test.ts                 # Modify — regression: v1 still
    │                                 #          works when v2 disabled
    ├── triage-v2-prompt.test.ts       # NEW — prompt structure snapshot
    ├── triage-v2-schema.test.ts       # NEW — extended schema validation
    └── triage-v2-render.test.ts       # NEW — comment + description render
```

**Structure Decision**: Extract the v2 prompt template into a sibling
`triage-prompt.ts` so it can be unit-tested independently (snapshot test
on the prompt string for the standard input shape). Extract the Linear
comment + description rendering into a sibling `triage-render.ts` so the
Linear-API-touching code in `triage.ts` stays focused on flow and the
rendering is pure-function-testable. Schema additions land in
`pm/types.ts` next to the existing `TriageResult`. Reuses the existing
`parseJsonObject()` parser and `callClaude` injection seam — no new
abstractions.

## Complexity Tracking

*Fill ONLY if Constitution Check has violations that must be justified*

No violations. This section intentionally left empty.

## Phase 0 — Research

See [`research.md`](./research.md) for the full output. Summary:

- **Decision**: Use Anthropic's published prompt-engineering primitives —
  XML-delineated sections, role + audience priming, scratchpad CoT before
  structured output, multishot examples (2 positive + 1 anti-example per
  pipeline label), JSON prefill (`{` anchor at the response opening).
- **Rationale**: Each primitive is independently validated by Anthropic's
  internal evaluations as adding measurable improvement to structured-
  output reliability. Stacking them is additive.
- **Multishot sizing**: 4 pipeline labels × (2 positive + 1 anti-example)
  = 12 examples total, ~2.5K tokens. Adds ~3K to prompt prefix; cached
  for the lifetime of a PM tick. Per-issue marginal cost is ~600 output
  tokens (the new fields).
- **Cache-prefix sizing**: Anthropic prefix cache TTL is 5 min. PM tick
  interval default is 30 min, so most ticks pay the prefix-creation cost.
  Mitigation: process all issues in a tick in a single batch (existing
  behavior — `runInBatches` with size 3) so the prefix is paid once per
  tick. No code change needed; current batching is already optimal here.
- **Alternatives considered**:
  - Multi-call spec-kit-style decomposition per issue (rejected — 5–10x
    cost per triage; unacceptable for hot-path code).
  - Switching to Sonnet for triage (rejected — 3–5x cost per call; Haiku
    is sufficient with better prompting; revisit if regression-rate is
    high after v2 ships).
  - Structured output via Anthropic's tool-use schema (rejected — adds
    latency for negligible gain over JSON prefill; would also require
    upgrading the SDK invocation pattern).

## Phase 1 — Design & Contracts

### Entities and Schema Diff

See [`data-model.md`](./data-model.md) for the full diff. Summary:

- `TriageResult` (existing) gains 5 optional fields:
  - `assumptions?: string[]` (max 10)
  - `examples?: Array<{ scenario: string; expected: string }>` (max 3)
  - `affectedFiles?: string[]` (max 20)
  - `testStrategy?: { unit?: string; integration?: string }`
  - `riskAssessment?: { severity: "low" | "medium" | "high"; areas: string[] }`
    (areas max 5)
- New zod schema `TriageV2ExtensionsSchema` validates the new fields with
  `.optional()` semantics. Excess entries silently truncated via
  `.max(N)`. Wrong-typed elements rejected at parse time.
- No changes to `pipeline_runs`, `audit_events`, or any other DB-backed
  table. No new audit-event types.

### Contracts

See [`contracts/triage-result.schema.md`](./contracts/triage-result.schema.md):

- The v2 zod schema as the source of truth for what the Haiku call must
  produce.
- The Linear comment markdown contract (section headers, ordering, empty-
  field placeholder).
- The issue-description append contract (which sections triage appends to
  the description so the implement stage's `parseAcceptanceCriteria` and
  the future schema-mapper extensions can read them).
- The env-var escape-hatch contract (`URATEAM_DISABLE_TRIAGE_V2`,
  case-sensitive `"true"` match — mirrors `URATEAM_DISABLE_*_GATE`).

### Triage Prompt Template Skeleton

See [`research.md`](./research.md) for the full draft. Skeleton:

```text
<role>
You are a senior engineer triaging this issue for a downstream Claude
coding agent that will implement it without human supervision...
</role>

<repo_context>
Repository: {{repoUrl}}
Default branch: {{defaultBranch}}
Existing pipeline labels: auto-implement | bug | quick-fix | needs-design
Constitution: principles I–VII (see .specify/memory/constitution.md)
</repo_context>

<output_format>
Respond with a JSON object matching this shape — no markdown, no prose,
just the JSON. (Format spec elided here; see contracts/.)
</output_format>

<examples>
<!-- 2 positive + 1 anti-example per pipeline label, 12 total -->
</examples>

<issue>
Issue ID: {{issueId}}
Title: {{title}}
Description: {{sanitizedDescription}}
</issue>

<reasoning>
[The model thinks step-by-step here before emitting the JSON.]
</reasoning>

{
```

The trailing `{` is the JSON prefill anchor.

### Linear Comment Renderer (pure function)

```text
function renderTriageComment(result: TriageResult, opts: {
  forceNeedsDesign: boolean;
  pipelineLabel: string;
}): string
```

- Renders today's comment shape (priority / complexity / labels / pipeline /
  rationale / AC / approach / open questions / anti-AC) plus the four new
  sections (Assumptions / Examples / Affected Files / Risk Assessment).
- Empty fields render `(none)` placeholder per FR-004.
- Returns the markdown body for `linearClient.createComment`.

### Issue Description Appender (pure function)

```text
function appendTriageSectionsToDescription(existingDesc: string, result: TriageResult): string
```

- Appends `**Acceptance Criteria:**`, `**Examples:**`, `**Affected Files:**`,
  `**Test Strategy:**`, `**Risk Assessment:**` sections to the issue
  description. Skips sections already present (idempotent — operator
  re-triage doesn't duplicate sections).
- Operator-readable markdown so even the implement agent's raw description
  is well-structured.

### Env-var Fallback Shape

```text
function isV2Disabled(env: NodeJS.ProcessEnv = process.env): boolean
```

- Returns `env.URATEAM_DISABLE_TRIAGE_V2 === "true"` (strict equality on
  `"true"`).
- When `true`, the v1 prompt (current behavior) is used and the v2 schema
  parser is skipped. The Tier-4 fields (`approachSummary`, `openQuestions`,
  `antiAcceptanceCriteria`) remain in v1 — the toggle is only about the
  five Tier-6b additions.

### Prediction-Quality Utility (Story 4)

```text
function computeAffectedFilesPredictionQuality(predicted: string[] | undefined, actualDiff: string[]): {
  predicted: number;
  actual: number;
  intersection: number;
  missed: string[];
  unexpected: string[];
  hasV2Prediction: boolean;
}
```

- Pure function in `pm/triage-prediction-quality.ts`. No DB writes (Tier 6e
  is the writer; this is the computation primitive).
- Returns `{ hasV2Prediction: false, ... }` when `predicted` is undefined
  (v1 triage), so callers can detect gracefully.

### Implement-Stage Consumption

- No code change to `executor/prompt/templates.ts` in this PR. The new
  sections appear in the issue description (via the appender above), and
  the existing implement template includes the description in the prompt
  verbatim — so the new fields naturally reach the implement agent.
- Future polish (deferred): extend `executor/prompt/schema-mapper.ts` to
  parse the new sections into structured fields on the implement
  template's `issue` object, then surface them as dedicated XML blocks
  in the implement prompt. Out of scope for Tier 6b.

### Agent Context Update

Per Phase 1 step 3 of the plan template, update the SPECKIT marker in
CLAUDE.md to point at this `plan.md` so subsequent skill invocations and
re-readers find the current plan.

## Phase 2 — Implementation Outline

*This section is summary-only; the bite-sized tasks are produced by
`/speckit-tasks` and saved to [`tasks.md`](./tasks.md).*

Order of work (each step has verification):

1. **Schema additions** (`pm/types.ts` + new zod schema). Verify:
   `pnpm --filter @urateam/core test src/__tests__/triage-v2-schema.test.ts`.
2. **Prompt template extraction** (`pm/actions/triage-prompt.ts`). Verify:
   `pnpm --filter @urateam/core test src/__tests__/triage-v2-prompt.test.ts`
   (snapshot test on the rendered prompt).
3. **Renderer extraction** (`pm/actions/triage-render.ts`). Verify:
   `pnpm --filter @urateam/core test src/__tests__/triage-v2-render.test.ts`.
4. **Triage action wiring** (`pm/actions/triage.ts`). Verify:
   `pnpm --filter @urateam/core test src/__tests__/triage.test.ts`
   (regression: existing tests still pass; new env-var toggle works).
5. **Env-var escape hatch** (`pm/actions/triage.ts` boundary). Verify:
   `pnpm --filter @urateam/core test src/__tests__/triage-v2-env-toggle.test.ts`.
6. **Prediction-quality utility** (`pm/triage-prediction-quality.ts`).
   Verify: `pnpm --filter @urateam/core test src/__tests__/triage-v2-prediction.test.ts`.
7. **CLAUDE.md update** — document new fields, env var, comment template.
   Verify: `pnpm --filter @urateam/core test src/__tests__/audit-immutability.test.ts`
   (Tier 1d guard stays green; no new event types).
8. **Workspace sweep**: `pnpm -w typecheck` + `pnpm --filter @urateam/core test`
   green.
9. **PR + Sonnet review** per Constitution Workflow.

## Risks and Mitigations

- **Prompt regression**: a v2 prompt that performs worse than v1 silently
  degrades every new triage. *Mitigation*: snapshot tests on the rendered
  prompt + dogfood smoke test before flipping default + env-var rollback.
- **Multishot pollution** (model copies examples verbatim): mitigated by
  explicit instruction "These are reference examples, not your output"
  inside the `<examples>` block and validated via snapshot tests.
- **Token blowup**: per `Technical Context`, hard cap on prefix is 15K
  tokens. Snapshot test on prompt rendering asserts character-count
  ceiling.
- **Schema parse failure on Haiku output**: zod `.optional()` + element-
  level filters ensure partial output still produces a valid v1-shaped
  `TriageResult`. Worst case: a v2 run produces v1-quality output, which
  is a degradation only relative to v2 — never worse than current.

## Validation

- Spec-level: `requirements.md` checklist all green (already validated).
- Plan-level: Constitution Check all green (above).
- Implementation-level: `/speckit-tasks` will encode per-task verification
  per Principle II.
