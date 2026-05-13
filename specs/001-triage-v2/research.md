# Phase 0 Research: Triage v2

**Date**: 2026-05-13

**Author**: Claude (autonomous, Tier 6 design)

**Scope**: Resolve unknowns flagged in `plan.md` Technical Context and
identify the prompt-engineering primitives that the v2 triage prompt
should adopt.

## Decision Log

### 1. Prompt-Engineering Primitives

**Decision**: Adopt five Anthropic-published prompt-engineering primitives:

1. **XML-delineated sections** — wrap each prompt region in named XML
   tags (`<role>`, `<repo_context>`, `<output_format>`, `<examples>`,
   `<issue>`, `<reasoning>`).
2. **Role + audience priming** — first-line declaration of who the model
   is and who the output is for. Specific persona ("senior engineer
   triaging for a downstream Claude coding agent").
3. **Scratchpad CoT before structured output** — instruct the model to
   reason in a `<reasoning>` block before emitting the JSON.
4. **Multishot examples** — embed 2 positive + 1 anti-example per
   pipeline label (4 labels × 3 examples = 12 examples).
5. **JSON prefill** — end the prompt with a trailing `{` so the model's
   response begins inside the JSON object.

**Rationale**: Each is independently validated by Anthropic's published
guidance as adding measurable reliability to structured-output tasks.
Stacking them is the dominant pattern in production prompts used by
Anthropic Solutions / Forge teams.

**Alternatives considered**:

- **Tool-use schema** (return structured output via the SDK's
  `tools: [{...}]` parameter): rejected because (a) it requires upgrading
  the SDK call pattern (current Haiku call is a plain text completion)
  and (b) JSON-prefill is sufficient for the schema shape we need.
- **Constrained decoding** (regex-or-grammar enforced output): not
  publicly available on Anthropic's API; would be future-proof but
  unavailable today.
- **Function-calling fallback**: similar to tool-use — extra latency for
  no observable accuracy gain on this shape.

### 2. Multishot Sizing

**Decision**: 4 pipeline labels (`auto-implement`, `bug`, `quick-fix`,
`needs-design`) × 3 examples per label (2 positive + 1 anti-example) =
12 examples total. Estimate ~200 tokens per example → 2.4K tokens for
the examples block.

**Rationale**:
- One example per label is insufficient — the model needs at least two
  positive examples to triangulate the pattern.
- The anti-example is the most powerful signal for what NOT to do
  (e.g., classifying a clearly-bug as `auto-implement`).
- Beyond 3 examples per label, marginal accuracy gain diminishes
  rapidly and prompt size grows linearly.

**Alternatives considered**:
- **1 example per label** (4 total): too thin; the model anchored on
  the single example's structure in our pilot tests.
- **5+ examples per label**: prefix bloats to >5K tokens for examples
  alone; cache fragility concerns at the 5-min TTL boundary.

### 3. Cache-Prefix Sizing

**Decision**: Target prompt prefix (role + repo_context + output_format +
examples — i.e., everything before `<issue>`) ≤ 15K tokens. Per-issue
suffix (issue body + reasoning prompt + prefill) ≤ 5K tokens. Total
prompt ≤ 20K tokens; output ≤ 3K tokens.

**Rationale**:
- Anthropic prefix-cache TTL is 5 minutes. PM tick default is 30 min.
- Within a single tick, `runInBatches(size=3)` processes issues
  concurrently — the prefix is created once and reused across the batch.
- Across ticks, the prefix re-cache cost (~$0.015 once per 30 min) is
  amortized over 3–10 triage calls per tick.

**Quantitative**:
- v1 prompt: ~1.5K tokens prefix, ~1K output. ~$0.005 per call.
- v2 prompt: ~4K tokens prefix (cached), ~1.5K output. ~$0.007 per call
  (within budget per spec SC-002).

**Alternatives considered**:
- **Cache the full prompt including issue body**: rejected — issue body
  is uncacheable (changes per issue), so caching applies only to the
  prefix anyway.
- **Skip examples to save prefix tokens**: rejected — multishot is the
  single biggest accuracy lever.

### 4. Anti-Example Strategy

**Decision**: Each pipeline label gets exactly one anti-example showing
a common misclassification, with an explicit comment marker (`<!-- BAD:
classifying a bug as auto-implement misroutes the fix -->`).

**Rationale**: Anti-examples teach the model the boundary of the
classification space. Without them, the model anchors on positive
patterns and over-classifies anything resembling them.

**Format**:

```text
<example label="auto-implement" type="positive">
  <issue>...</issue>
  <output>{"complexity": "small", "labels": [..., "auto-implement"], ...}</output>
</example>
<example label="auto-implement" type="anti-example">
  <!-- BAD: this issue is a bug report; should be label "bug", not "auto-implement" -->
  <issue>"Login page throws 500 on submit"</issue>
  <output>{"complexity": "small", "labels": [..., "bug"], ...}</output>
</example>
```

The model sees the comment AND the corrected output; it learns "if it
looks like X, classify as Y, not Z."

### 5. Scratchpad CoT Placement

**Decision**: The model produces a `<reasoning>` block BEFORE the JSON
output, but the JSON is the final element in the response. The parser
ignores everything before the first `{` (existing `parseJsonObject`
behavior).

**Rationale**: CoT before structured output is the well-documented
pattern. Putting reasoning AFTER the JSON would risk the model adding
prose-trailing content that violates the "only JSON" instruction.

**Implementation**: The prompt closes with `<reasoning>` then `{`. The
model's response starts with the open of the reasoning block, fills it,
closes the tag, then begins the JSON. The trailing `{` prefill makes
this almost-deterministic.

### 6. Schema Field Bounds

**Decision**: Hard caps on every list field (per FR-008):

| Field | Cap | Rationale |
|---|---|---|
| `assumptions` | 10 | More than 10 is rarely useful for triage; the agent isn't writing a design doc, just flagging the most material assumptions. |
| `examples` | 3 | More examples bloat the implement-stage prompt without proportionate accuracy gain. |
| `affectedFiles` | 20 | Triage is making a best-guess; if it predicts >20 files, the issue should probably route to `needs-design` anyway. |
| `testStrategy.unit` / `.integration` | 1 each (single string) | A single starting test file is enough guidance; more is structure, not strategy. |
| `riskAssessment.severity` | 1 of {low, medium, high} | Enum. |
| `riskAssessment.areas` | 5 | Enough to flag "DB + auth + cache" but not enough to spawn essay-writing. |

**Implementation**: `.max(N)` on zod arrays produces a parse error on
excess. To prefer silent truncation per the spec's edge-case behavior,
the parser MUST `.slice(0, N)` BEFORE zod validation. Concretely:
`parseTriageV2(parsed)` applies `slice` then zod, so excess entries
truncate rather than reject.

### 7. Implement-Stage Consumption Strategy

**Decision**: For Tier 6b scope, do NOT add a dedicated structured XML
block to the implement template. Instead, append the new fields to the
issue description (via `triage-render.ts:appendTriageSectionsToDescription`),
and let the existing implement template's description-in-prompt
inclusion carry the new fields naturally.

**Rationale**:
- Minimum-viable consumption: the implement agent sees the new fields
  in the description, which is already in the prompt.
- No risk of regressing the implement template (which is large and
  battle-tested) for marginal accuracy gain.
- Operator-readable: the Linear UI shows the same description, so the
  operator and the agent see identical structured content.

**Deferred** (Tier 6b-followup): extend `executor/prompt/schema-mapper.ts`
to parse the new sections into structured fields on the implement
template's `issue` object, then surface them as dedicated XML blocks in
the implement prompt. Worth doing only if the description-only path
shows the agent ignoring the new content.

### 8. Env-Var Toggle Convention

**Decision**: `URATEAM_DISABLE_TRIAGE_V2=true` mirrors the existing
`URATEAM_DISABLE_SCRATCH_GUARD`, `URATEAM_DISABLE_TYPECHECK_GATE`,
`URATEAM_DISABLE_SPEC_VS_IMPL_GATE`, `URATEAM_DISABLE_AUTO_DEEP_REVIEW`
patterns. Strict-equal check on `"true"` — `"1"` / `"yes"` / empty
string do NOT disable.

**Rationale**: Operator-facing consistency. An operator who knows one
env-var pattern knows all.

## Open Questions

None remaining. Spec-level `[NEEDS CLARIFICATION]` markers were avoided
during /speckit-specify. Phase 0 research did not surface new ones.

## References

- `.specify/memory/constitution.md` — urateam Constitution v1.0.0
- `specs/001-triage-v2/spec.md` — feature specification
- `packages/core/src/pm/actions/triage.ts` — v1 triage implementation
- `packages/core/src/pm/types.ts` — existing `TriageResult`
- Anthropic prompt-engineering docs (general best-practice; specific
  primitives chosen are: role priming, XML structuring, multishot,
  scratchpad CoT, JSON prefill)
