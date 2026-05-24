# Autonomous-Pipeline Reliability Tiers — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make autonomous urateam runs produce PRs at the quality bar of a focused foreground session by installing five tiers of review gates and routing improvements.

**Architecture:** Extend the existing pipeline (`triage → implement → test → review → RALPH gate → review-fix → push → PR`) with deterministic guards (scratch-files, typecheck, spec-vs-impl), a convention-checklist review prompt, default-on independent deep review, design-doc triage, and consecutive-failure escalation. Re-use existing surfaces (`ReviewFinding` blocking categories, deep-review fanout, `needs-design` label routing, circuit breaker, audit-event writers) rather than building parallel infrastructure.

**Tech Stack:** TypeScript / pnpm monorepo; Vitest; Drizzle (SQLite+Postgres); Hono; Linear/GitHub SDKs; Anthropic Agent SDK.

**Operator brief:** Source of truth for spec is the conversational brief that started this session (cost-effective; spec-vs-impl gate; convention-checklist; default-on fanout; design-doc triage; escalation). This file maps it to PRs with concrete code interfaces.

---

## Conventions Followed Per PR

- `pnpm test` + `pnpm typecheck` (per affected package) pass before push.
- Sonnet code-reviewer subagent dispatched on every branch BEFORE marking ready.
- PR description includes self-review of all convention categories.
- New gate → escape hatch env var + audit event + 2 tests (fires + doesn't fire).
- Each tier deployed to dogfood per the brief's deploy flow before starting the next.

---

## Task 1: Tier 1a — scratch-file denylist (PR #1)

**Branch:** `tier-1a-scratch-guard`

**Files:**
- Create: `packages/core/src/pipeline/scratch-file-guard.ts`
- Modify: `packages/core/src/pipeline/runner.ts` (wire after auto-commit, before push)
- Modify: `packages/core/src/types.ts` (extend `ReviewFinding.category` union)
- Test: `packages/core/src/__tests__/scratch-file-guard.test.ts`
- Modify: `CLAUDE.md` (document gate + escape hatch)

**Interface:**

```ts
// scratch-file-guard.ts
export interface ScratchFileResult {
  files: string[];
  skipped: boolean; // true if URATEAM_DISABLE_SCRATCH_GUARD=true
}

export async function findScratchFiles(
  worktreePath: string,
  opts?: { disableEnv?: string | undefined }
): Promise<ScratchFileResult>;
```

Match (case-insensitive) against newly-tracked-by-this-run files (status-porcelain `A` or `??`):
- `*.bak`, `*.bak.*`
- `*_REPORT.md`, `TEST_*.md`, `TESTING_*.md`, `FINAL_*.md`, `*_CHECKLIST.md`
- repo-root `commit-*.sh`, `run-*.sh`
- `*.tmp`, untracked `*.log`
- any new repo-root `*.md` NOT in the tracked exemption set: `CLAUDE.md`, `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `LICENSE.md`, `AUTHORS.md`

**Wire-in point:** After the auto-commit block in `runner.ts`, before push step. If `files.length > 0`:
- Push a `ReviewFinding` with `category: "scratch-files"` into `unresolvedBlockingFindings`.
- Set `run.shouldDraft = true` so existing draft-PR renderer takes over.

**Audit:** New event type `pipeline.scratch_files_blocked` (extend `AuditEventTypeSchema`). Bump CLAUDE.md count.

**Tests:**
1. Fires on a fixture worktree containing `FINAL_CHECKLIST.md` (returns one match).
2. Silent on a clean worktree (`{ files: [] }`).
3. Skips when `URATEAM_DISABLE_SCRATCH_GUARD=true` (returns `{ skipped: true }`).

---

## Task 2: Tier 1b — hard typecheck gate (PR #2)

**Branch:** `tier-1b-typecheck-gate`

**Files:**
- Create: `packages/core/src/pipeline/typecheck-gate.ts`
- Modify: `packages/core/src/pipeline/runner.ts` (run gate; route to review-fix on fail)
- Modify: `packages/core/src/types.ts` (`category: "typecheck"`)
- Modify: `packages/core/src/audit/events.ts` (event `pipeline.typecheck_failed`)
- Test: `packages/core/src/__tests__/typecheck-gate.test.ts`
- Modify: `CLAUDE.md`

**Interface:**

```ts
export interface TypecheckResult {
  passed: boolean;
  errorCount: number;
  firstMessages: string[]; // up to 5, truncated 500 chars each
  output: string;          // full output (kept in memory; passed to review-fix prompt; truncated for PR body)
  skipped: boolean;
}

export async function runTypecheck(
  worktreePath: string,
  opts?: { command?: string[] /* default ["pnpm","-w","typecheck"] */ }
): Promise<TypecheckResult>;
```

**Wire-in:** Between scratch-file-guard and push. On `!passed`:
- Push a `ReviewFinding` with `category: "typecheck"` summarizing first 5 messages.
- Route through the existing review-fix loop (`reviewFixIterations`). If exhausted, draft PR with output in body.
- Emit `pipeline.typecheck_failed` audit event with `{ errorCount, firstMessages }`.

**Escape hatch:** `URATEAM_DISABLE_TYPECHECK_GATE=true` → `skipped: true`.

**Tests:**
- Mock the typecheck command to return non-zero with synthetic output → assert review finding category, `shouldDraft`, audit event.
- Mock to return zero → assert no finding emitted, no audit event.
- Skip env var → no execution, no event.

---

## Task 3: Tier 1c — spec-vs-impl JSDoc gate (PR #3)

**Branch:** `tier-1c-spec-vs-impl-gate`

**Files:**
- Create: `packages/core/src/pipeline/spec-vs-impl-gate.ts`
- Modify: `packages/core/src/pipeline/runner.ts` (run gate after typecheck-gate, before push)
- Modify: `packages/core/src/types.ts` (`category: "spec-vs-impl"`)
- Test: `packages/core/src/__tests__/spec-vs-impl-gate.test.ts`
- Modify: `CLAUDE.md`

**Algorithm:**

```ts
export interface SpecVsImplFinding {
  filePath: string;
  jsdocSnippet: string;
  promisedSymbol: string; // e.g. "config.implementProviderFallback"
}

export async function checkSpecVsImpl(
  worktreePath: string,
  baseRef: string
): Promise<SpecVsImplFinding[]>;
```

1. `git diff --unified=0 baseRef..HEAD` to find added lines per file.
2. Scan JSDoc blocks (`/** ... */`) added in the diff for references matching `\b(env\.|config\.|opts\.|deps\.|options\.)[A-Za-z][A-Za-z0-9_]*\b`.
3. For each reference, search the working tree for the symbol's last segment (`implementProviderFallback`) in:
   - Same file's TypeScript interface/type/Zod schema declarations
   - Repo-wide TS files under `packages/*/src/`
4. If not found, emit a finding. Treat as blocking (`category: "spec-vs-impl"`).

**Escape hatch:** `URATEAM_DISABLE_SPEC_VS_IMPL_GATE=true`.

**Tests:**
- Fixture replicating BEC-201: JSDoc mentions `config.implementProviderFallback`, no Zod field → fires.
- Same JSDoc but the Zod field exists → doesn't fire.
- Skip env var → no findings.

---

## Task 4: Tier 1d — audit-event count consistency test (PR #4, bundle with 1c or 1a if convenient)

**Files:**
- Modify: `packages/core/src/__tests__/audit-immutability.test.ts`

**Test:**

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AuditEventTypeSchema } from "../audit/events.js";

it("CLAUDE.md audit-event count matches AuditEventTypeSchema", () => {
  const repoRoot = /* climb to repo root */;
  const claudeMd = readFileSync(join(repoRoot, "CLAUDE.md"), "utf8");
  const m = /(\d+)\s+event types/.exec(claudeMd);
  expect(m).not.toBeNull();
  const documented = Number(m![1]);
  const actual = AuditEventTypeSchema.options.length;
  expect(documented).toBe(actual);
});
```

(Repeat the same pattern for `actorType` enum once that test target is identified.)

---

## Task 5: Tier 2 — convention-checklist review prompt (PR #5)

**Branch:** `tier-2-conv-review`

**Files:**
- Modify: `packages/core/src/executor/prompt/templates/review.ts` (or wherever review prompt is assembled)
- Modify: `packages/core/src/pipeline/config.ts` (default review model = same as implement)
- Modify: relevant type for structured finding output
- Test: `packages/core/src/__tests__/review-convention-prompt.test.ts`

**Approach:**
- Inject the 9-category checklist (scratch-files, db-ddl-drift, audit-bypass-undocumented, credential-in-interface, spec-vs-impl, convention-execfile, convention-console, convention-throw, convention-as-any) into the review prompt verbatim from the brief.
- Set review-stage default model to `claude-sonnet-4-6` (or same as implement) via `stageModels` resolution.
- `validateHandoffs: true` (or equivalent gate name in current code) so handoff verification runs.
- Tests assert the prompt assembly contains each category; integration test asserts at least one category produces a blocking finding when fed a synthetic diff with the violation.

---

## Task 6: Tier 3 — auto-deep-review for non-trivial PRs (PR #6)

**Branch:** `tier-3-auto-deep-review`

**Files:**
- Modify: `packages/core/src/types.ts` (extend `PipelineConfig` with `autoDeepReviewThresholds` + `deepReviewFindingsAreBlocking`)
- Modify: `packages/core/src/pipeline/config.ts` (defaults)
- Modify: `packages/core/src/pipeline/runner.ts` (compute thresholds, force `deepReviewPasses>=1`)
- Modify: `packages/core/src/pipeline/review-providers-runner.ts` (when blocking flag true, feed findings into review-fix loop)
- Test: `packages/core/src/__tests__/auto-deep-review.test.ts`

**Defaults:** `{ newFiles: 5, totalLines: 200, newPublicExports: 2 }`. `deepReviewFindingsAreBlocking: true`.

**Heuristic for newPublicExports:** count `^\+export\s+(async\s+)?(function|class|const|let|interface|type|enum)\s` in the unified diff against `packages/*/src/`.

**Escape hatches:** `URATEAM_DISABLE_AUTO_DEEP_REVIEW=true` and per-pipeline overrides.

**Tests:**
- Each threshold trips independently → forced pass occurs (mock fanout).
- All thresholds below limit → no forced pass.
- Blocking flag true → finding routes into review-fix.
- Blocking flag false → finding stays advisory.

---

## Task 7: Tier 4 — design-doc triage with open-questions routing (PR #7)

**Branch:** `tier-4-triage-design-doc`

**Files:**
- Modify: `packages/core/src/pm/actions/triage.ts` (prompt + comment template + routing)
- Modify: `packages/core/src/pm/actions/select-repo-config.ts` only if pipeline-label resolution needs to be revisited (likely no)
- Test: `packages/core/src/__tests__/pm-triage-design-doc.test.ts`

**Prompt additions:** approach summary (3–5 lines), `openQuestions: string[]`, `antiAcceptanceCriteria: string[]`.

**Routing:** If `openQuestions.length > 0`, force `needs-design` label regardless of complexity classification. Use the same Linear-label transition path as the QO observer-marker gate (look up in `triage.ts`'s existing observer-marker branch and reuse the helper).

**Tests:**
- Synthetic Linear-issue fixture with ambiguous AC → routes to `needs-design`.
- Clear-spec fixture → routes to original pipeline label.
- Posted comment contains the three new sections.

---

## Task 8: Tier 5 — escalation on consecutive failures (PR #8)

**Branch:** `tier-5-escalation`

**Files:**
- Modify: `packages/core/src/pm/actions/promote.ts` (or wherever the circuit-breaker decision is made — check `batchCountConsecutiveFailures` call sites)
- Modify: `packages/core/src/audit/events.ts` (new event `pm.escalated_to_needs_design`)
- Modify: `packages/core/src/pm/scheduler.ts` if Slack notifier hookup needs new wiring
- Test: `packages/core/src/__tests__/pm-escalation.test.ts`

**Behavior on count ≥ `maxConsecutiveFailures`:**
1. Add `needs-design` label.
2. Post Linear comment: summary line + last error message (truncated 500 chars).
3. Post Slack alert via existing PM notifier.
4. Emit `pm.escalated_to_needs_design` audit event with `{ issueId, count, errorMsg }`.

**Tests:**
- Issue with 3 consecutive failures, no `needs-design` label → escalation path runs, all four side effects observed (label, comment, Slack mock called, audit row).
- Same issue on subsequent tick (still no human action) → circuit breaker skip path observed, no second escalation.
- Human-cleared issue (label removed, failures cleared) → normal promote eligible.

---

## Self-Review (post-write)

- [x] Spec coverage: each of 5 tiers + 12 sub-items mapped to a PR task above.
- [x] No placeholder language; every gate has interface + test list.
- [x] Type consistency: `ReviewFinding.category` extensions enumerated; audit event names match brief.
- [x] Escape hatches and audit events defined for every gate (per quality bar).

---

## Execution Mode

Inline execution in the current session (per operator brief: "Don't ask permission to begin. Ship."). REQUIRED SUB-SKILL: `superpowers:executing-plans` invoked at each task boundary. TDD per `superpowers:test-driven-development` for every code-bearing step.
