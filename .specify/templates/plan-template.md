# Implementation Plan: [FEATURE]

**Branch**: `[###-feature-name]` | **Date**: [DATE] | **Spec**: [link]

**Input**: Feature specification from `/specs/[###-feature-name]/spec.md`

**Note**: This template is filled in by the `/speckit-plan` command. See `.specify/templates/plan-template.md` for the execution workflow.

## Summary

[Extract from feature spec: primary requirement + technical approach from research]

## Technical Context

<!--
  ACTION REQUIRED: Replace the content in this section with the technical details
  for the project. The structure here is presented in advisory capacity to guide
  the iteration process.
-->

**Language/Version**: [e.g., Python 3.11, Swift 5.9, Rust 1.75 or NEEDS CLARIFICATION]

**Primary Dependencies**: [e.g., FastAPI, UIKit, LLVM or NEEDS CLARIFICATION]

**Storage**: [if applicable, e.g., PostgreSQL, CoreData, files or N/A]

**Testing**: [e.g., pytest, XCTest, cargo test or NEEDS CLARIFICATION]

**Target Platform**: [e.g., Linux server, iOS 15+, WASM or NEEDS CLARIFICATION]

**Project Type**: [e.g., library/cli/web-service/mobile-app/compiler/desktop-app or NEEDS CLARIFICATION]

**Performance Goals**: [domain-specific, e.g., 1000 req/s, 10k lines/sec, 60 fps or NEEDS CLARIFICATION]

**Constraints**: [domain-specific, e.g., <200ms p95, <100MB memory, offline-capable or NEEDS CLARIFICATION]

**Scale/Scope**: [domain-specific, e.g., 10k users, 1M LOC, 50 screens or NEEDS CLARIFICATION]

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Sign off on each principle from `.specify/memory/constitution.md`. Mark each
✅ (compliant), ⚠ (override required — explain in Complexity Tracking below),
or N/A (with rationale). Do not leave any blank.

- [ ] **I. Specify Before Implementing** — this feature has a written spec
      (this file's parent `spec.md`) with structured ACs and resolved open
      questions before any implement task starts.
- [ ] **II. Verification Before Completion (NON-NEGOTIABLE)** — every task
      in `tasks.md` has an explicit verification step (test name, gate, or
      CLI command) the implementer can run to prove completion.
- [ ] **III. Convention Gates Run Before Push** — the implementation does
      not require disabling any of the 9 convention gates
      (scratch-files, typecheck, spec-vs-impl, audit-bypass-undocumented,
      credential-in-interface, convention-execfile, convention-console,
      convention-throw, convention-as-any). If any disable is required,
      list under Complexity Tracking with rollback plan.
- [ ] **IV. Operator Sovereignty** — every new autonomous behavior ships
      with an explicit operator-controlled toggle (env var, config flag, or
      feature license). Document the toggle and its default here.
- [ ] **V. Audit What Matters Operationally** — every new operationally-
      significant state transition emits a typed audit event. Enumerate
      new event types here (and remember to bump the CLAUDE.md count to
      keep Tier 1d green).
- [ ] **VI. Fail Visibly With Classification** — every new failure exit
      uses `failPipeline()`; transient vs. permanent classification is
      explicit. Bare throws are documented under Complexity Tracking.
- [ ] **VII. Reversible vs One-Way Doors** — note any one-way-door changes
      (DB schema mutation, destructive op, credential rotation,
      cross-cutting refactor, public API removal) and the gate that
      protects them.

> A failed check requires either a redesign or a Constitution Override (see
> Governance section of the constitution).

## Project Structure

### Documentation (this feature)

```text
specs/[###-feature]/
├── plan.md              # This file (/speckit-plan command output)
├── research.md          # Phase 0 output (/speckit-plan command)
├── data-model.md        # Phase 1 output (/speckit-plan command)
├── quickstart.md        # Phase 1 output (/speckit-plan command)
├── contracts/           # Phase 1 output (/speckit-plan command)
└── tasks.md             # Phase 2 output (/speckit-tasks command - NOT created by /speckit-plan)
```

### Source Code (repository root)
<!--
  ACTION REQUIRED: Replace the placeholder tree below with the concrete layout
  for this feature. Delete unused options and expand the chosen structure with
  real paths (e.g., apps/admin, packages/something). The delivered plan must
  not include Option labels.
-->

```text
# [REMOVE IF UNUSED] Option 1: Single project (DEFAULT)
src/
├── models/
├── services/
├── cli/
└── lib/

tests/
├── contract/
├── integration/
└── unit/

# [REMOVE IF UNUSED] Option 2: Web application (when "frontend" + "backend" detected)
backend/
├── src/
│   ├── models/
│   ├── services/
│   └── api/
└── tests/

frontend/
├── src/
│   ├── components/
│   ├── pages/
│   └── services/
└── tests/

# [REMOVE IF UNUSED] Option 3: Mobile + API (when "iOS/Android" detected)
api/
└── [same as backend above]

ios/ or android/
└── [platform-specific structure: feature modules, UI flows, platform tests]
```

**Structure Decision**: [Document the selected structure and reference the real
directories captured above]

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| [e.g., 4th project] | [current need] | [why 3 projects insufficient] |
| [e.g., Repository pattern] | [specific problem] | [why direct DB access insufficient] |
