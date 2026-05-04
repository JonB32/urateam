# BEC-135 — Release Manager Agent

**Issue:** [BEC-135](https://linear.app/beckerspace/issue/BEC-135/v10-36-release-manager-agent-auto-merge-auto-tag-iacactions-deploys)
**Tier:** Pro (license-gated)
**Estimate:** 4–6 weeks
**v1.0 gate:** 4 of 6 (sequence after BEC-137)
**Date:** 2026-05-01

---

## 1. Goal

Cron-driven agent that watches recently-merged PRs, evaluates configurable trigger rules, and cuts a GitHub release tag when conditions pass. The operator's existing CI/CD (GitHub Actions / IaC) takes over from there to perform the actual deploy. Slack approval flow keeps a human in the loop when configured.

urateam DOES: decide + tag + post to Slack + record in DB.
urateam DOES NOT: provision deploy infra, run kubectl/terraform, or bypass operator's CI/CD.

## 2. Decisions (locked 2026-05-01)

| # | Decision | Reason |
|---|---|---|
| D1 | Cron-driven agent at `packages/core/src/release-manager/` mirroring PM agent shape | Consistent plug-in pattern; reuses the same Slack interface plumbing. |
| D2 | Pro tier — `release-manager` in `PRO_FEATURES` | License-gated like other agents (slack-interface, conflict-detection, etc.). Startup gate. |
| D3 | Trigger DSL: flat object, AND of set fields | Simplest to validate + document. Each named threshold is independent; setting none of them throws. v2 can add OR-groups if needed. |
| D4 | Version bump: `patch` (default) \| `minor` \| `conventional-commits`; never `major` from config | Major bumps always require manual human override — protects against runaway breaking-change releases. |
| D5 | Release notes: GitHub `generate_release_notes: true` | Free, maintained by GitHub, exactly what humans get from the UI. Zero LLM cost. |
| D6 | Slack: slash subcommands `approve` \| `skip <reason>` \| `status` only | Tighter scope than buttons; reuses existing `pm/slack-interface.ts` slash routing. Buttons are v2. |
| D7 | Approvals are one-shot tokens consumed by the next fire | Prevents stale approvals from triggering unintended releases days later. |
| D8 | Manual-tag detection rebaselines triggers | If a human tags between ticks, the next tick records `decision=skip, reason=manual_tag_detected` and resets counters against the new tag. |

## 3. Architecture

```
packages/core/src/release-manager/
  scheduler.ts                 # cron tick (mirrors pm/scheduler.ts shape)
  types.ts                     # ReleaseManagerConfig + DecisionResult schemas
  decide.ts                    # pure function: (state, triggers) → "fire" | "skip" + reason
  triggers.ts                  # individual rule evaluators
  versioning.ts                # patch | minor | conventional-commits → next semver
  github.ts                    # tag + release creation via Octokit
  slack-handler.ts             # /release approve | skip | status routing
  state.ts                     # collectState() — reads merged PRs, last tag, CI runs, approvals

packages/core/src/db/
  schema.ts                                        # ADD releaseDecisions + releaseApprovals tables
  migrations/sqlite/009_release_manager.sql        # NEW
  migrations/postgres/010_release_manager.sql      # NEW

packages/core/src/audit/events.ts                  # ADD releaseFiredEvent, releaseSkippedEvent, releaseApprovedEvent, releaseTagConflictEvent, slackPostFailedEvent

packages/core/src/license.ts                       # ADD "release-manager" to PRO_FEATURES

packages/core/src/types.ts                         # ADD releaseManager field on RepoConfig

packages/core/src/pm/slack-interface.ts            # MODIFY — register /release subcommand router

packages/cli/src/commands/start.ts                 # WIRE env-flag gate alongside pm-agent

packages/create-urateam/template/.urateam/.env.example   # document Pro env vars

packages/core/src/__tests__/
  release-manager-decide.test.ts
  release-manager-triggers.test.ts
  release-manager-versioning.test.ts
  release-manager-github.test.ts
  release-manager-slack-handler.test.ts
  release-manager-scheduler.test.ts
  release-manager-license-gate.test.ts
  db-release-decisions.test.ts
```

## 4. Configuration

### 4.1 RepoConfig schema addition

```ts
releaseManager: z.object({
  enabled: z.boolean(),
  schedule: z.string().default("*/30 * * * *"),       // cron expression OR ms (validated at parse)
  triggers: z.object({
    mergedPRsSince: z.number().int().positive().optional(),
    timeSinceLastHours: z.number().int().positive().optional(),
    ciGreenForMinutes: z.number().int().positive().optional(),
    requireSlackApproval: z.boolean().default(false),
  }),
  versionBump: z.enum(["patch", "minor", "conventional-commits"]).default("patch"),
  slackChannel: z.string().optional(),                 // required iff requireSlackApproval=true
  branch: z.string().default("main"),                  // tag from this branch
  paths: z.array(z.string()).optional(),               // path filters (glob): only fire if PRs touched these
}).optional()
```

### 4.2 Startup validation

Throws on:
- `requireSlackApproval=true` with no `slackChannel` set
- All four trigger fields unset (no rules → ambiguous semantics)
- License missing `release-manager` feature when `enabled=true`

### 4.3 Env-driven kickstart

Mirrors PM agent's env pattern. `RELEASE_MANAGER_ENABLED=true` plus per-config-field env overrides:

| Env var | Maps to | Notes |
|---|---|---|
| `RELEASE_MANAGER_ENABLED` | `enabled` | Required to start |
| `RELEASE_MANAGER_SCHEDULE` | `schedule` | Optional, default `*/30 * * * *` |
| `RELEASE_MANAGER_VERSION_BUMP` | `versionBump` | One of `patch` \| `minor` \| `conventional-commits` |
| `RELEASE_MANAGER_SLACK_CHANNEL` | `slackChannel` | Required when `requireSlackApproval=true` |
| `RELEASE_MANAGER_BRANCH` | `branch` | Default `main` |
| `RELEASE_MANAGER_TRIGGER_MERGED_PRS_SINCE` | `triggers.mergedPRsSince` | |
| `RELEASE_MANAGER_TRIGGER_TIME_SINCE_LAST_HOURS` | `triggers.timeSinceLastHours` | |
| `RELEASE_MANAGER_TRIGGER_CI_GREEN_FOR_MINUTES` | `triggers.ciGreenForMinutes` | |
| `RELEASE_MANAGER_TRIGGER_REQUIRE_SLACK_APPROVAL` | `triggers.requireSlackApproval` | "true" or "false" |

For per-repo customization, the config object can also live in `pipelineConfig` JSON (the existing per-repo config mechanism).

## 5. Decision flow

```
ReleaseManagerScheduler.tick()
  ├─ if (!isFeatureLicensed("release-manager")):
  │     log.warn once, return
  ├─ state = await collectState({ repo, branch, lastTagSha })
  │     # state = { lastTag, lastTagSha, lastTagAt, headSha, mergedPRsSinceLastTag,
  │     #          ciCheckRuns, hasFreshApproval, manualTagDetected }
  ├─ if (state.manualTagDetected):
  │     persist decision { decision: "skip", reason: "manual_tag_detected" }
  │     audit; do not fire; counters re-baseline next tick
  │     return
  ├─ decision = decide(state, config.triggers)
  │     # decide() returns { kind: "fire" | "skip", reason: string }
  ├─ persist row in release_decisions (every tick — fire OR skip)
  ├─ audit: releaseFiredEvent | releaseSkippedEvent
  ├─ if decision.kind === "skip":
  │     post Slack ONLY when materialChange (avoid spam — see §5.2)
  │     return
  ├─ # decision.kind === "fire"
  ├─ nextVersion = computeNext(state.lastTag, state.mergedCommits, config.versionBump)
  ├─ if (config.triggers.requireSlackApproval && !state.hasFreshApproval):
  │     post Slack: "Release ready: bumping vX.Y.Z (N PRs since last). /release approve to fire."
  │     update decision row: decision="awaiting-approval", proposedVersion=nextVersion
  │     return
  ├─ try:
  │     await octokit.git.createRef({ ref: `refs/tags/v${nextVersion}`, sha: state.headSha })
  │     await octokit.repos.createRelease({ tag_name: `v${nextVersion}`, generate_release_notes: true, target_commitish: state.headSha })
  │     update decision row: firedTag=v${nextVersion}, firedSha=headSha
  │     consume the approval (set consumedAt + consumedByDecisionId)
  │     audit releaseFiredEvent
  │     post Slack: "Released vX.Y.Z"
  ├─ catch (tag-already-exists):
  │     audit releaseTagConflictEvent
  │     decision row: decision="skip", reason="tag_exists"
  ├─ catch (other API error):
  │     decision row: decision="fire-pending", attemptCount++
  │     retry up to 3 times across ticks; permanent skip after 3 failures
```

### 5.1 `decide()` ordering

`decide()` evaluates triggers in a documented order so the "first failing reason" is deterministic:
1. `mergedPRsSince` (cheapest — DB query)
2. `timeSinceLastHours` (cheapest — single timestamp compare)
3. `ciGreenForMinutes` (GitHub API call)
4. `requireSlackApproval` (DB lookup)

Returns `fire` only when EVERY set trigger evaluates true. Returns `skip` with the first failing trigger's reason string.

### 5.2 Slack-skip dedup

To avoid spamming the channel with "trigger X still failing" every 30 minutes, the scheduler tracks the most recent skip-reason per `(repo, branch)` in memory and only re-posts when:
- The skip-reason changes
- 24h has elapsed since last Slack post for this `(repo, branch)`
- Decision transitions skip → awaiting-approval (always post)
- Decision transitions awaiting-approval → fire (always post)

## 6. Schema migration

```ts
export const releaseDecisions = sqliteTable("release_decisions", {
  id: text("id").primaryKey(),
  repoUrl: text("repo_url").notNull(),
  branch: text("branch").notNull(),
  decidedAt: crossTimestamp("decided_at").notNull(),
  decision: text("decision").notNull(),                  // "fire" | "skip" | "awaiting-approval" | "fire-pending"
  reason: text("reason").notNull(),
  triggerStateJson: text("trigger_state_json").notNull(),// snapshot of state for debugging
  proposedVersion: text("proposed_version"),
  firedTag: text("fired_tag"),
  firedSha: text("fired_sha"),
  attemptCount: integer("attempt_count").notNull().default(0),
});
// Indexes:
// - (repo_url, branch, decided_at DESC) for /release status queries
// - (decision, decided_at) for "find fire-pending rows to retry"

export const releaseApprovals = sqliteTable("release_approvals", {
  id: text("id").primaryKey(),
  repoUrl: text("repo_url").notNull(),
  branch: text("branch").notNull(),
  approvedAt: crossTimestamp("approved_at").notNull(),
  approvedBy: text("approved_by").notNull(),             // Slack user id
  consumedAt: crossTimestamp("consumed_at"),
  consumedByDecisionId: text("consumed_by_decision_id"),
});
// Indexes:
// - (repo_url, branch, consumed_at) — partial index where consumed_at IS NULL for "find fresh approvals"
// - UNIQUE (repo_url, branch, approved_by) WHERE consumed_at IS NULL — idempotent /release approve
```

Approvals are considered "fresh" iff `Date.now() - approvedAt < approvalTtlMs`. `approvalTtlMs` defaults to `triggers.timeSinceLastHours * 3600 * 1000` when set, else **24 hours**. Stale approvals are NOT auto-cleaned in v1 (rows remain with `consumedAt=null` indefinitely; the freshness check at decision time excludes them). A sweep step is post-1.0.

## 7. Slack subcommands

### `/release approve`
- Writes a `release_approvals` row (idempotent — UNIQUE constraint catches duplicates).
- Audit `releaseApprovedEvent`.
- Response: `Approved by <@user>. Next eligible tick will fire if other rules pass.` (in-channel, non-ephemeral so others see it).

### `/release skip <reason>`
- Writes a `release_decisions` row with `decision=skip`, `reason="manual:<text>"`.
- Audit.
- Sets a `paused_until` timestamp (= `now + triggers.timeSinceLastHours`) stored in the in-memory scheduler state. Blocks Slack-prompts until paused_until passes.
- Response: `Release skipped: <reason>. Will re-evaluate after <duration>.` (in-channel).

### `/release status`
- Ephemeral response (visible only to invoker).
- Reads last 5 `release_decisions` rows for this `(repo, branch)`.
- Reads current state via `collectState()` (without firing).
- Renders:
  ```
  Last tag: v0.1.30 (2 days ago)
  Proposed next: v0.1.31
  Trigger state:
    ✓ mergedPRsSince=5 (have 7)
    ✗ timeSinceLastHours=24 (only 2h elapsed)
    ✓ ciGreenForMinutes=30 (45m green)
    ⏳ requireSlackApproval=true (no fresh approval)
  Recent decisions:
    [skipped] timeSinceLastHours not met (5m ago)
    [skipped] timeSinceLastHours not met (35m ago)
    ...
  ```

All three subcommands route via `pm/slack-interface.ts` — no new Slack plumbing.

## 8. Versioning

```ts
// versioning.ts
export type BumpKind = "major" | "minor" | "patch";

export function bumpFromConfigAndCommits(
  current: string,                              // "v1.2.3" or "1.2.3" — strip leading v
  commits: Array<{ message: string }>,          // merged PR commits since last tag
  policy: "patch" | "minor" | "conventional-commits",
): string;                                      // returns "v1.2.4" with leading v
```

### `policy="patch"` → always patch bump
### `policy="minor"` → always minor bump
### `policy="conventional-commits"`:
- Scan all commits' messages (subject + body)
- If any matches `/^(feat|fix|refactor|perf)(\([^)]+\))?!:/m` OR `/BREAKING CHANGE:/m` → **major**
- Else if any matches `/^feat(\([^)]+\))?:/m` → **minor**
- Else → **patch**

`policy="patch"` and `policy="minor"` NEVER return major; only `conventional-commits` can. Major-from-config is intentionally absent — humans must manually retag.

## 9. License gating

In `packages/core/src/license.ts`, append to `PRO_FEATURES`:

```ts
const PRO_FEATURES = [
  "slack-interface", "conflict-detection", "deep-review",
  "approval-workflows", "multi-repo", "stage-models",
  "advanced-automerge",
  "release-manager",   // NEW
];
```

Startup gate in `packages/cli/src/commands/start.ts` (alongside the existing PM agent gate):

```ts
if (process.env.RELEASE_MANAGER_ENABLED === "true") {
  if (!isFeatureLicensed("release-manager")) {
    console.error("release-manager requires Pro tier license");
    process.exit(1);
  }
  const rmConfig = ReleaseManagerConfigSchema.parse({ /* env-derived */ });
  const rmScheduler = createReleaseManagerScheduler({ db, config: rmConfig, octokit, slack });
  rmScheduler.start();
}
```

## 10. Error handling

| Failure | Behavior |
|---|---|
| Unlicensed at startup | Process exits 1 with explicit error. |
| License revoked mid-run | Scheduler logs warning + skips ticks silently (matches PM-agent pattern). |
| GitHub API rejects tag (already exists) | Audit `releaseTagConflictEvent`. Decision row: `decision=skip, reason=tag_exists`. Retry next tick after manual tag is detected and re-baselined. |
| `octokit.repos.createRelease` fails after tag was created | Tag is left in place (refs/tags is now valid); retry release-creation across up to 3 ticks. After 3 failures, audit `releasePartialEvent` and require manual cleanup (decision row stays `fire-pending`). |
| Slack post fails | Decision still persisted; audit `slackPostFailedEvent`; tick continues. |
| Multiple `/release approve` from same user | Idempotent via UNIQUE partial index. |
| Manual tag created between ticks | Detected at next tick; recorded as `decision=skip, reason=manual_tag_detected`; trigger counters re-baseline against the new tag. |
| `requireSlackApproval=true` but `slackChannel` unset | Startup validation throws. |
| All trigger fields unset | Startup validation throws. |
| `ciGreenForMinutes` API call fails | Trigger evaluates as failing (not green); reason = "ci_check_unavailable". Doesn't crash the tick. |
| Conventional-commits parse on non-conforming commit | Skipped silently — no error. Falls through to `patch` if no `feat:` match. |

## 11. Testing

| File | Coverage |
|---|---|
| `release-manager-decide.test.ts` | All permutations of triggers set/unset and pass/fail; first-failing-reason ordering; AND semantics |
| `release-manager-triggers.test.ts` | Each trigger evaluator independently against canned state; edge cases (zero PRs, exactly-at-threshold, CI partial-green) |
| `release-manager-versioning.test.ts` | All 3 policies; conventional-commits scan (feat, feat!, BREAKING CHANGE, fix, plain commit); leading-v handling; major-from-non-cc-policy never returns major |
| `release-manager-github.test.ts` | Tag + release creation happy path; tag-already-exists path; release-creation-failure retry; auto-notes flag passed |
| `release-manager-slack-handler.test.ts` | `/release approve` writes idempotent row; `/release skip <reason>` writes paused row + audit; `/release status` reads recent + current state; unknown subcommand returns help |
| `release-manager-scheduler.test.ts` | Tick loop integration; license-not-licensed → silent skip after first warn; awaiting-approval branch; manual-tag-detected branch; Slack-skip dedup |
| `release-manager-license-gate.test.ts` | Unlicensed start → exit 1; licensed start → scheduler runs |
| `db-release-decisions.test.ts` | Both tables created; UNIQUE constraints enforced; partial index works; status query is fast |

No e2e in v1 (matches PM agent's pattern — covered by unit/integration suite). Production integration test gated on `URATEAM_TEST_PG_URL` for postgres path.

## 12. Out of scope (v2 / post-1.0)

- Pre-release / RC tags (`v1.2.3-beta.1`)
- Per-PR approval gates (vs branch-level)
- Auto-rollback on post-deploy failure (urateam doesn't run deploys)
- Slack interactive buttons (slash commands only in v1)
- Multi-branch release flows simultaneously (single `branch` per Release Manager instance in v1)
- Custom release notes templates (use GitHub auto-notes only)
- Customer-supplied tag scripts
- Automatic stale-tag cleanup (only when `manual_tag_detected` re-baselines)
- Self-deploy of urateam itself via this agent (urateam does its own bumps via PR — not target use case)

## 13. Acceptance criteria mapping (from BEC-135)

| Acceptance criterion | Where covered |
|---|---|
| New `release-manager` agent in `packages/core/src/release-manager/` | §3 |
| License gate: `release-manager` in `PRO_FEATURES` | §9 |
| Configurable trigger rules in `pipelineConfig` | §4.1 |
| Slack approval flow via `/release` slash commands | §7 |
| Audit log entry on every decision (release-fire OR release-skip with reason) | §5 (every tick persists + audits) |
| Tests cover: each trigger rule, license-not-licensed path, Slack approval roundtrip | §11 |

## 14. Release & cascade

- Bump `@urateam/core` (this is core code) → next sequential after `0.1.16`
- Cascade `@urateam/cli` and `@urateam/dashboard` patch versions even though dashboard does not surface decisions in v1 (consistent monorepo cadence)
- Tag follows convention (next sequential after `v0.1.30`)
- License-gated: customers must have Pro tier; `.env.example` should document Pro requirement
- BEC-135 hands off to BEC-136 (QA agent's release-readiness check) — Release Manager calls into the QA agent's check as a configurable trigger rule in v2 (not v1)
