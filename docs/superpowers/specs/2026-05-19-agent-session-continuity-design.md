# Pipeline Agent Session Continuity — Design

**Date**: 2026-05-19
**Status**: draft for review
**Tracking**: TBD (file Linear ticket after spec approval)

## Goal

Replace the synthetic per-stage handoff blob with first-class Claude Agent SDK session continuity. Each pipeline run uses one persistent agent session that all non-Haiku stages (`reproduce`, `implement`, `test`, `review`, RALPH iterations, review-fix) resume into. The implement #2 agent in RALPH iteration 2 sees implement #1's full transcript — tool use, edits, reasoning — instead of a terse synthetic blob.

Secondary goal: cut RALPH iteration runtime far enough that the BEC-184 zombie-reap false-positive rate drops to near zero.

## Why now

Three findings from the 2026-05-19 investigation converged:

1. **The SDK already persists session transcripts to `~/.claude/projects/`** (default `persistSession: true` in `@anthropic-ai/claude-agent-sdk@0.2.x`). urateam writes them on every `query()` call and never reads them back. We pay the storage cost and get zero benefit.
2. **The SDK supports first-class resume** via `query({ resume: sessionId, prompt })`. Resumed turns inherit the parent's prompt cache, so cross-stage continuity is roughly free in token cost.
3. **The current "handoff fast path" almost never fires** — no per-stage prompt instructs the agent to emit a `HandoffArtifact` JSON block, so ≥99% of handoffs use the slow git-diff synthesis path. Today's downstream context is `{ filesChanged, summary (last 5 lines of agent output), blocking findings (compressed) }` and not much else. There's barely any rationale being passed; there's barely any to lose by switching to resume.

## Background — what exists today

Pipeline orchestration flow:
```
triage (PM Haiku, separate runtime) → reproduce → implement → test → review →┐
                                          ↑                                   │
                                          └──── RALPH loop (ralphIterations) ┘
                                          │
                                          └──── review-fix loop ─────────────┘
```

Per stage, `executor.executeStage()` calls `sdkQuery({ prompt, options })`. Each call spawns a fresh `cli.js` subprocess (per SDK 0.2.101 source). The user prompt includes a `<previous-stage-context>` XML block synthesized by `extract-handoff.ts:150-215` (git status + diff name-only + last 5 agent output lines). After non-final stages, a Haiku validator (`validate.ts`) verifies handoff accuracy — but fast-paths past the agent call when `filesChanged.length > 0 && summary !== ""`, so in practice it's a near-noop most of the time.

RALPH (`executor/ralph.ts` + `runner.ts:996-1082`) reruns implement→test→review when `checkRequirements()` reports unsatisfied ACs. The re-implement call passes the ORIGINAL upstream handoff (triage/reproduce), not the just-completed implement's output. The gap list goes through a separate `<ralph-iteration>` XML block.

Review-fix loop (`runner.ts:1341-1499`) reruns the implement template again when review surfaces blocking findings, looping up to `reviewFixIterations` (default 1).

Current cache hit rate is 92-98% (per recent PR cost summaries) — already near ceiling because what's cached is the SDK preset + tool definitions (~6.7MB), and what varies per stage is the small user prompt body (~2-4KB).

## Design

Six tracks. Tracks A, B, C, D ship in this spec. E and F are documented Phase 5+ work whose implementation is out of scope here.

### Track A — Session resume within run (Phase 1-3)

Mint one `agent_session_id = randomUUID()` per pipeline run, store on `pipeline_runs.agent_session_id`. First resumable stage uses `query({ sessionId, … })` to create the session. Every subsequent stage uses `query({ resume: sessionId, … })`. The `<previous-stage-context>` block is dropped on resumed stages — the agent already saw what came before.

**The "first resumable stage"** is the first stage in `config.stages` (after triage) that does not appear in the always-fresh list below. For the default pipeline config, that's `reproduce`. For configs that skip reproduce, it's whichever resumable stage runs first.

**Stages that resume** — all of: `reproduce`, `implement`, `test`, `review`, `deep-review`, RALPH re-implement, review-fix. These resume regardless of whether the operator overrides the model via `stageModels` (Sonnet ↔ Opus ↔ future Claude models all share the SDK's session abstraction; tool-call replay is well-defined within the Claude model family).

**Stages that always run fresh**, encoded as a static set in the executor (not config):
- Haiku `validate.ts` — cross-model resume from Sonnet→Haiku puts Sonnet's tool calls in Haiku's context, which is wasteful and potentially confusing.
- Haiku `ralph.ts:checkRequirements()` — same reasoning.
- OpenRouter fanout review providers (Qwen, GPT-OSS, etc.) — non-Claude, no SDK session abstraction available at all.

If a future operator config sets `stageModels.implement = "claude-haiku-4-5"` (Haiku for a normally-resumable stage), the runner detects the family mismatch and falls back to fresh-session for that stage only. Logic: `isResumable(stage, model) := stage NOT IN always_fresh AND modelFamily(model) === "claude"`.

### Track B — Surgical review-fix (Phase 4)

When review surfaces blocking findings, the review-fix loop today re-runs the full implement template. With Track A landed, that becomes a direct resume:

```ts
await sdkQuery({
  resume: agentSessionId,
  prompt: surgicalReviewFixPrompt(findings, decisions),
});
```

The surgical prompt is just the blocking findings + "address each one" — no implement template, no upstream-stage XML. The agent already has the full context.

`surgicalReviewFixPrompt()` lives in `executor/prompt/templates.ts`. The optional `decisions` parameter is Track D's artifact (empty when D isn't present).

A new audit event `pipeline.surgical_review_fix` fires when the surgical path is taken (vs the legacy full-implement fallback when Track A is disabled).

### Track C — Independent small wins (Phase 1, no flag)

**C-1**: `excludeDynamicSections: true` on the SDK `systemPrompt` preset. Five LOC in `executor.ts`. Strips per-session cwd/git-status from the Claude Code preset (which is what currently keeps cache hit rate at 95% instead of 99%). Zero behavioral risk.

**C-2**: `PM_AGENT_STUCK_RUN_AGE_MIN` default 60 → 120 minutes. Real implementation work routinely takes 60-90 min when RALPH iterates. Today's default reaps healthy runs. One-line change in `pm/scheduler.ts` + CLAUDE.md doc update.

### Track D — Decision artifact (Phase 4)

Implement stage emits a structured decision summary at the end of its work:

```json
{
  "decisions": [
    { "choice": "use Zod refinement instead of preprocess", "reason": "preserves error path for downstream", "alternatives_considered": ["preprocess to coerce", "explicit transform"] }
  ],
  "left_unhandled": [
    { "case": "resume_payload with future schema version", "reason": "out of scope per AC #3" }
  ],
  "key_files": ["packages/core/src/types.ts", "packages/core/src/__tests__/types-resume-payload.test.ts"]
}
```

**Storage**: new table `pipeline_run_decisions` (per user steer in section 4 question 1):
```sql
CREATE TABLE pipeline_run_decisions (
  id TEXT PRIMARY KEY,
  pipeline_run_id TEXT NOT NULL REFERENCES pipeline_runs(id),
  iteration INTEGER NOT NULL,   -- RALPH iteration index
  stage TEXT NOT NULL,           -- "implement" today; future stages may also emit
  payload TEXT NOT NULL,         -- JSON
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_pipeline_run_decisions_run ON pipeline_run_decisions(pipeline_run_id, iteration);
```

The implement prompt template (`templates.ts:implementTemplate`) gains an instruction: "before finishing, emit a `<decisions>{ … }</decisions>` block describing your key choices." A parser in `extract-handoff.ts` extracts the block; malformed/missing blocks don't fail the stage (graceful degradation).

**Consumers**:
- Track B's surgical review-fix prompt: "Here's what was previously decided: {decisions}. Review found these issues: {findings}. Address them."
- Future Track F's cross-run inheritance
- Dashboard run-detail view (alongside the transcript viewer from question 4)
- `ura triage-quality` style analytics — measure how decisions correlate with eventual review findings

### Track E — v2 SDK migration path (Phase 6, documented intent)

Once Track A is proven stable in dogfood (~2-4 weeks of soak), migrate from stable `query({ resume })` to the v2 `unstable_v2_createSession()` / `SDKSession.send()` ergonomics. The `SDKSession` object avoids passing `resume: sessionId` on every call and exposes cleaner cancellation. Implementation deferred until the v2 API exits alpha or until urateam's risk tolerance for alpha SDK APIs increases.

### Track F — Cross-run session inheritance (Phase 5, documented sketch)

Resumable across pipeline runs in narrowly-defined cases:
- Linear `blocks` / `blocked-by` relation between the runs' issues
- Both runs owned by the same author
- Source session JSONL is younger than `URATEAM_CROSS_RUN_SESSION_MAX_AGE_HOURS` (default 24h)
- Operator opt-in via `URATEAM_ENABLE_CROSS_RUN_SESSION=true`

When all conditions met, the new run's first resumable stage uses `resume: parentSessionId` and `forkSession: true` (per SDK), branching a new session rather than appending. Detailed design in a follow-up spec.

## Schema changes

**New column** `pipeline_runs.agent_session_id TEXT NULLABLE`:
- Null = legacy/pre-migration runs OR runs created with Track A flag off
- Populated by `runner.start()` via `randomUUID()`
- Persists across retriable resume — same sessionId reused (no rotation per question 2)
- Migration via `MIGRATION_COLUMNS` array in `db/client.ts`, idempotent across SQLite + Postgres

**New table** `pipeline_run_decisions` (Track D, schema above).

**New audit event types** in `AuditEventTypeSchema`:
- `pipeline.agent_session_created` — emitted by `runner.start()`
- `pipeline.agent_session_resumed` — emitted by each non-first `query()` call (payload includes prior message count from `getSessionMessages()`)
- `pipeline.agent_session_missing_fallback` — emitted when resume requested but JSONL absent → legacy path taken
- `pipeline.surgical_review_fix` — Track B
- `system.session_volume_warning` — startup check fires this if `~/.claude/projects/` looks ephemeral

Canonical count moves from 52 → 57. CLAUDE.md `audit-immutability.test.ts` count assertion bumped in the same PR.

## Docker / infra changes

`docker-compose.dogfood.yml`:
```yaml
volumes:
  - urateam-dogfood-agent-sessions:/home/ura/.claude/projects
```

Named volume declared at the bottom of the file. Persists across container restarts. Without this, retriable resume silently loses transcripts.

Startup check: `runner` boot path inspects the projects dir, emits `system.session_volume_warning` if the mount looks ephemeral (e.g., `tmpfs` filesystem, or directory writeable but doesn't survive a test write-read-restart cycle in dev mode).

## Code changes by file

| File | Change |
|---|---|
| `packages/core/src/db/schema.ts` | Add `agentSessionId` column to `pipelineRuns`. Add `pipelineRunDecisions` table. |
| `packages/core/src/db/client.ts` | MIGRATION_COLUMNS entry + new-table DDL in `getCreateTablesDDL()`. |
| `packages/core/src/pipeline/runner.ts` | Mint sessionId at `start()`. Thread to `executeStage()` calls. Track "first resumable stage" boundary. RALPH loop: drop `<previous-stage-context>` on resumed iterations. Review-fix loop: Track B branch. Startup volume check. |
| `packages/core/src/executor/executor.ts` | `executeStage()` gains `agentSessionId` + `isFirstResumableStage` params. SDK options builder branches on first-vs-resume. Add `excludeDynamicSections: true` (Track C-1). |
| `packages/core/src/executor/ralph.ts` | `buildRalphContext()` slims down — agent already has prior state, just emit gap list. `checkRequirements()` always uses fresh session (Haiku, no resume). |
| `packages/core/src/executor/deep-review.ts` | Add resume option. Single Claude SDK call resumes; fanout providers stay fresh (different vendors). |
| `packages/core/src/executor/validate.ts` | Add `runMode: "resume" \| "fallback" \| "first-stage"` param. Skip validation on all but first-resumed stage (per question 3). |
| `packages/core/src/executor/extract-handoff.ts` | Add `<decisions>` block parser (Track D). Keep producing the synthetic HandoffArtifact (cheap; consumers persist). |
| `packages/core/src/executor/prompt/templates.ts` | Implement template instruction for decisions emission. New `surgicalReviewFixPrompt()` for Track B. |
| `packages/core/src/types.ts` | `AgentSessionCreatedEvent` + 4 sibling audit event schemas. `DecisionArtifact` schema for Track D. |
| `packages/core/src/audit/events.ts` | Helper builders for new event types. Bump canonical-count comment. |
| `packages/core/src/__tests__/audit-immutability.test.ts` | Bump 52 → 57. |
| `packages/dashboard/src/routes/runs.ts` + views | Transcript viewer route (`GET /runs/:id/transcript`). Display `agent_session_id` in run-detail. Decision artifact panel. |
| `packages/dashboard/src/views/run-transcript.ts` (new) | Render `SessionMessage[]` from `getSessionMessages()` as chronological list. Collapse tool turns by default. |
| `packages/cli/src/commands/sessions.ts` (new) | Optional `ura sessions <runId>` — print transcript locally. |
| `docker-compose.dogfood.yml` | Volume mount. |
| `deploy/USER_LEVEL_INSTALL.md`, `deploy/BOOTSTRAP.md` | Document the new volume. |
| `CLAUDE.md` | New section on agent session continuity. Update PM Agent tick sequence note (zombie-age default bumped). Update audit-event count comment to 57. |

## Rollout phases

| Phase | What ships | Default | Validation |
|---|---|---|---|
| 1 | Track A code + Track C-1 (excludeDynamicSections) + Track C-2 (zombie age bump). | The Track A flag `URATEAM_ENABLE_AGENT_SESSION_RESUME` defaults `false`; C-1 and C-2 ship ON (no flag) since they're guaranteed wins. | All existing tests + new unit tests; cache-hit-rate uptick from C-1 visible in cost summaries. |
| 2 | Dogfood soak. Operator sets the flag `true`. | 1-2 weeks. | Runtime down ≥30%, RALPH iter=2 rate drops, no novel failure modes in audit events. |
| 3 | Flip default to `true` in code. | Wide. | Metrics hold on broader sample. |
| 4 | Track B + Track D. | Flag-on by default for Track A. Track B has its own opt-in flag if needed. | Surgical-fix runtime measurably shorter than full re-implement. |
| 5 | Track F (separate spec). | Opt-in. | Out of scope here. |
| 6 | Track E (v2 SDK migration). | No user-facing flag. | Drop-in API swap. |

Feature flag semantics: strict equality on `"true"` (matches BEC-218 / BEC-225 precedent), read at call time per stage (so toggling propagates without daemon restart).

## Fallback paths

**On run start**: mint sessionId AND populate column ONLY when `URATEAM_ENABLE_AGENT_SESSION_RESUME=true` at run-start time. Flag-off runs leave the column null, so a run started in flag-off mode stays on the legacy path for its entire lifetime even if the flag flips during execution.

**On stage execution**: if `agent_session_id IS NULL` (flag was off at run start, or legacy pre-migration run) → use legacy handoff path. If column populated AND JSONL file exists at expected path → resume. If column populated AND JSONL missing → legacy + audit event + log warning.

**On JSONL parse error during resume** (e.g., truncated last message from a SIGTERM mid-write): catch SDK error → legacy handoff path + audit event.

**On retriable resume**: PM agent picks up the run, same `agent_session_id` is reused (per question 2). If JSONL is intact → real resume. If absent or stale → legacy fallback.

## Long-session compression

When the resumed transcript exceeds 50,000 input tokens of replay (chosen as the conservative threshold where cache-read economics start to favor a compressed summary over a verbatim replay), trigger compression:
1. Call `getSessionMessages(sessionId)` to read the full transcript
2. Haiku call: "summarize the following N messages into a single context block preserving file decisions, test outcomes, and review findings."
3. Replace the resumed transcript path: use `forkSession({ upToMessageId })` to branch at the boundary point, then prepend the compressed summary as the new user turn.

This is Phase 3+ work — implementation deferred until Phase 2 soak shows real sessions hitting the threshold. The SDK does not surface JSONL pagination on `query()` itself per the investigation, so Haiku-summarization is the path if compression becomes needed.

## Risks

**R1 — Volume mount missed in deploy** (high impact, low likelihood). Mitigation: startup `system.session_volume_warning` audit event + deploy runbook update.

**R2 — Cross-model resume oddity**. Mitigation: static fresh-vs-resume map, validator and ralph-check NEVER resume.

**R3 — Stale transcript on long-retriable run** (low likelihood, low impact). Mitigation: `--max-session-age` default 24h; older → legacy fallback.

**R4 — Phase-2 soak shows no improvement** (medium likelihood). Mitigation: ship Track C-2 (zombie age) regardless — guaranteed win. Defer Phase 3 default flip if A doesn't show value.

**R5 — Hidden coupling between HandoffArtifact and dashboard/analytics**. Mitigation: keep producing the JSON (cheap), just stop CONSUMING it in the agent prompt. Code-search audit before merging.

**R6 — SDK resume semantics differ from investigation findings**. Mitigation: spike-test a 2-stage toy pipeline in the same branch before integrating. Document confirmed semantics in spec before Track A ships.

## Testing strategy

**Unit** (per track, see Section 4 of the design discussion).

**Spike test** (pre-implementation): a throwaway 2-stage pipeline against a real Linear ticket with the v2 SDK. Measure token usage delta on the resumed second stage vs a fresh second stage. Confirms resume actually works as documented before we wire it through the runner.

**Integration** (mocked SDK, recorded sessionId/resume option per call): full pipeline flow + RALPH iteration + review-fix iteration.

**Container-restart soak** (Phase 2): `kill -9 urateam-dogfood` mid-implement. Observe whether resume succeeds or cleanly falls back.

**Phase 2 production soak**: 1-2 weeks of real pipeline runs with flag on. Track:
- Runtime per stage (compared to historical baseline)
- RALPH iteration distribution (% needing iter=2)
- Token usage (input/cache_read/cache_creation per stage)
- New audit events firing as expected
- Any novel failure modes

## Out of scope (genuinely)

- Pluggable `sessionStore` for PG-backed transcripts (HA / multi-host failover) — SDK doesn't expose it; feature request to Anthropic when needed.
- Resuming sessions from S3 / external storage — out of scope.
- The validator's own redesign — kept fresh-session, unchanged.
- OpenRouter fanout providers using sessions — they're not Claude, can't.

## References

- SDK source: `node_modules/@anthropic-ai/claude-agent-sdk@0.2.101/sdk.d.ts` lines 1023 (`continue`), 1102 (`forkSession`), 1152 (`persistSession`), 1324 (`resume`), 1330 (`sessionId`), 1336 (`resumeSessionAt`), 1891 (`query`), 2642 (`SDKSession` v2 alpha)
- Anthropic prompt caching: https://docs.claude.com/en/docs/build-with-claude/prompt-caching
- urateam current handoff lifecycle: `packages/core/src/executor/{extract-handoff,handoff,validate,ralph,executor}.ts` and `packages/core/src/pipeline/runner.ts:857-1499`
- Investigation outputs (this brainstorming session): SDK lifecycle agent, prompt-cache feasibility agent, handoff/RALPH map agent (partial: cost-quantification agent stalled before completion).
- Related: BEC-183 (pre-stream stall + wall-clock per-stage), BEC-184 (zombie age), BEC-218 (env-var pattern precedent).
