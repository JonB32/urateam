<!--
SYNC IMPACT REPORT — Constitution Initialization
================================================
Version change: 0.0.0 → 1.0.0 (initial ratification)

Bump rationale: MAJOR. This is the first concrete ratification of the
urateam Constitution. The prior `.specify/memory/constitution.md` was the
spec-kit template with placeholder tokens; no governance was in force
before this version.

Modified principles:
- (none — initial ratification)

Added sections:
- Core Principles I–VII
- Operational Standards
- Development Workflow
- Governance

Removed sections:
- (none)

Templates requiring updates:
- ⚠ pending  .specify/templates/plan-template.md  — add Constitution Check
  block that explicitly enumerates principles I–VII so the SDD plan stage
  can sign off on each.
- ⚠ pending  .specify/templates/spec-template.md  — surface principle I
  ("Specify Before Implementing") and principle II ("Verification Before
  Completion") as required sections.
- ⚠ pending  .specify/templates/tasks-template.md  — add a "Verification"
  column to every task row so principle II is enforced at the task
  granularity.
- ✅ N/A     .specify/templates/commands/*.md  — no command files in this
  repo; commands live in `.claude/skills/speckit-*/` and the
  spec-kit-generated SKILL.md files are not project-owned.
- ⚠ pending  CLAUDE.md — add a top-level pointer to this constitution under
  Conventions and reference it from the triage / implement / review
  prompts when Tier 6 ships.

Follow-up TODOs:
- TODO(audit-event-changelog): add a `constitution.amended` audit-event
  type in a future amendment so changes to this file produce an
  observable, queryable history. Deferred to keep this initial ratification
  scope-tight; Tier 1d will flag the count drift when it lands.
-->

# urateam Constitution

> The foundational principles for the autonomous urateam agent.
>
> This document defines what makes the autonomous pipeline's output
> trustworthy. The Linear → triage → implement → test → review → push
> pipeline anchors every decision to a principle below; deviations require
> an explicit override justification in the PR body.

## Core Principles

### I. Specify Before Implementing

Every change MUST start with structured requirements before any implement-stage
tokens are spent. Concretely:

- The PM Agent's triage stage MUST emit acceptance criteria for every issue
  routed to `auto-implement` / `bug` / `quick-fix`.
- When triage cannot fully specify the work (the `openQuestions` field is
  non-empty, or the issue carries the quality-observer marker), the issue
  MUST route to `needs-design` regardless of size or complexity heuristics.
- For human-driven feature work, the spec-kit SDD cycle
  (`/speckit-specify` → `/speckit-plan` → `/speckit-tasks` → `/speckit-implement`)
  is the canonical entry point. Code-first development without a spec is
  permissible only for typo fixes, dependency bumps, and single-line bug fixes.

**Rationale**: Implement-stage tokens are the most expensive resource in the
pipeline. Spending them on ambiguous specs produces draft PRs at best,
incorrect-but-confident PRs at worst. Triage is the cheapest leverage point
for quality.

### II. Verification Before Completion (NON-NEGOTIABLE)

Every claim of "done" — at the stage, agent, or pipeline level — MUST be
backed by a passing test, a fired gate, or an explicit verification artifact
the operator can inspect. Specifically:

- The implement template MUST require AC-by-AC verification before the agent
  declares the stage complete.
- The review template MUST cross-reference the diff against the AC list and
  flag unaddressed criteria as blocking `incomplete-implementation` findings.
- No agent declares "completed" without evidence visible to operators (a test
  pass, a passing gate, a successful CI check, or a `verification:` block in
  the PR description).
- The `superpowers:verification-before-completion` skill is mandatory before
  PR creation: run the verification command in the same message as the
  success claim.

**Rationale**: The cheapest bug to ship is the one the agent thinks it
already fixed. Evidence cures this.

### III. Convention Gates Run Before Push

The nine deterministic + AI convention gates MUST run on every PR before
push, and MUST force draft status (never an auto-merge) on any blocking
fire:

1. `scratch-files` (Tier 1a) — denylist for `.bak`, repo-root `TEST_*.md`, etc.
2. `typecheck` (Tier 1b) — `pnpm -w typecheck` clean.
3. `spec-vs-impl` (Tier 1c) — JSDoc references to `config.X` / `opts.Y` /
   `deps.Z` / `env.W` / `options.V` MUST resolve in the worktree.
4. `audit-bypass-undocumented` — `logAuditEventUnchecked` callers MUST be in
   the allow-list (`packages/core/src/__tests__/audit-immutability.test.ts`).
5. `credential-in-interface` — exported types MUST NOT carry `*Token`,
   `*Secret`, `*Key`, `*Password`, `*Credential`, `*Auth` fields without an
   `@internal` JSDoc marker.
6. `convention-execfile` — code MUST call `execFile` (never `exec`).
7. `convention-console` — daemon and library code MUST use the structured
   pino logger via `createLogger`. The `create-urateam` package is the only
   exempt module (operator-facing install wizard; documented exemption).
8. `convention-throw` — pipeline failure paths MUST use `failPipeline()`,
   never a bare `throw`.
9. `convention-as-any` — `as any` casts are forbidden outside the documented
   `AnyDb` pattern.

Every gate MUST expose an env-var escape hatch documented in CLAUDE.md so
a single false-positive cannot block legitimate work.

**Rationale**: Quality regressions cost more to fix in main than to block at
push. Gates are the deterministic backstop that survives prompt drift.

### IV. Operator Sovereignty

The operator MUST always have a path to override the agent. Concretely:

- Stop a single run: `ura stop <runId>` (immediate cancel) or
  `ura stop <runId> --graceful` (finish current stage, then skip).
- Halt all runs: `ura halt` (pauses PM + cancels in-flight).
- Manual triage routing: add the `needs-design` Linear label to any issue.
- Policy bypass: add the configured `overrideLabel` to any issue.
- Per-gate bypass: documented env vars (`URATEAM_DISABLE_*_GATE=true`).
- Slack control: `/pm cancel`, `/pm stop`, `/pm halt`, `/pm pause`, `/pm resume`.

Agent autonomy is **opt-in by gate, not opt-out**. New autonomous behaviors
MUST ship with an explicit operator-controlled toggle (env var, config flag,
or feature license) before they default to on.

**Rationale**: Operators must trust the agent. Trust requires the ability
to overrule it.

### V. Audit What Matters Operationally

Every state transition, every gate fire, every Pro/Enterprise feature
decision MUST write a typed audit event. Specifically:

- The `audit_events` table is append-only by convention; the
  `packages/core/src/__tests__/audit-immutability.test.ts` test enforces
  this by greping for `delete(auditEvents)` / `update(auditEvents)`.
- The Tier 1d count test enforces that CLAUDE.md's `<N> event types`
  sentence matches `AuditEventTypeSchema.options.length`.
- The current canonical count is 51; new events MUST update both the schema
  and the doc count in the same PR.
- License-gated `logAuditEvent` is the default; `logAuditEventUnchecked` is
  reserved for base-tier operational signals (license validation failure,
  Claude auth expiry) per the documented allow-list.

**Rationale**: Operators debug from logs. Untyped or missing events make
the autonomous pipeline opaque after the fact.

### VI. Fail Visibly With Classification

Pipeline failures MUST classify as transient (retriable, auto-resume) or
permanent (cancel) at the failure site. Specifically:

- `failPipeline()` is mandatory for all failure exits; bare `throw` outside
  push-queue / lock callbacks is a convention-throw violation.
- `isTransientError()` is the canonical classifier; new transient
  categories (auth, network, rate-limit) MUST extend it rather than be
  handled with ad-hoc retries in callers.
- Stalled stages MUST throw a typed error (`StagePreStreamStalledError`,
  `StageStalledError`) that the runner can attribute correctly.
- Silent failure paths (swallowed exceptions, fail-open without log) are
  bugs and MUST be removed when discovered.

**Rationale**: The pipeline must explain itself. Silent failures masquerade
as success and erode operator trust faster than visible failures.

### VII. Reversible Changes Are Autonomous; One-Way Doors Need Gates

Reversibility determines whether a change can ship autonomously:

- **Reversible** (single-file fixes, doc updates, test additions, dependency
  bumps within a major version) MAY ship via the standard pipeline without
  additional approval beyond the convention gates.
- **One-way doors** (DB schema mutations, destructive ops, credential
  rotations, cross-cutting refactors, public API removals, deletion of
  audit events) MUST gate on explicit operator approval. Acceptable gates:
  the `needs-design` route, the policy override label, the RBAC role
  requirement, or a dedicated Linear approval workflow.

The org-policy gate (`packages/core/src/policy/`) is the canonical
enforcement point for path-blocklist, cost cap, and reviewer requirements.

**Rationale**: Autonomy compounds when it is bounded. Unbounded autonomy
on irreversible changes is the failure mode that kills operator trust in
one PR.

## Operational Standards

### Gates and Escape Hatches

The nine convention gates from Principle III each have an env-var escape
hatch documented in CLAUDE.md:

- `URATEAM_DISABLE_SCRATCH_GUARD=true`
- `URATEAM_DISABLE_TYPECHECK_GATE=true`
- `URATEAM_DISABLE_SPEC_VS_IMPL_GATE=true`
- `URATEAM_DISABLE_AUTO_DEEP_REVIEW=true` (Tier 3)
- Per-pipeline `autoDeepReviewThresholds: { changedFiles: 999999, ... }`
  for fine-grained bypass

The Tier 5 circuit breaker is bypassed by setting `maxConsecutiveFailures: 0`
in the PM config. The convention-console exemption for `create-urateam` is
documented in CLAUDE.md Conventions; review-stage findings inside
`packages/create-urateam/**` flagged under that category MUST be dismissed.

### Audit Event Discipline

- Canonical count: 51 (as of constitution v1.0.0).
- Authoritative location: `AuditEventTypeSchema` at
  `packages/core/src/types.ts`.
- Adding a new event MUST update the schema, add a builder in
  `packages/core/src/audit/events.ts`, bump the CLAUDE.md count, and pass
  the Tier 1d guard.
- Write sites for license-bypass (`logAuditEventUnchecked`): `license.ts`,
  `executor/auth-monitor.ts`, and Pro/Enterprise feature modules per the
  documented allow-list. Adding a new bypass site requires updating the
  allow-list in `audit-immutability.test.ts`.

### Operator Control Surfaces

Three surfaces, all funnel through `Runner.requestStop` / `Runner.haltAll`:

- **Dashboard**: `POST /runs/:id/cancel`, `POST /runs/:id/stop`,
  `POST /admin/halt-all` (RBAC-gated, CSRF-protected).
- **CLI**: `ura stop <runId> [--graceful]`, `ura halt` (gated on
  `URATEAM_CLI_TOKEN`).
- **Slack**: `/pm cancel`, `/pm stop`, `/pm halt`, `/pm pause`, `/pm resume`.

All three emit `run.cancelled` per stopped run and `system.halted` for the
halt-all path.

### Install Paths

Two install paths are supported and MUST stay distinct:

- **Project-level (sidecar / docker-compose)** — env-var driven, used for
  hosted multi-operator deployments with SSO + RBAC. Authoritative source:
  `deploy/docker-compose.dogfood.yml` + `.env`.
- **User-level (`~/.urateam/`)** — config-file driven via
  `~/.urateam/config.json`, used for single-operator laptops / VMs.
  Hot-reloads on file change.

Cross-contamination (env vars leaking into user-level mode, or vice versa)
is a bug.

### Code Conventions (Enforced by Principle III Gates)

- Use `execFile` (never `exec`) for all shell commands.
- All `console.log` / `console.error` in daemon and library code use the
  structured pino logger via `createLogger`. The `create-urateam` package
  is the only exempt module.
- DB schema mutations require updates in three places: `MIGRATION_COLUMNS`
  array, `getCreateTablesDDL()` template, and the Drizzle schema in
  `db/schema.ts`. The driver-agnostic `crossTimestamp` is the only
  authorized timestamp helper.
- Sanitize all untrusted content via `sanitize()` from
  `executor/prompt/sanitizer.ts` before including it in agent prompts; use
  `buildSandboxedBlock()` as the canonical helper.
- Redact credentials from URLs before logging:
  `url.replace(/:\/\/[^@]+@/, "://[redacted]@")`.

## Development Workflow

### Spec-Driven Development (Human-Driven Work)

The canonical workflow for non-trivial human-driven changes:

1. **`/speckit-specify`** — write the feature specification.
2. **`/speckit-clarify`** (optional) — resolve ambiguity flagged during spec.
3. **`/speckit-plan`** — produce the implementation plan, including the
   Constitution Check block that signs off on each principle.
4. **`/speckit-tasks`** — break the plan into bite-sized tasks with explicit
   verification for each.
5. **`/speckit-implement`** — execute the tasks task-by-task.

Typo fixes, dependency bumps, single-line bug fixes, and reverts MAY bypass
the SDD cycle.

### Test-Driven Development (Code-Bearing Work)

For every code-bearing task:

1. Write the failing test that describes the desired behavior.
2. Run the test; confirm it fails for the documented reason.
3. Implement the minimal code to make the test pass.
4. Run the test; confirm it passes.
5. Commit (test + impl in the same commit, or test in a preceding commit
   followed immediately by the impl commit).

The `superpowers:test-driven-development` skill is the canonical reference
for the red-green-refactor discipline.

### Pre-PR Review

Before any PR is marked ready-for-review:

- `pnpm test` (or per-package equivalent) MUST be clean for every package
  touched.
- `pnpm -w typecheck` MUST be clean.
- A Sonnet code-reviewer MUST be dispatched via the
  `feature-dev:code-reviewer` agent with `model: sonnet`; every BLOCKING
  finding MUST be addressed before lifting the draft status.
- The PR description MUST include the 9-category convention self-review
  checklist with explicit ✓ or override-justification per category.

### Release Cadence

- Patch releases are cut per feature via `pnpm cut-release patch`.
- CHANGELOG.md entries MUST be filled in before tag push.
- The npm-publish workflow is the only authorized publisher.
- GitHub Releases are the source of truth for per-version notes (v0.1.7+).

## Governance

### Supersession

This constitution supersedes ad-hoc preferences, undocumented conventions,
and historical PR patterns. When this document conflicts with another
artifact, this document wins until amended.

### Override Procedure

A PR that violates a principle MUST include an explicit override
justification in the PR body under a `## Constitution Override` section
that:

1. Names the violated principle by number.
2. Explains the operational reason (cost, blocker, time-sensitive incident).
3. States the rollback plan if the override proves wrong.
4. Tags the operator who approved the override.

Override usage MUST be tracked. A pattern of repeated overrides of the same
principle is a signal to amend the principle or expose a configuration
escape hatch.

### Amendment Process

1. Amendments to principles MUST update this file in a dedicated PR.
2. The same PR MUST update the Sync Impact Report comment at the top.
3. CLAUDE.md MUST be updated in the same PR if the amendment affects
   conventions enforced by gates.
4. The version line is bumped per semantic-versioning rules:
   - **MAJOR**: backward-incompatible principle removal/redefinition.
   - **MINOR**: new principle or materially-expanded guidance.
   - **PATCH**: clarifications, wording, typo fixes.
5. The autonomous agent's triage / implement / review prompts SHOULD be
   re-evaluated against the amendment within one release cycle.

### Compliance Review

Every PR review (Sonnet or human) MUST verify compliance with this
constitution alongside the standard code-quality checks. PRs that fail
compliance without an override MUST be sent back for revision.

The Tier 1d audit-count guard, the convention-checklist review prompt
(Tier 2), and the deterministic gates (Tiers 1a–c) are the automated
enforcement layer; this constitution is the source of truth those layers
implement.

**Version**: 1.0.0 | **Ratified**: 2026-05-13 | **Last Amended**: 2026-05-13
