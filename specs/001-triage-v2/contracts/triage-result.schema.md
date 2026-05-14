# Contract: Triage v2 Output Shape

**Date**: 2026-05-13

**Scope**: The contract between (a) the triage Haiku call, (b) the
Linear comment renderer, (c) the issue description appender, and (d)
downstream consumers (implement template, Tier 6e prediction-quality
utility).

## 1. Haiku → Triage Action

The Haiku call MUST emit a single JSON object matching this shape:

```json
{
  "priority": 1,
  "labels": ["bug", "backend"],
  "complexity": "small",
  "rationale": "Login 500 on submit — fix server-side validation",
  "approachSummary": "Add validator for empty email...",
  "openQuestions": [],
  "antiAcceptanceCriteria": ["Must NOT change session cookie shape"],
  "acceptanceCriteria": [
    "validator/email.ts:validate() called from /auth/login handler",
    "Returns 400 on empty email instead of 500"
  ],
  "assumptions": [
    "Empty email is the only case producing 500 (verified by stack trace)",
    "No other auth endpoints have this bug"
  ],
  "examples": [
    {
      "scenario": "POST /auth/login with body {\"email\": \"\", \"pw\": \"x\"}",
      "expected": "HTTP 400 with error code EMPTY_EMAIL"
    }
  ],
  "affectedFiles": [
    "packages/api/src/routes/auth.ts",
    "packages/api/src/validators/email.ts",
    "packages/api/src/__tests__/auth.test.ts"
  ],
  "testStrategy": {
    "unit": "packages/api/src/__tests__/email-validator.test.ts",
    "integration": "packages/api/src/__tests__/auth.test.ts"
  },
  "riskAssessment": {
    "severity": "low",
    "areas": ["auth", "api"]
  }
}
```

### Parsing Contract

1. The triage action invokes `parseJsonObject(response)` to extract the
   first JSON object from the model output (existing helper).
2. The result is passed through:
   - `slice(0, N)` truncation on every list field per the caps in
     [`data-model.md`](../data-model.md).
   - Element-level filter for strings (drop empty, drop non-string).
   - `TriageV2ExtensionsSchema.safeParse()` — `.optional()` semantics.
3. v2 fields that fail parse are silently dropped; v1 fields parse as
   today.

### Failure Mode Contract

- **Malformed JSON**: triage logs a warn, skips the issue, returns
  `null` (existing behavior unchanged).
- **Missing v1 fields**: triage logs a warn, skips the issue (existing
  behavior unchanged).
- **Missing v2 fields**: triage emits a v1-shaped `TriageResult` (no
  warn — this is the graceful-degradation path).
- **Partially-malformed v2 fields**: triage emits a `TriageResult` with
  only the parseable v2 fields populated.

## 2. Triage Action → Linear Comment

The comment posted by `linearClient.createComment` MUST contain the
following markdown sections in order:

```markdown
🤖 **PM Agent — Triaged**[ (routed to needs-design)]

**Priority:** <1-4> | **Complexity:** <trivial|small|medium|large>
**Labels:** <comma-separated>
**Pipeline:** <auto-implement|bug|quick-fix|needs-design>
**Rationale:** <one-liner>

**Generated Acceptance Criteria:**         [v1 — unchanged]
- <ac-1>
- <ac-2>

**Approach (Tier 4):**                     [v1 — unchanged when present]
<approachSummary>

**Open questions (must be answered before implement):**  [v1 — unchanged]
- <openQuestion-1>

**Anti-acceptance criteria (this should NOT do):**       [v1 — unchanged]
- <anti-ac-1>

### Assumptions                            [v2 — NEW]
- <assumption-1>
- <assumption-2>

### Examples                               [v2 — NEW]
1. **Scenario:** <scenario-1>
   **Expected:** <expected-1>

### Affected Files                         [v2 — NEW]
- packages/api/src/routes/auth.ts
- packages/api/src/validators/email.ts

### Test Strategy                          [v2 — NEW]
- **Unit:** packages/api/src/__tests__/email-validator.test.ts
- **Integration:** packages/api/src/__tests__/auth.test.ts

### Risk Assessment                        [v2 — NEW]
**Severity:** low | **Areas:** auth, api
```

### Empty-Field Placeholder

When a v2 field is absent or empty, render `(none)`:

```markdown
### Assumptions
(none)
```

NOT a missing section, NOT an empty section header. This makes the
operator's eye-scan deterministic.

### Heading-Level Convention

- v1 sections use `**Label:**` for inline emphasis.
- v2 sections use `### Heading` for visual hierarchy. This signals "new
  Tier 6 content" at a glance and is grep-friendly (`grep "^### " <comment>`).

## 3. Triage Action → Issue Description Append

The issue description is mutated only when the relevant section is not
already present (idempotent). The triage action calls
`appendTriageSectionsToDescription(existingDesc, result)`, which:

1. Appends `**Acceptance Criteria:**` (today's behavior — unchanged).
2. Appends `**Examples:**`, `**Affected Files:**`, `**Test Strategy:**`,
   `**Risk Assessment:**` sections — same markdown shape as in the
   comment (above), but using `**Label:**` style for compatibility with
   the existing description-parser's pattern.
3. Skips any section whose marker (`**Label:**`) already appears in the
   existing description. This makes re-triage safe.

### Why `**Label:**` in Description vs `### Heading` in Comment

The existing `parseAcceptanceCriteria` in `executor/prompt/schema-mapper.ts`
matches `**Acceptance Criteria:**` style. Using the same pattern for the
new sections keeps the parser extension trivial (Tier 6b-followup) and
avoids breaking existing AC parsing. The Linear comment uses `### Heading`
for operator-facing visual hierarchy because the comment is human-eyed,
not parsed.

## 4. Implement Template Consumption

For Tier 6b scope: **no code change** to `executor/prompt/templates.ts`.

The implement template includes `issue.description` in its prompt
(`issueDataBlock` in `templates.ts`). When triage v2 has appended the
new sections to the description, those sections naturally reach the
implement agent's prompt.

**Future polish (Tier 6b-followup, deferred)**: extend
`executor/prompt/schema-mapper.ts:parseAcceptanceCriteria` (or sibling
functions) to parse the new sections into structured fields on the
implement template's `issue` object, then render them in dedicated XML
blocks via `templates.ts`. Worth doing only if observed implement-
agent behavior shows the description-only path is insufficient.

## 5. Tier 6e Prediction-Quality Utility

```typescript
function computeAffectedFilesPredictionQuality(
  predicted: string[] | undefined,
  actualDiff: string[],
): {
  predicted: number;
  actual: number;
  intersection: number;
  missed: string[];
  unexpected: string[];
  hasV2Prediction: boolean;
}
```

This is a pure function (no I/O, no DB writes) introduced in Tier 6b
to define the data shape. Tier 6e will use it to compute and persist
quality scores.

### Edge Cases

- `predicted === undefined` (v1 triage) → returns
  `{ hasV2Prediction: false, predicted: 0, actual: actualDiff.length,
  intersection: 0, missed: [], unexpected: actualDiff }`.
- `predicted === []` (v2 triage that didn't populate the field) →
  returns `{ hasV2Prediction: true, predicted: 0, ... }`.
- Path normalization: both `predicted` and `actualDiff` are compared as
  strings; no path-prefix matching, no slash normalization. Caller is
  responsible for providing consistent path shapes.

## 6. Env-Var Escape Hatch

```typescript
function isV2Disabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.URATEAM_DISABLE_TRIAGE_V2 === "true";
}
```

- **Strict equality** on the string `"true"`. Other values (`"1"`, `"yes"`,
  empty string, undefined) MUST NOT disable v2.
- When `isV2Disabled() === true`:
  - `triage-prompt.ts:buildTriagePrompt()` returns the v1 prompt string.
  - `triage-render.ts:renderTriageComment()` skips the v2 sections.
  - `triage-render.ts:appendTriageSectionsToDescription()` appends only
    the v1 sections (`**Acceptance Criteria:**`).
  - The v2 schema parser does not run.
- The env var is read at function call time, not module load time. This
  enables operators to flip the toggle and have the next PM tick honor
  it without a daemon restart.

## 7. Backwards Compatibility

- All v1 test expectations continue to pass when v2 is disabled.
- All v1 test expectations continue to pass when v2 is enabled but the
  Haiku response is v1-shaped (all v2 fields optional).
- The Linear comment's v1 sections render identically when v2 is enabled.
- The issue description's `**Acceptance Criteria:**` section renders
  identically.
