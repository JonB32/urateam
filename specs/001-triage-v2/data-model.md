# Data Model: Triage v2

**Date**: 2026-05-13

**Scope**: Schema diff for the `TriageResult` interface (and its zod
companion) introduced by Triage v2 (Tier 6b). **No DB schema changes.**

## TriageResult Diff

### Before (v1, current shape in `packages/core/src/pm/types.ts`)

```typescript
export interface TriageResult {
  issueId: string;
  priority: number;
  labels: string[];
  complexity: "trivial" | "small" | "medium" | "large";
  rationale: string;
  acceptanceCriteria: string[];
  approachSummary?: string;          // Tier 4
  openQuestions?: string[];          // Tier 4
  antiAcceptanceCriteria?: string[]; // Tier 4
}
```

### After (v2 — additions only)

```typescript
export interface TriageResult {
  // ...all v1 fields unchanged...

  /** Tier 6b — what the agent will take for granted. Operator-correctable
   *  via the Linear comment before implement burns tokens. Max 10. */
  assumptions?: string[];

  /** Tier 6b — concrete input/output pairs that ground the implement
   *  agent's generation. Max 3. */
  examples?: Array<{ scenario: string; expected: string }>;

  /** Tier 6b — best-guess paths the implementation will touch. Compared
   *  against the actual diff at review time as a quality signal. Max 20. */
  affectedFiles?: string[];

  /** Tier 6b — which test file(s) the implement agent should start from
   *  and what shape of assertions to write. */
  testStrategy?: { unit?: string; integration?: string };

  /** Tier 6b — severity classification + the subsystems triage thinks
   *  the change touches. Feeds the cost gate and the auto-deep-review
   *  default. `areas` max 5. */
  riskAssessment?: { severity: "low" | "medium" | "high"; areas: string[] };
}
```

## Zod Schema (new)

```typescript
const TriageV2ExtensionsSchema = z.object({
  assumptions: z.array(z.string().min(1)).max(10).optional(),
  examples: z.array(
    z.object({
      scenario: z.string().min(1),
      expected: z.string().min(1),
    }),
  ).max(3).optional(),
  affectedFiles: z.array(z.string().min(1)).max(20).optional(),
  testStrategy: z.object({
    unit: z.string().min(1).optional(),
    integration: z.string().min(1).optional(),
  }).optional(),
  riskAssessment: z.object({
    severity: z.enum(["low", "medium", "high"]),
    areas: z.array(z.string().min(1)).max(5),
  }).optional(),
});
```

The schema is composed with the existing v1 parse path: v1 fields parse
first; v2 fields are additive and `.optional()` so a Haiku call that
omits them still produces a valid `TriageResult` (v1-shaped).

## Validation Rules

| Field | Rule | Failure handling |
|---|---|---|
| `assumptions` | `string.min(1)` per element, max 10 total | Wrong-typed elements truncated by the pre-zod `slice` + filter; excess length truncated to 10 |
| `examples[*].scenario` | non-empty string | Element rejected (whole example dropped) |
| `examples[*].expected` | non-empty string | Element rejected (whole example dropped) |
| `affectedFiles` | `string.min(1)`, max 20 | Non-string elements filtered; excess length truncated |
| `testStrategy.unit` | optional non-empty string | Wrong type → field set to undefined |
| `testStrategy.integration` | optional non-empty string | Wrong type → field set to undefined |
| `riskAssessment.severity` | strict enum of `"low" \| "medium" \| "high"` | Unknown value → entire `riskAssessment` dropped (v1 shape continues) |
| `riskAssessment.areas` | `string.min(1)`, max 5 | Excess length truncated |

The parser performs a `slice(0, N)` + filter pass BEFORE invoking zod so
that excess entries silently truncate rather than fail the whole parse
(per `spec.md` FR-008 and edge-case "Haiku returns >3 examples or >20
affected files").

## Persistence

**None.** All Tier 6b fields live in:

1. The Linear issue description (appended as markdown sections by
   `triage-render.ts:appendTriageSectionsToDescription`).
2. The Linear issue comment posted by the triage action.
3. The in-memory `TriageResult` returned to `triageNewIssues`'s caller.

No new database columns. No new audit-event types (Tier 6e is the
follow-up that adds `pm.triage_quality_score`).

## Schema Migration

**None required.** The new fields are optional additions to a TypeScript
interface; no DB schema change. Existing serialized triage results
without the new fields remain valid.

## State Transitions

**N/A.** Triage result is a snapshot value, not a stateful entity.

## Backwards Compatibility

- v1 callers consuming `TriageResult` see no breaking changes (additions
  only).
- Tests that constructed `TriageResult` objects in v1 shape (without the
  new fields) continue to pass.
- The Linear comment rendering shows new sections when fields are
  populated; otherwise the new sections render as `(none)` per FR-004.
- The `URATEAM_DISABLE_TRIAGE_V2=true` env var forces the v1 prompt and
  schema parser, preserving the exact v1 behavior bit-for-bit.
