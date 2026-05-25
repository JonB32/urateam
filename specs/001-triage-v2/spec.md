# Feature Specification: Triage v2 — Structured Requirements for Autonomous Coding Agents

**Feature Branch**: `001-triage-v2`

**Created**: 2026-05-13

**Status**: Draft

**Input**: User description: "Triage v2 — restructured triage prompt + extended `TriageResult` fields to produce spec-kit-quality structured requirements for downstream Claude coding agents (Tier 6a + 6b of the codebase-optimization roadmap)."

## Constitution Alignment *(mandatory — Principles I + II)*

> Per Principle I (Specify Before Implementing): this spec is the
> required structured-requirements artifact for the feature; downstream
> implement tasks may not begin without it.
>
> Per Principle II (Verification Before Completion): every acceptance
> scenario below MUST be expressed in Given/When/Then form so the
> implementation has an explicit test contract to satisfy.

- **Open questions resolved?** Yes — no `[NEEDS CLARIFICATION]` markers required;
  all scope decisions documented in Assumptions below.
- **Reversibility class** (Principle VII): **Reversible**. No DB schema mutations,
  no new audit-event types (deferred to Tier 6e), schema additions are
  optional/backwards-compatible, and an `URATEAM_DISABLE_TRIAGE_V2=true` escape
  hatch lets operators revert to the v1 prompt without redeploy.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Operator reads a Linear comment that has everything they need to approve work (Priority: P1)

The operator opens a freshly-triaged Linear ticket and finds, in addition to today's
acceptance-criteria list, four new clearly-headed sections: **Assumptions** (what
the agent will take for granted), **Examples** (concrete scenarios the agent will
verify), **Affected Files** (the agent's best guess at scope), and **Risk
Assessment** (severity + the subsystems the agent thinks it'll touch). The
operator either approves the routing as-is or corrects one of these before any
implement-stage tokens are spent.

**Why this priority**: This is the single highest-leverage improvement for
autonomous-PR quality. Triage tokens are the cheapest in the run; the
implement-stage tokens that follow are the most expensive. Catching a wrong
assumption or out-of-scope affected-file at the cheap stage saves ~95% of the
cost of an incorrect-but-confident PR. Operator trust in the autonomous
pipeline depends on being able to glance at a Linear ticket and decide whether
to let the agent proceed.

**Independent Test**: Trigger triage on a synthetic Linear issue via the PM
Agent test harness; assert the resulting Linear comment contains all five
sections (existing ACs + four new ones) with non-empty content.

**Acceptance Scenarios**:

1. **Given** a Linear issue with a clear problem description, **When** the PM Agent
   triages it as `auto-implement`, **Then** the Linear comment posted by triage MUST
   contain four new markdown sections (`### Assumptions`, `### Examples`,
   `### Affected Files`, `### Risk Assessment`) populated by the triage output.
2. **Given** a triage result with all five new fields populated, **When** the operator
   reads the Linear comment, **Then** every list MUST be non-empty (≥ 1 assumption,
   ≥ 1 example, ≥ 1 affected-file path, exactly one severity classification with
   ≥ 1 area).
3. **Given** an issue that the operator wants to redirect because triage's
   `affectedFiles` is wrong, **When** the operator adds the `needs-design` label
   manually, **Then** the existing routing gate honors it (no behavior change here;
   this scenario verifies backwards compatibility with the Tier 4 routing).

---

### User Story 2 — Downstream coding agent receives concrete examples instead of vague ACs (Priority: P1)

The implement stage's Claude coding agent receives the issue description + ACs
from the Linear webhook. With triage v2, the same description now carries
explicit input/output example pairs that the agent uses to anchor test
scaffolds and verify behavior. The agent's output PR contains code grounded in
the example scenarios, with tests that mirror the example structure.

**Why this priority**: Vague ACs are the dominant cause of incorrect-but-
confident PRs. Concrete examples are the single most effective prompt-
engineering technique for narrowing model output to the operator's intent.
This unlocks dramatically higher first-pass review-pass rates without
increasing per-issue token cost (examples live in the issue body, prefix-cached
across all stages).

**Independent Test**: Construct a `TriageResult` with two `examples` entries
and run the implement-template renderer; assert the rendered prompt contains
both example scenarios verbatim and references them in the verification
instructions.

**Acceptance Scenarios**:

1. **Given** a `TriageResult` carrying `examples: [{scenario, expected}]`, **When** the
   implement-template assembler builds the implement-stage prompt, **Then** every
   example MUST appear verbatim inside the prompt under a clearly-headed
   `<examples>` block.
2. **Given** a `TriageResult` with `examples: []` (or absent), **When** the implement
   template runs, **Then** the prompt MUST render without an empty `<examples>`
   block and the agent MUST not produce a "no examples provided" warning — graceful
   degradation back to the v1 prompt behavior.
3. **Given** a `TriageResult` with `testStrategy: { unit: "src/__tests__/foo.test.ts" }`,
   **When** the implement template runs, **Then** the prompt MUST instruct the agent
   to start its test scaffold from the named file.

---

### User Story 3 — Operator-controlled rollback within one release (Priority: P1)

If the new triage prompt produces a regression on the live dogfood (worse
classification accuracy, malformed JSON, or unexpected token blowup), the
operator can flip a single env var (`URATEAM_DISABLE_TRIAGE_V2=true`) and the
next PM tick falls back to the v1 prompt + schema with no redeploy. The operator
can leave this in place until the next release ships a fixed prompt; no Linear
data is lost (the new fields are optional and absent fields render as empty
sections in the comment).

**Why this priority**: Operator Sovereignty (Constitution Principle IV) requires
that every new autonomous behavior ship with an explicit toggle. The triage
prompt is in the hot path of every Linear issue; without a runtime escape hatch,
a regression here silently degrades every new ticket for the duration of the
incident.

**Independent Test**: Set the env var, run the PM Agent's triage action against
a synthetic issue, assert the v1 prompt is invoked (via a snapshot of the
prompt text or a captured-call assertion on the prompt builder).

**Acceptance Scenarios**:

1. **Given** `URATEAM_DISABLE_TRIAGE_V2=true`, **When** the PM Agent triages an
   issue, **Then** the triage action MUST use the v1 prompt template and the v1
   `TriageResult` schema (no new optional fields parsed).
2. **Given** the env var is unset (default), **When** the PM Agent triages an
   issue, **Then** the v2 prompt MUST run and the new fields MUST be parsed when
   present in the model output.
3. **Given** the env var is set to any value other than `"true"` (including
   `"1"`, `"yes"`, empty string), **When** the PM Agent triages an issue, **Then**
   the v2 prompt MUST run (only the exact string `"true"` disables; mirrors the
   existing `URATEAM_DISABLE_*_GATE` env-var pattern).

---

### User Story 4 — Triage prediction error becomes a quality signal (Priority: P2)

When the agent's implement-stage diff touches files that triage's
`affectedFiles` field did not predict (or fails to touch files it did predict),
that mismatch becomes a measurable, queryable quality signal. This is a
foundation for Tier 6e (the triage-quality feedback loop) without requiring 6e
to ship in this scope.

**Why this priority**: Lower priority than P1 stories because it's a
foundation, not user-visible value yet. But it's worth doing now (rather than
Tier 6e-only) because the data shape is set here.

**Independent Test**: After an auto-implement run completes, compute
`{predicted, actual, intersection, missed, unexpected}` from the run's
`TriageResult.affectedFiles` and the run's actual diff; assert the computation
is non-throwing for empty / null / partial inputs.

**Acceptance Scenarios**:

1. **Given** a run where `affectedFiles` was `["a.ts", "b.ts"]` and the actual diff
   touches `["a.ts", "c.ts"]`, **When** the operator queries triage prediction quality
   for that run, **Then** the result MUST be `{predicted: 2, actual: 2,
   intersection: 1, missed: ["b.ts"], unexpected: ["c.ts"]}`.
2. **Given** a run where `affectedFiles` is absent (v1 triage), **When** the operator
   queries prediction quality, **Then** the result MUST gracefully indicate
   "v1 triage — no prediction" without throwing.

---

### Edge Cases

- **Haiku returns malformed JSON for the new fields**: existing parser uses
  `parseJsonObject()`. If new fields are missing or wrong-typed, zod's
  `.optional()` should drop them and triage continues with v1-shaped output.
  Test must cover: `assumptions: null`, `examples: "not an array"`,
  `affectedFiles: [42, 17]` (wrong element type).
- **Haiku returns >3 examples or >20 affected files**: the schema caps both at
  parse time (zod `.max(3)` and `.max(20)`). Excess entries MUST be silently
  truncated, not rejected.
- **`riskAssessment.severity` returns an unknown value** (e.g., `"critical"`):
  zod enum MUST reject; triage falls back to "medium" default.
- **Multishot examples pollute the agent's reasoning** (the model copies an
  example output verbatim instead of producing fresh output): mitigation
  documented in plan via XML-tag scoping and explicit "These are reference
  examples, not your output" instruction in the prompt prefix.
- **Token budget overflow on long issues**: triage Haiku prompt with multishot
  examples + repo-context preamble approaches the 200K context window. Spec
  assumes the issue body fits in the remaining budget for any reasonable
  Linear issue; explicit cap on context-preamble size enforced in plan.
- **Prompt prefix cache invalidation**: changing the multishot examples
  invalidates the prefix cache across all PM ticks for ~5 minutes. Spec
  assumes this is acceptable cost paid once per release.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The triage action MUST emit a `TriageResult` zod-shape that adds
  five optional fields beyond the Tier-4 schema: `assumptions: string[]`,
  `examples: Array<{scenario: string; expected: string}>`, `affectedFiles:
  string[]`, `testStrategy: {unit?: string; integration?: string}`,
  `riskAssessment: {severity: "low" | "medium" | "high"; areas: string[]}`.
- **FR-002**: The triage prompt MUST use Anthropic prompt-engineering
  practices: XML-delineated sections, role + audience priming, scratchpad
  reasoning before structured output, multishot examples (≥ 2 well-triaged + 1
  anti-example per pipeline label), JSON output prefill.
- **FR-003**: All five new schema fields MUST be optional (`zod .optional()`)
  so existing tests pass without modification.
- **FR-004**: The Linear comment posted by triage MUST render the new fields
  as markdown sections with explicit headers (`### Assumptions`, `### Examples`,
  `### Affected Files`, `### Test Strategy`, `### Risk Assessment`). Empty
  fields render as a single-line `(none)` placeholder, not an empty section.
- **FR-005**: The implement-stage prompt template MUST consume the new fields
  when present and degrade gracefully when absent — output equivalent to the
  pre-Tier-6 prompt when all new fields are missing.
- **FR-006**: `URATEAM_DISABLE_TRIAGE_V2=true` MUST short-circuit the v2
  prompt and schema, falling back to the v1 path. Any other value MUST run v2
  (matches the existing `URATEAM_DISABLE_*_GATE` env-var conventions).
- **FR-007**: The triage prompt's multishot examples MUST include at least one
  per pipeline label (`auto-implement`, `bug`, `quick-fix`, `needs-design`) so
  the model sees a complete signal for each classification path.
- **FR-008**: Schema bounds: `assumptions.length ≤ 10`, `examples.length ≤ 3`,
  `affectedFiles.length ≤ 20`, `riskAssessment.areas.length ≤ 5`. Excess
  entries MUST be silently truncated by zod (`.max(N)`).
- **FR-009**: The schema additions MUST not break the Tier 1d
  audit-event-count guard; this feature ships no new audit events.
- **FR-010**: CLAUDE.md MUST document the new fields under the PM Agent
  section, the `URATEAM_DISABLE_TRIAGE_V2` escape hatch, and the comment
  template that triage now produces.

### Key Entities

- **`TriageResult` (extended)**: the typed result of one triage Haiku call.
  Existing fields (classification, AC list, `approachSummary`, `openQuestions`,
  `antiAcceptanceCriteria`) + five new optional fields per FR-001.
- **Linear comment template (extended)**: the markdown body the triage action
  posts to the Linear issue, now with five additional headed sections per
  FR-004.
- **Implement-stage prompt template (extended)**: the prompt assembler at
  `executor/prompt/implement-template.ts` reads the new fields from the
  handoff payload and renders them into the implement prompt.
- **Triage prompt template (rebuilt)**: the prompt text the PM Agent Haiku
  call receives. Replaced with the v2 structure per FR-002; v1 retained as a
  fallback path per FR-006.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Every newly-triaged Linear issue on the dogfood that routes to
  `auto-implement` / `bug` / `quick-fix` carries non-empty `assumptions` and
  `examples` in 90%+ of cases within the first week of release. Verifier:
  query `SELECT count(*) FROM pipeline_runs WHERE created_at > <release-time>`
  vs the count of audit log entries showing a v2-shaped triage payload.
- **SC-002**: The implement-stage prompt for a triage-v2-shaped issue is at
  least 15% longer than its v1 counterpart (the new fields consume real prompt
  budget) but the cache-hit ratio on the prompt prefix stays above 80% in PM
  ticks. Verifier: per-stage `cache_read_input_tokens / cache_creation_input_tokens`
  on the implement stage.
- **SC-003**: The operator can flip the env-var escape hatch on a running
  dogfood and the next PM tick uses the v1 prompt within 30 minutes (cron
  interval), with no daemon restart required. Verifier: live dogfood test.
- **SC-004**: At least one merged PR shipped by the autonomous pipeline using
  the v2 prompt cites a triage `example` scenario in its test scaffold.
  Verifier: grep `grep -l "scenario:" packages/*/src/__tests__/*.test.ts` against
  the merged PR's diff and the source `TriageResult` JSON.
- **SC-005**: Zero regression on the existing triage test suite. Verifier:
  `pnpm --filter @urateam/core test src/__tests__/triage*.test.ts` passes
  after the change with no flakiness across 3 runs.

## Assumptions

- **Triage stays a single Haiku call**: no per-issue spec-kit-style multi-call
  loop. Concrete-examples-up-front via multishot prompting is the
  prompt-engineering technique that lets a single call produce structured
  output reliably enough.
- **Haiku 4.5 can produce the new fields**: validated by an opt-in dogfood
  test before flipping the default. If Haiku 4.5 is insufficient on a
  specific issue shape (very long bodies, very small bodies), zod's optional
  fields naturally degrade — the v1 fields are still required and the model
  produces them.
- **The prefix-cache investment pays off**: multishot examples add ~3K tokens
  to the prompt prefix; this is a one-time cost per PM tick (cache TTL 5 min)
  and a negligible per-issue cost (the prefix caches across all triage calls
  in the same tick).
- **No new audit-event types**: Tier 6e is the explicit follow-up that adds
  `pm.triage_quality_score`. This spec ships the data shape (Story 4) so 6e
  can compute the score without further schema changes.
- **No new Linear API calls**: 6c (auto-decomposition) is deferred. This spec
  uses only the existing `issueUpdate` (for the comment) and `webhookCreate`
  (for routing) surfaces.
- **`affectedFiles` is best-effort, not authoritative**: the agent is free to
  touch additional files at implement time; the prediction error is a
  quality signal (Story 4), not a gate.
- **Operator reviews the Linear comment**: this spec is built around the
  operator using the new fields as a quick-glance decision aid. Operators
  who don't read Linear comments won't see the benefit, but the implement
  agent still consumes the structured fields downstream.
- **Cost guard remains**: the existing `policy.cost_exceeded` gate (Tier 4.6)
  still bounds runaway triage cost. v2's longer prompt does not bypass this.
- **Test stability**: snapshot tests on the v2 prompt are tolerated as the
  primary regression-detection mechanism for prompt drift; the team is
  comfortable updating snapshots when intentional prompt changes ship.

## Dependencies

- **Spec-kit toolchain installed and operating** (`.specify/` directory,
  `/speckit-*` commands).
- **urateam Constitution v1.0.0** ratified at `.specify/memory/constitution.md`
  (this spec aligns with Principles I–VII).
- **Existing Tier 1–5 gates remain in force** through the change; the new
  triage output passes through the same scratch-file / typecheck /
  spec-vs-impl / convention gates at implement time.
- **Existing `parseJsonObject()` helper** in `pm/actions/agent-stream.ts`
  is the JSON extraction primitive the v2 schema parser uses.
- **Existing `consumeAgentStream()` helper** with no-tool Haiku session
  shape (`message.message`) is the streaming primitive triage v2 uses.
