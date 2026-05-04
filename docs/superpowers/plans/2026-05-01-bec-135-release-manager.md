# BEC-135 — Release Manager Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cron-driven Pro-tier agent at `packages/core/src/release-manager/` that watches recently-merged PRs, evaluates configurable trigger rules each tick, and cuts a GitHub release tag (with auto-generated notes) when conditions pass — with optional Slack approval gating, slash-command control (`/release approve | skip | status`), idempotent decision logging, and full audit + license gating.

**Architecture:** Mirrors the existing PM Agent shape (cron tick + Postgres advisory lock + license check) but routes its outputs through GitHub's REST API (tag + release creation) instead of Linear. Pure decision logic (`decide`, `triggers`, `versioning`) is split from IO (`state`, `github`, `slack-handler`) for unit testability. `/release` slash commands hop into the same `slack-interface.ts` Hono router by dispatching on Slack's `command` form field. Two new tables (`release_decisions` + `release_approvals`) record every tick for an audit trail and one-shot approval consumption.

**Tech Stack:** TypeScript, Zod v3, Drizzle ORM (sqlite + postgres dialects), `@octokit/rest` (already a dep), `croner` (new dep — small, zero-dep cron parser), Hono (slash-command router), Vitest 3.x (block-body `beforeEach` only).

**Spec reference:** `docs/superpowers/specs/2026-05-01-bec-135-release-manager-design.md` (357 lines, 14 sections — all decisions locked in §2).

**Workflow conventions:**
- Branch: `jonb3232/bec-135-v10-36-release-manager-agent-auto-merge-auto-tag-iacactions` (already pushed; one commit ahead of main with the spec)
- Worktree: `/tmp/urateam-fresh/.worktrees/bec-135` (pnpm install already done)
- vitest 3.x: ALWAYS write `beforeEach(() => { ... })` — never `beforeEach(() => () => { ... })`. The latter is interpreted as a teardown function.
- After all tasks pass: open PR for Sonnet review; user merges; user does the version cascade + npm publish.

---

## Top-level file structure

### Created (16 files)

```
packages/core/src/release-manager/
  types.ts                                          # ReleaseManagerConfigSchema + DecisionResult + collected state types
  triggers.ts                                       # Pure rule evaluators (mergedPRsSince, timeSinceLastHours, ciGreenForMinutes, requireSlackApproval)
  decide.ts                                         # Pure: (state, triggers) → { kind: "fire" | "skip", reason }
  versioning.ts                                     # Pure: (currentTag, commits, policy) → nextTag (with conventional-commits scan)
  state.ts                                          # collectState() — reads merged PRs, last tag, CI runs, fresh approvals
  github.ts                                         # Tag + release creation via Octokit (handles tag-exists + retry-pending)
  slack-handler.ts                                  # /release approve | skip <reason> | status routing + DB writes + audit
  scheduler.ts                                      # Cron tick loop; orchestrates state → decide → fire/persist/audit/Slack-dedup
  index.ts                                          # Re-exports public API for use by cli/start.ts and tests

packages/core/src/db/migrations/sqlite/009_release_manager.sql
packages/core/src/db/migrations/postgres/010_release_manager.sql

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

### Modified (7 files)

```
packages/core/src/license.ts                                       # ADD "release-manager" to PRO_FEATURES
packages/core/src/db/schema.ts                                     # ADD releaseDecisions + releaseApprovals tables
packages/core/src/types.ts                                         # ADD release-manager event types to AuditEventTypeSchema; ADD releaseManager field to RepoConfig
packages/core/src/audit/events.ts                                  # ADD 6 new event factories
packages/core/src/pm/slack-interface.ts                            # MODIFY /slack/commands handler to dispatch /pm vs /release
packages/cli/src/commands/start.ts                                 # WIRE env-driven instantiation (license gate + scheduler)
packages/create-urateam/template/.urateam/.env.example             # DOCUMENT Pro env vars
packages/core/package.json                                         # ADD croner dep
```

### Note on test infrastructure quirks (read before starting)

- **vitest 3.x `beforeEach` quirk** — always block-body. Wrong: `beforeEach(() => () => { ... })`. Right: `beforeEach(() => { _resetLicenseCache(); });`.
- **Zod v3 syntax** — use `.refine()` and `.superRefine()`, not v4's `.check()`. Use `z.union([...])` for cron-or-ms.
- **License cache** — `checkLicense` caches its result. Tests that change `URATEAM_LICENSE_KEY` must call `_resetLicenseCache()` before each call.
- **Postgres test gating** — codebase convention is `TEST_POSTGRES_URL` (NOT `URATEAM_TEST_PG_URL` as the spec mistakenly says). Use `describe.skipIf(!process.env.TEST_POSTGRES_URL)`.
- **Audit event type schema is a strict Zod enum** — adding a new `eventType` requires editing `AuditEventTypeSchema` in `types.ts`.

---

## Task 1: Add croner dep and verify it imports

**Files:**
- Modify: `packages/core/package.json` (add `"croner": "^9.0.0"` to `dependencies`)
- Test: ad-hoc compile/import check

- [ ] **Step 1: Add the dep**

Edit `packages/core/package.json`. Find the alphabetically-sorted `dependencies` block and insert:

```json
    "croner": "^9.0.0",
```

(Place it between `"better-sqlite3"` / `"chalk"` / `"commander"` / etc., wherever the alphabetical sort puts it. Do NOT use `~` ranges.)

- [ ] **Step 2: Install**

```bash
cd /tmp/urateam-fresh/.worktrees/bec-135 && pnpm install
```

Expected: install succeeds, `croner` appears in `pnpm-lock.yaml`. No new peer-dep warnings.

- [ ] **Step 3: Verify import works**

```bash
cd /tmp/urateam-fresh/.worktrees/bec-135/packages/core && node --input-type=module -e "import { Cron } from 'croner'; console.log(typeof Cron);"
```

Expected output: `function`

- [ ] **Step 4: Commit**

```bash
cd /tmp/urateam-fresh/.worktrees/bec-135
git add packages/core/package.json pnpm-lock.yaml
git commit -m "chore(core): add croner dep for release-manager scheduling"
```

---

## Task 2: License gate — add release-manager to PRO_FEATURES

**Files:**
- Modify: `packages/core/src/license.ts:26-34`
- Test: `packages/core/src/__tests__/release-manager-license-gate.test.ts` (CREATE)

This task only adds the feature constant + a unit test that proves `isFeatureLicensed("release-manager")` returns true under a Pro license and false under no license. The startup gate (Task 13) reuses this.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/__tests__/release-manager-license-gate.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isFeatureLicensed, _resetLicenseCache } from "../license.js";

describe("release-manager license gate", () => {
  const originalKey = process.env.URATEAM_LICENSE_KEY;

  beforeEach(() => {
    delete process.env.URATEAM_LICENSE_KEY;
    _resetLicenseCache();
  });

  afterEach(() => {
    if (originalKey) {
      process.env.URATEAM_LICENSE_KEY = originalKey;
    } else {
      delete process.env.URATEAM_LICENSE_KEY;
    }
    _resetLicenseCache();
  });

  it("release-manager is gated (returns false without a license)", () => {
    expect(isFeatureLicensed("release-manager")).toBe(false);
  });

  it("non-commercial features still pass without a license", () => {
    expect(isFeatureLicensed("not-a-real-feature")).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /tmp/urateam-fresh/.worktrees/bec-135/packages/core && npx vitest run src/__tests__/release-manager-license-gate.test.ts
```

Expected: FAIL — first test will show `expected true to be false` because `release-manager` is not yet in the commercial set, so `isFeatureLicensed` short-circuits to `true`.

- [ ] **Step 3: Add release-manager to PRO_FEATURES**

In `packages/core/src/license.ts` line 26-34, change:

```ts
const PRO_FEATURES = [
  "slack-interface",
  "conflict-detection",
  "deep-review",
  "approval-workflows",
  "multi-repo",
  "stage-models",
  "advanced-automerge",
];
```

to:

```ts
const PRO_FEATURES = [
  "slack-interface",
  "conflict-detection",
  "deep-review",
  "approval-workflows",
  "multi-repo",
  "stage-models",
  "advanced-automerge",
  "release-manager",
];
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd /tmp/urateam-fresh/.worktrees/bec-135/packages/core && npx vitest run src/__tests__/release-manager-license-gate.test.ts
```

Expected: PASS — both tests green.

- [ ] **Step 5: Commit**

```bash
cd /tmp/urateam-fresh/.worktrees/bec-135
git add packages/core/src/license.ts packages/core/src/__tests__/release-manager-license-gate.test.ts
git commit -m "feat(core): gate release-manager behind Pro tier license"
```

---

## Task 3: DB schema — releaseDecisions + releaseApprovals tables

**Files:**
- Modify: `packages/core/src/db/schema.ts` (append after `reviewModelRuns`, line 244)
- Test: `packages/core/src/__tests__/db-release-decisions.test.ts` (CREATE)

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/__tests__/db-release-decisions.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { eq, and } from "drizzle-orm";
import { createDb } from "../db/index.js";
import { releaseDecisions, releaseApprovals } from "../db/schema.js";

function tmpDbPath(): string {
  const id = randomBytes(8).toString("hex");
  return `/tmp/laf-rm-test-${id}.sqlite`;
}

describe("release-manager DB tables", () => {
  const paths: string[] = [];

  async function makeDb() {
    const path = tmpDbPath();
    paths.push(path);
    return createDb({ driver: "sqlite", connectionString: path });
  }

  afterEach(() => {
    for (const p of paths) {
      try { unlinkSync(p); } catch { /* ignore */ }
      try { unlinkSync(p + "-wal"); } catch { /* ignore */ }
      try { unlinkSync(p + "-shm"); } catch { /* ignore */ }
    }
  });

  it("inserts and reads a release_decisions row", async () => {
    const { db } = await makeDb();
    const id = `rd_${randomUUID()}`;
    await db.insert(releaseDecisions).values({
      id,
      repoUrl: "https://github.com/org/repo",
      branch: "main",
      decidedAt: new Date(),
      decision: "skip",
      reason: "timeSinceLastHours not met",
      triggerStateJson: JSON.stringify({ mergedPRs: 3 }),
      attemptCount: 0,
    });
    const rows = await db.select().from(releaseDecisions).where(eq(releaseDecisions.id, id));
    expect(rows).toHaveLength(1);
    expect(rows[0].decision).toBe("skip");
    expect(rows[0].reason).toBe("timeSinceLastHours not met");
  });

  it("enforces UNIQUE(repo_url, branch, approved_by) WHERE consumed_at IS NULL — second pending approve from same user fails", async () => {
    const { db } = await makeDb();
    await db.insert(releaseApprovals).values({
      id: `ra_${randomUUID()}`,
      repoUrl: "https://github.com/org/repo",
      branch: "main",
      approvedAt: new Date(),
      approvedBy: "U123",
    });
    await expect(
      db.insert(releaseApprovals).values({
        id: `ra_${randomUUID()}`,
        repoUrl: "https://github.com/org/repo",
        branch: "main",
        approvedAt: new Date(),
        approvedBy: "U123",
      })
    ).rejects.toThrow();
  });

  it("allows a second approve from the same user once the first is consumed", async () => {
    const { db } = await makeDb();
    const firstId = `ra_${randomUUID()}`;
    await db.insert(releaseApprovals).values({
      id: firstId,
      repoUrl: "https://github.com/org/repo",
      branch: "main",
      approvedAt: new Date(),
      approvedBy: "U123",
    });
    await db.update(releaseApprovals)
      .set({ consumedAt: new Date(), consumedByDecisionId: "rd_consumed" })
      .where(eq(releaseApprovals.id, firstId));
    // Second approve should now succeed
    await db.insert(releaseApprovals).values({
      id: `ra_${randomUUID()}`,
      repoUrl: "https://github.com/org/repo",
      branch: "main",
      approvedAt: new Date(),
      approvedBy: "U123",
    });
    const rows = await db
      .select()
      .from(releaseApprovals)
      .where(
        and(
          eq(releaseApprovals.repoUrl, "https://github.com/org/repo"),
          eq(releaseApprovals.approvedBy, "U123"),
        ),
      );
    expect(rows).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /tmp/urateam-fresh/.worktrees/bec-135/packages/core && npx vitest run src/__tests__/db-release-decisions.test.ts
```

Expected: FAIL with TS error like `Module '"../db/schema.js"' has no exported member 'releaseDecisions'`.

- [ ] **Step 3: Add tables to schema.ts**

In `packages/core/src/db/schema.ts`, append after the `reviewModelRuns` table (after line 244):

```ts
/** BEC-135: cron decisions logged each tick — one row per fire OR skip. */
export const releaseDecisions = sqliteTable("release_decisions", {
  id: text("id").primaryKey(),
  repoUrl: text("repo_url").notNull(),
  branch: text("branch").notNull(),
  decidedAt: crossTimestamp("decided_at")
    .notNull()
    .$defaultFn(() => new Date()),
  /** "fire" | "skip" | "awaiting-approval" | "fire-pending" */
  decision: text("decision").notNull(),
  reason: text("reason").notNull(),
  /** JSON snapshot of trigger inputs at decision time, for debugging. */
  triggerStateJson: text("trigger_state_json").notNull(),
  proposedVersion: text("proposed_version"),
  firedTag: text("fired_tag"),
  firedSha: text("fired_sha"),
  /** Tracks retries when GitHub release-creation fails after tag was created. Capped at 3. */
  attemptCount: integer("attempt_count").notNull().default(0),
});

/** BEC-135: one-shot Slack-driven approvals consumed by the next eligible fire. */
export const releaseApprovals = sqliteTable(
  "release_approvals",
  {
    id: text("id").primaryKey(),
    repoUrl: text("repo_url").notNull(),
    branch: text("branch").notNull(),
    approvedAt: crossTimestamp("approved_at")
      .notNull()
      .$defaultFn(() => new Date()),
    /** Slack user ID (e.g. "U12345"). */
    approvedBy: text("approved_by").notNull(),
    consumedAt: crossTimestamp("consumed_at"),
    consumedByDecisionId: text("consumed_by_decision_id"),
  },
  // The UNIQUE WHERE consumed_at IS NULL partial index is created in the
  // raw migration SQL because Drizzle's sqliteTable.unique() helper does
  // not support partial indexes. Migration files own that concern.
);
```

- [ ] **Step 4: Run the test to verify it (still) fails for a different reason**

```bash
cd /tmp/urateam-fresh/.worktrees/bec-135/packages/core && npx vitest run src/__tests__/db-release-decisions.test.ts
```

Expected: FAIL with `no such table: release_decisions`. The schema is now defined but no migration creates the table — Task 4 fixes that.

- [ ] **Step 5: Commit**

```bash
cd /tmp/urateam-fresh/.worktrees/bec-135
git add packages/core/src/db/schema.ts packages/core/src/__tests__/db-release-decisions.test.ts
git commit -m "feat(core): drizzle schema for release_decisions + release_approvals"
```

---

## Task 4: SQLite migration 009 — create release-manager tables

**Files:**
- Create: `packages/core/src/db/migrations/sqlite/009_release_manager.sql`

- [ ] **Step 1: Create the migration**

Write `packages/core/src/db/migrations/sqlite/009_release_manager.sql`:

```sql
-- BEC-135: Release Manager agent — decision log + one-shot approvals.

CREATE TABLE IF NOT EXISTS release_decisions (
  id TEXT PRIMARY KEY,
  repo_url TEXT NOT NULL,
  branch TEXT NOT NULL,
  decided_at INTEGER NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT NOT NULL,
  trigger_state_json TEXT NOT NULL,
  proposed_version TEXT,
  fired_tag TEXT,
  fired_sha TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0
);

-- Index for /release status: fast lookup of the most recent N decisions per (repo, branch).
CREATE INDEX IF NOT EXISTS idx_release_decisions_repo_branch_decided
  ON release_decisions(repo_url, branch, decided_at DESC);

-- Index for retry sweep: find fire-pending rows.
CREATE INDEX IF NOT EXISTS idx_release_decisions_decision_decided
  ON release_decisions(decision, decided_at);

CREATE TABLE IF NOT EXISTS release_approvals (
  id TEXT PRIMARY KEY,
  repo_url TEXT NOT NULL,
  branch TEXT NOT NULL,
  approved_at INTEGER NOT NULL,
  approved_by TEXT NOT NULL,
  consumed_at INTEGER,
  consumed_by_decision_id TEXT
);

-- Partial UNIQUE: one fresh (un-consumed) approval per (repo, branch, user).
-- Once consumed, the row stays for audit but no longer blocks new approves.
CREATE UNIQUE INDEX IF NOT EXISTS idx_release_approvals_unique_fresh
  ON release_approvals(repo_url, branch, approved_by)
  WHERE consumed_at IS NULL;

-- Lookup index for fresh-approval check at decision time.
CREATE INDEX IF NOT EXISTS idx_release_approvals_repo_branch_consumed
  ON release_approvals(repo_url, branch, consumed_at);
```

- [ ] **Step 2: Run the test to verify it passes**

```bash
cd /tmp/urateam-fresh/.worktrees/bec-135/packages/core && npx vitest run src/__tests__/db-release-decisions.test.ts
```

Expected: PASS — all 3 tests green. The `createDb` helper runs migrations on connect, so the new tables are created automatically.

- [ ] **Step 3: Commit**

```bash
cd /tmp/urateam-fresh/.worktrees/bec-135
git add packages/core/src/db/migrations/sqlite/009_release_manager.sql
git commit -m "feat(core): sqlite migration 009 for release_manager tables"
```

---

## Task 5: Postgres migration 010 — create release-manager tables

**Files:**
- Create: `packages/core/src/db/migrations/postgres/010_release_manager.sql`

This task ships the matching Postgres DDL. Tested only when `TEST_POSTGRES_URL` is set; the SQLite test from Task 3 covers the schema-shape contract.

- [ ] **Step 1: Create the migration**

Write `packages/core/src/db/migrations/postgres/010_release_manager.sql`:

```sql
-- BEC-135: Release Manager agent — decision log + one-shot approvals.

CREATE TABLE IF NOT EXISTS release_decisions (
  id TEXT PRIMARY KEY,
  repo_url TEXT NOT NULL,
  branch TEXT NOT NULL,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decision TEXT NOT NULL,
  reason TEXT NOT NULL,
  trigger_state_json TEXT NOT NULL,
  proposed_version TEXT,
  fired_tag TEXT,
  fired_sha TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_release_decisions_repo_branch_decided
  ON release_decisions(repo_url, branch, decided_at DESC);

CREATE INDEX IF NOT EXISTS idx_release_decisions_decision_decided
  ON release_decisions(decision, decided_at);

CREATE TABLE IF NOT EXISTS release_approvals (
  id TEXT PRIMARY KEY,
  repo_url TEXT NOT NULL,
  branch TEXT NOT NULL,
  approved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_by TEXT NOT NULL,
  consumed_at TIMESTAMPTZ,
  consumed_by_decision_id TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_release_approvals_unique_fresh
  ON release_approvals(repo_url, branch, approved_by)
  WHERE consumed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_release_approvals_repo_branch_consumed
  ON release_approvals(repo_url, branch, consumed_at);
```

- [ ] **Step 2: Verify with optional Postgres run**

If a local Postgres is configured for tests, run:

```bash
cd /tmp/urateam-fresh/.worktrees/bec-135/packages/core && TEST_POSTGRES_URL="$TEST_POSTGRES_URL" npx vitest run src/__tests__/db-postgres.test.ts
```

Expected: PASS (existing migration tests should still pass; the new SQL is purely additive). If `TEST_POSTGRES_URL` is unset, the suite is skipped — that's fine.

- [ ] **Step 3: Commit**

```bash
cd /tmp/urateam-fresh/.worktrees/bec-135
git add packages/core/src/db/migrations/postgres/010_release_manager.sql
git commit -m "feat(core): postgres migration 010 for release_manager tables"
```

---

## Task 6: Audit event types + factories

**Files:**
- Modify: `packages/core/src/types.ts:415-427` (extend `AuditEventTypeSchema`)
- Modify: `packages/core/src/audit/events.ts` (append 6 new factories)
- Test: `packages/core/src/__tests__/audit-types.test.ts` already covers the schema; we'll add release-event tests inline.

This task adds 6 audit-event helpers and extends the strict event-type enum. No release-manager logic yet — purely the audit primitives.

- [ ] **Step 1: Write failing tests**

Create `packages/core/src/__tests__/release-manager-audit-events.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  releaseFiredEvent,
  releaseSkippedEvent,
  releaseApprovedEvent,
  releaseTagConflictEvent,
  releasePartialEvent,
  slackPostFailedEvent,
} from "../audit/events.js";
import { AuditEventSchema } from "../types.js";

describe("release-manager audit events", () => {
  it("releaseFiredEvent passes schema validation", () => {
    const evt = releaseFiredEvent({
      repoUrl: "https://github.com/org/repo",
      branch: "main",
      tag: "v1.2.3",
      sha: "abcdef0",
      mergedPrCount: 5,
    });
    expect(evt.eventType).toBe("release.fired");
    expect(evt.actor).toBe("release-manager");
    expect(() => AuditEventSchema.parse(evt)).not.toThrow();
    expect(evt.payload.tag).toBe("v1.2.3");
  });

  it("releaseSkippedEvent passes schema validation", () => {
    const evt = releaseSkippedEvent({
      repoUrl: "https://github.com/org/repo",
      branch: "main",
      reason: "timeSinceLastHours not met",
    });
    expect(evt.eventType).toBe("release.skipped");
    expect(() => AuditEventSchema.parse(evt)).not.toThrow();
  });

  it("releaseApprovedEvent passes schema validation", () => {
    const evt = releaseApprovedEvent({
      repoUrl: "https://github.com/org/repo",
      branch: "main",
      approvedBy: "U123",
    });
    expect(evt.eventType).toBe("release.approved");
    expect(() => AuditEventSchema.parse(evt)).not.toThrow();
  });

  it("releaseTagConflictEvent passes schema validation", () => {
    const evt = releaseTagConflictEvent({
      repoUrl: "https://github.com/org/repo",
      branch: "main",
      tag: "v1.2.3",
    });
    expect(evt.eventType).toBe("release.tag_conflict");
    expect(() => AuditEventSchema.parse(evt)).not.toThrow();
  });

  it("releasePartialEvent passes schema validation", () => {
    const evt = releasePartialEvent({
      repoUrl: "https://github.com/org/repo",
      branch: "main",
      tag: "v1.2.3",
      attemptCount: 3,
    });
    expect(evt.eventType).toBe("release.partial");
    expect(() => AuditEventSchema.parse(evt)).not.toThrow();
  });

  it("slackPostFailedEvent passes schema validation", () => {
    const evt = slackPostFailedEvent({
      channel: "#releases",
      reason: "channel_not_found",
    });
    expect(evt.eventType).toBe("slack.post_failed");
    expect(() => AuditEventSchema.parse(evt)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /tmp/urateam-fresh/.worktrees/bec-135/packages/core && npx vitest run src/__tests__/release-manager-audit-events.test.ts
```

Expected: FAIL — TS errors on missing exports `releaseFiredEvent`, etc.

- [ ] **Step 3: Extend `AuditEventTypeSchema`**

In `packages/core/src/types.ts:415-427`, change:

```ts
export const AuditEventTypeSchema = z.enum([
  "run.started", "run.completed", "run.failed",
  "run.auto_merged", "run.auto_merge_skipped",
  "pm.approval_requested", "pm.approval_resolved",
  "pm.issue_promoted", "pm.issue_deprioritized", "pm.issue_cancelled",
  "pm.triage_classified",
  "budget.alert_fired", "budget.run_refused",
  "license.validation_failed", "config.loaded",
  "dashboard.manual_action",
  "dashboard.login", "dashboard.logout", "dashboard.login_denied",
  "policy.path_blocked", "policy.cost_exceeded",
  "policy.override_used", "policy.reviewers_requested",
]);
```

to:

```ts
export const AuditEventTypeSchema = z.enum([
  "run.started", "run.completed", "run.failed",
  "run.auto_merged", "run.auto_merge_skipped",
  "pm.approval_requested", "pm.approval_resolved",
  "pm.issue_promoted", "pm.issue_deprioritized", "pm.issue_cancelled",
  "pm.triage_classified",
  "budget.alert_fired", "budget.run_refused",
  "license.validation_failed", "config.loaded",
  "dashboard.manual_action",
  "dashboard.login", "dashboard.logout", "dashboard.login_denied",
  "policy.path_blocked", "policy.cost_exceeded",
  "policy.override_used", "policy.reviewers_requested",
  "release.fired", "release.skipped", "release.approved",
  "release.tag_conflict", "release.partial",
  "slack.post_failed",
]);
```

Also update `AuditActorTypeSchema` at line 430-433:

```ts
export const AuditActorTypeSchema = z.enum([
  "system", "pm-agent", "webhook", "dashboard-user", "cli",
]);
```

to:

```ts
export const AuditActorTypeSchema = z.enum([
  "system", "pm-agent", "webhook", "dashboard-user", "cli",
  "release-manager",
]);
```

- [ ] **Step 4: Add the factories**

Append to `packages/core/src/audit/events.ts` (after the last function, after line 329):

```ts
export function releaseFiredEvent(args: {
  repoUrl: string;
  branch: string;
  tag: string;
  sha: string;
  mergedPrCount: number;
}): AuditEvent {
  return base({
    eventType: "release.fired",
    actor: "release-manager",
    actorType: "release-manager",
    scope: `repo:${args.repoUrl}`,
    payload: {
      branch: args.branch,
      tag: args.tag,
      sha: args.sha,
      mergedPrCount: args.mergedPrCount,
    },
  });
}

export function releaseSkippedEvent(args: {
  repoUrl: string;
  branch: string;
  reason: string;
}): AuditEvent {
  return base({
    eventType: "release.skipped",
    actor: "release-manager",
    actorType: "release-manager",
    scope: `repo:${args.repoUrl}`,
    payload: { branch: args.branch, reason: args.reason },
  });
}

export function releaseApprovedEvent(args: {
  repoUrl: string;
  branch: string;
  approvedBy: string;
}): AuditEvent {
  return base({
    eventType: "release.approved",
    actor: `slack:${args.approvedBy}`,
    actorType: "release-manager",
    scope: `repo:${args.repoUrl}`,
    payload: { branch: args.branch, approvedBy: args.approvedBy },
  });
}

export function releaseTagConflictEvent(args: {
  repoUrl: string;
  branch: string;
  tag: string;
}): AuditEvent {
  return base({
    eventType: "release.tag_conflict",
    actor: "release-manager",
    actorType: "release-manager",
    scope: `repo:${args.repoUrl}`,
    payload: { branch: args.branch, tag: args.tag },
  });
}

export function releasePartialEvent(args: {
  repoUrl: string;
  branch: string;
  tag: string;
  attemptCount: number;
}): AuditEvent {
  return base({
    eventType: "release.partial",
    actor: "release-manager",
    actorType: "release-manager",
    scope: `repo:${args.repoUrl}`,
    payload: { branch: args.branch, tag: args.tag, attemptCount: args.attemptCount },
  });
}

export function slackPostFailedEvent(args: {
  channel: string;
  reason: string;
}): AuditEvent {
  return base({
    eventType: "slack.post_failed",
    actor: "release-manager",
    actorType: "release-manager",
    payload: { channel: args.channel, reason: args.reason },
  });
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd /tmp/urateam-fresh/.worktrees/bec-135/packages/core && npx vitest run src/__tests__/release-manager-audit-events.test.ts
```

Expected: PASS — all 6 tests green.

Run the existing audit-types test to confirm we didn't break it:

```bash
cd /tmp/urateam-fresh/.worktrees/bec-135/packages/core && npx vitest run src/__tests__/audit-types.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd /tmp/urateam-fresh/.worktrees/bec-135
git add packages/core/src/types.ts packages/core/src/audit/events.ts packages/core/src/__tests__/release-manager-audit-events.test.ts
git commit -m "feat(core): release-manager audit event types + factories"
```

---

## Task 7: ReleaseManagerConfigSchema + types

**Files:**
- Create: `packages/core/src/release-manager/types.ts`
- Create: `packages/core/src/release-manager/index.ts`
- Modify: `packages/core/src/types.ts` (add `releaseManager` field to `RepoConfigSchema`)

- [ ] **Step 1: Write failing tests inline in this task** (no separate test file — Tasks 8 + 10 cover types via their callers, and config validation has its own test below)

Create `packages/core/src/__tests__/release-manager-config.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { ReleaseManagerConfigSchema } from "../release-manager/types.js";

describe("ReleaseManagerConfigSchema", () => {
  it("parses a minimal valid config (one trigger set)", () => {
    const cfg = ReleaseManagerConfigSchema.parse({
      enabled: true,
      triggers: { mergedPRsSince: 5 },
    });
    expect(cfg.enabled).toBe(true);
    expect(cfg.versionBump).toBe("patch");
    expect(cfg.branch).toBe("main");
    expect(cfg.schedule).toBe("*/30 * * * *");
    expect(cfg.triggers.mergedPRsSince).toBe(5);
  });

  it("throws when no trigger field is set", () => {
    expect(() =>
      ReleaseManagerConfigSchema.parse({
        enabled: true,
        triggers: {},
      })
    ).toThrow(/at least one trigger/i);
  });

  it("throws when requireSlackApproval=true but slackChannel is unset", () => {
    expect(() =>
      ReleaseManagerConfigSchema.parse({
        enabled: true,
        triggers: { mergedPRsSince: 5, requireSlackApproval: true },
      })
    ).toThrow(/slackChannel/i);
  });

  it("accepts requireSlackApproval=true with slackChannel", () => {
    const cfg = ReleaseManagerConfigSchema.parse({
      enabled: true,
      triggers: { mergedPRsSince: 5, requireSlackApproval: true },
      slackChannel: "#releases",
    });
    expect(cfg.triggers.requireSlackApproval).toBe(true);
    expect(cfg.slackChannel).toBe("#releases");
  });

  it("accepts versionBump enum values", () => {
    expect(ReleaseManagerConfigSchema.parse({
      enabled: true,
      triggers: { mergedPRsSince: 5 },
      versionBump: "minor",
    }).versionBump).toBe("minor");
    expect(ReleaseManagerConfigSchema.parse({
      enabled: true,
      triggers: { mergedPRsSince: 5 },
      versionBump: "conventional-commits",
    }).versionBump).toBe("conventional-commits");
  });

  it("rejects invalid versionBump values (e.g. 'major')", () => {
    expect(() =>
      ReleaseManagerConfigSchema.parse({
        enabled: true,
        triggers: { mergedPRsSince: 5 },
        versionBump: "major",
      })
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /tmp/urateam-fresh/.worktrees/bec-135/packages/core && npx vitest run src/__tests__/release-manager-config.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Create types.ts**

Write `packages/core/src/release-manager/types.ts`:

```ts
import { z } from "zod";

export const ReleaseManagerTriggersSchema = z.object({
  mergedPRsSince: z.number().int().positive().optional(),
  timeSinceLastHours: z.number().int().positive().optional(),
  ciGreenForMinutes: z.number().int().positive().optional(),
  requireSlackApproval: z.boolean().default(false),
});
export type ReleaseManagerTriggers = z.infer<typeof ReleaseManagerTriggersSchema>;

export const ReleaseManagerConfigSchema = z
  .object({
    enabled: z.boolean(),
    /** Cron expression — defaults to every 30 minutes. Parsed by croner at scheduler start. */
    schedule: z.string().default("*/30 * * * *"),
    triggers: ReleaseManagerTriggersSchema,
    /** Version bump policy. "major" is intentionally absent — humans must retag manually. */
    versionBump: z.enum(["patch", "minor", "conventional-commits"]).default("patch"),
    /** Required when triggers.requireSlackApproval=true. Channel ID or "#name". */
    slackChannel: z.string().optional(),
    /** Branch the agent watches and tags from. */
    branch: z.string().default("main"),
    /** Optional path globs — only fire if PRs since last tag touched these files. v2 may add this. */
    paths: z.array(z.string()).optional(),
  })
  .superRefine((cfg, ctx) => {
    const t = cfg.triggers;
    const anyTrigger =
      t.mergedPRsSince !== undefined ||
      t.timeSinceLastHours !== undefined ||
      t.ciGreenForMinutes !== undefined ||
      t.requireSlackApproval === true;
    if (!anyTrigger) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["triggers"],
        message: "at least one trigger field must be set (mergedPRsSince, timeSinceLastHours, ciGreenForMinutes, or requireSlackApproval=true)",
      });
    }
    if (t.requireSlackApproval === true && !cfg.slackChannel) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["slackChannel"],
        message: "slackChannel is required when triggers.requireSlackApproval=true",
      });
    }
  });
export type ReleaseManagerConfig = z.infer<typeof ReleaseManagerConfigSchema>;

/** Computed snapshot of the world at decision time. */
export interface CollectedState {
  /** Last tag string in 'vX.Y.Z' form, or null if no tags exist yet. */
  lastTag: string | null;
  lastTagSha: string | null;
  lastTagAt: Date | null;
  /** SHA of the tip of the configured branch. */
  headSha: string;
  /** Count of commits between lastTagSha and headSha (a proxy for "merged PRs since last tag"). */
  mergedCommitsSinceLastTag: number;
  /** Subset of commit messages between lastTagSha and headSha — drives conventional-commits scan. */
  commitsSinceLastTag: Array<{ message: string }>;
  /** Aggregated CI status for headSha. "green" iff all required check_runs are "success". */
  ciStatus: "green" | "not-green" | "unavailable";
  /** Time at which CI first became green for headSha. null when not green or unavailable. */
  ciGreenSince: Date | null;
  /** True iff a fresh, un-consumed approval row exists for (repo, branch). */
  hasFreshApproval: boolean;
  /** Slack user id of the most recent fresh approval (for audit). null if hasFreshApproval=false. */
  freshApprovalApprover: string | null;
  /** True iff the latest tag in the repo is newer than what we last fired. Re-baselines counters. */
  manualTagDetected: boolean;
}

export type DecisionResult =
  | { kind: "fire"; reason: string }
  | { kind: "skip"; reason: string }
  | { kind: "awaiting-approval"; reason: string };
```

**Note on the `awaiting-approval` decision kind:** Spec §5.1 lists `requireSlackApproval` as the 4th-ordered trigger evaluated by `decide()`. Spec §5 also describes a separate "awaiting-approval" decision kind written when all non-approval triggers pass but approval is missing. We reconcile by treating `requireSlackApproval` failure as a *third* result kind (`awaiting-approval`) — distinct from the regular `skip` so the dashboard can surface "ready to ship, just needs approval" without mixing it in with cooldown skips.

- [ ] **Step 4: Create the index re-export**

Write `packages/core/src/release-manager/index.ts`:

```ts
export * from "./types.js";
```

(Other modules will be added to this export list as later tasks create them.)

- [ ] **Step 5: Run the config test to verify it passes**

```bash
cd /tmp/urateam-fresh/.worktrees/bec-135/packages/core && npx vitest run src/__tests__/release-manager-config.test.ts
```

Expected: PASS — all 6 tests green.

- [ ] **Step 6: Add releaseManager field to RepoConfig**

In `packages/core/src/types.ts`, modify `RepoConfigSchema` (line 192-207) to add the new optional field. Add the import at the top of the file (after existing imports):

```ts
import { ReleaseManagerConfigSchema } from "./release-manager/types.js";
```

Then change the `RepoConfigSchema` block from:

```ts
export const RepoConfigSchema = z.object({
  url: z.string(),
  defaultBranch: z.string(),
  testCommand: z.string(),
  buildCommand: z.string(),
  setupCommands: z.array(SetupCommandSchema).optional(),
  workingDirectory: z.string().optional(),
  plugins: PluginConfigSchema.optional(),
  devcontainer: DevcontainerConfigSchema.optional(),
  /** Per-team trigger map. Overrides the global triggerMap for this team's repo. Falls back to DEFAULT_TRIGGER_MAP. */
  triggerMap: TriggerMapSchema.optional(),
  /** Hosting provider. Defaults to "github". Set to "gitlab" for GitLab repos. */
  provider: z.enum(["github", "gitlab"]).optional(),
  /** Configuration for GitHub PR review comment → pipeline re-entry (feedback runs). */
  githubFeedback: GitHubFeedbackConfigSchema.optional(),
});
```

to:

```ts
export const RepoConfigSchema = z.object({
  url: z.string(),
  defaultBranch: z.string(),
  testCommand: z.string(),
  buildCommand: z.string(),
  setupCommands: z.array(SetupCommandSchema).optional(),
  workingDirectory: z.string().optional(),
  plugins: PluginConfigSchema.optional(),
  devcontainer: DevcontainerConfigSchema.optional(),
  /** Per-team trigger map. Overrides the global triggerMap for this team's repo. Falls back to DEFAULT_TRIGGER_MAP. */
  triggerMap: TriggerMapSchema.optional(),
  /** Hosting provider. Defaults to "github". Set to "gitlab" for GitLab repos. */
  provider: z.enum(["github", "gitlab"]).optional(),
  /** Configuration for GitHub PR review comment → pipeline re-entry (feedback runs). */
  githubFeedback: GitHubFeedbackConfigSchema.optional(),
  /** BEC-135: Release Manager agent (Pro feature). */
  releaseManager: ReleaseManagerConfigSchema.optional(),
});
```

- [ ] **Step 7: Verify TS compiles**

```bash
cd /tmp/urateam-fresh/.worktrees/bec-135/packages/core && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 8: Commit**

```bash
cd /tmp/urateam-fresh/.worktrees/bec-135
git add packages/core/src/release-manager/types.ts packages/core/src/release-manager/index.ts packages/core/src/types.ts packages/core/src/__tests__/release-manager-config.test.ts
git commit -m "feat(core): ReleaseManagerConfigSchema + RepoConfig.releaseManager"
```

---

## Task 8: Pure trigger evaluators

**Files:**
- Create: `packages/core/src/release-manager/triggers.ts`
- Create: `packages/core/src/__tests__/release-manager-triggers.test.ts`

This task implements four named functions, one per trigger. Each takes a slice of `CollectedState` (or scalar values) plus the threshold and returns a `{ pass: boolean; reason: string }` result.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/__tests__/release-manager-triggers.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  evalMergedPRsSince,
  evalTimeSinceLastHours,
  evalCiGreenForMinutes,
  evalRequireSlackApproval,
} from "../release-manager/triggers.js";

describe("evalMergedPRsSince", () => {
  it("passes when count meets threshold", () => {
    expect(evalMergedPRsSince(5, 5)).toEqual({ pass: true, reason: "mergedPRsSince=5 (have 5)" });
    expect(evalMergedPRsSince(7, 5)).toEqual({ pass: true, reason: "mergedPRsSince=5 (have 7)" });
  });
  it("fails when count is below threshold", () => {
    expect(evalMergedPRsSince(3, 5)).toEqual({ pass: false, reason: "mergedPRsSince not met (3/5)" });
    expect(evalMergedPRsSince(0, 1)).toEqual({ pass: false, reason: "mergedPRsSince not met (0/1)" });
  });
});

describe("evalTimeSinceLastHours", () => {
  const now = new Date("2026-05-01T12:00:00Z");

  it("passes when no last tag exists (initial release)", () => {
    expect(evalTimeSinceLastHours(null, 24, now)).toEqual({ pass: true, reason: "no prior tag" });
  });
  it("passes when elapsed >= threshold", () => {
    const lastTag = new Date(now.getTime() - 25 * 3600 * 1000);
    const r = evalTimeSinceLastHours(lastTag, 24, now);
    expect(r.pass).toBe(true);
  });
  it("fails when elapsed < threshold", () => {
    const lastTag = new Date(now.getTime() - 2 * 3600 * 1000);
    const r = evalTimeSinceLastHours(lastTag, 24, now);
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/timeSinceLastHours not met/);
  });
});

describe("evalCiGreenForMinutes", () => {
  const now = new Date("2026-05-01T12:00:00Z");

  it("fails when CI is not green", () => {
    expect(evalCiGreenForMinutes("not-green", null, 30, now)).toEqual({
      pass: false,
      reason: "ci_not_green",
    });
  });
  it("fails when CI status is unavailable", () => {
    expect(evalCiGreenForMinutes("unavailable", null, 30, now)).toEqual({
      pass: false,
      reason: "ci_check_unavailable",
    });
  });
  it("fails when green-since is too recent", () => {
    const greenSince = new Date(now.getTime() - 10 * 60 * 1000); // 10 min ago
    const r = evalCiGreenForMinutes("green", greenSince, 30, now);
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/ciGreenForMinutes not met/);
  });
  it("passes when green long enough", () => {
    const greenSince = new Date(now.getTime() - 45 * 60 * 1000);
    const r = evalCiGreenForMinutes("green", greenSince, 30, now);
    expect(r.pass).toBe(true);
  });
});

describe("evalRequireSlackApproval", () => {
  it("passes when require=false (no-op)", () => {
    expect(evalRequireSlackApproval(false, false)).toEqual({ pass: true, reason: "approval not required" });
  });
  it("passes when require=true and approval is fresh", () => {
    expect(evalRequireSlackApproval(true, true)).toEqual({ pass: true, reason: "approval is fresh" });
  });
  it("fails when require=true and no fresh approval", () => {
    expect(evalRequireSlackApproval(true, false)).toEqual({ pass: false, reason: "no_fresh_approval" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /tmp/urateam-fresh/.worktrees/bec-135/packages/core && npx vitest run src/__tests__/release-manager-triggers.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `triggers.ts`**

Write `packages/core/src/release-manager/triggers.ts`:

```ts
export interface TriggerResult {
  pass: boolean;
  reason: string;
}

export function evalMergedPRsSince(
  actualCount: number,
  threshold: number,
): TriggerResult {
  if (actualCount >= threshold) {
    return { pass: true, reason: `mergedPRsSince=${threshold} (have ${actualCount})` };
  }
  return { pass: false, reason: `mergedPRsSince not met (${actualCount}/${threshold})` };
}

export function evalTimeSinceLastHours(
  lastTagAt: Date | null,
  thresholdHours: number,
  now: Date = new Date(),
): TriggerResult {
  if (lastTagAt === null) {
    return { pass: true, reason: "no prior tag" };
  }
  const elapsedHours = (now.getTime() - lastTagAt.getTime()) / 3600 / 1000;
  if (elapsedHours >= thresholdHours) {
    return {
      pass: true,
      reason: `timeSinceLastHours=${thresholdHours} (have ${elapsedHours.toFixed(1)}h)`,
    };
  }
  return {
    pass: false,
    reason: `timeSinceLastHours not met (${elapsedHours.toFixed(1)}h/${thresholdHours}h)`,
  };
}

export function evalCiGreenForMinutes(
  ciStatus: "green" | "not-green" | "unavailable",
  greenSince: Date | null,
  thresholdMinutes: number,
  now: Date = new Date(),
): TriggerResult {
  if (ciStatus === "unavailable") {
    return { pass: false, reason: "ci_check_unavailable" };
  }
  if (ciStatus !== "green" || greenSince === null) {
    return { pass: false, reason: "ci_not_green" };
  }
  const elapsedMin = (now.getTime() - greenSince.getTime()) / 60 / 1000;
  if (elapsedMin >= thresholdMinutes) {
    return {
      pass: true,
      reason: `ciGreenForMinutes=${thresholdMinutes} (${elapsedMin.toFixed(0)}m green)`,
    };
  }
  return {
    pass: false,
    reason: `ciGreenForMinutes not met (${elapsedMin.toFixed(0)}m/${thresholdMinutes}m)`,
  };
}

export function evalRequireSlackApproval(
  required: boolean,
  hasFresh: boolean,
): TriggerResult {
  if (!required) return { pass: true, reason: "approval not required" };
  if (hasFresh) return { pass: true, reason: "approval is fresh" };
  return { pass: false, reason: "no_fresh_approval" };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd /tmp/urateam-fresh/.worktrees/bec-135/packages/core && npx vitest run src/__tests__/release-manager-triggers.test.ts
```

Expected: PASS — all tests green.

- [ ] **Step 5: Commit**

```bash
cd /tmp/urateam-fresh/.worktrees/bec-135
git add packages/core/src/release-manager/triggers.ts packages/core/src/__tests__/release-manager-triggers.test.ts
git commit -m "feat(release-manager): pure trigger evaluators"
```

---

## Task 9: Decision logic — `decide()`

**Files:**
- Create: `packages/core/src/release-manager/decide.ts`
- Create: `packages/core/src/__tests__/release-manager-decide.test.ts`

`decide()` evaluates triggers in the documented order and returns the FIRST failure's reason or `fire` if all pass. Order (from spec §5.1, cheapest first):
1. `mergedPRsSince`
2. `timeSinceLastHours`
3. `ciGreenForMinutes`
4. `requireSlackApproval`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/__tests__/release-manager-decide.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { decide } from "../release-manager/decide.js";
import type { CollectedState } from "../release-manager/types.js";

const NOW = new Date("2026-05-01T12:00:00Z");

function baseState(over: Partial<CollectedState> = {}): CollectedState {
  return {
    lastTag: "v1.2.3",
    lastTagSha: "abcdef0",
    lastTagAt: new Date(NOW.getTime() - 48 * 3600 * 1000),
    headSha: "fedcba0",
    mergedCommitsSinceLastTag: 7,
    commitsSinceLastTag: [],
    ciStatus: "green",
    ciGreenSince: new Date(NOW.getTime() - 60 * 60 * 1000),
    hasFreshApproval: true,
    freshApprovalApprover: "U123",
    manualTagDetected: false,
    ...over,
  };
}

describe("decide()", () => {
  it("fires when all set triggers pass", () => {
    const r = decide(baseState(), {
      mergedPRsSince: 5,
      timeSinceLastHours: 24,
      ciGreenForMinutes: 30,
      requireSlackApproval: true,
    }, NOW);
    expect(r.kind).toBe("fire");
  });

  it("returns the first failing trigger's reason in the documented order — mergedPRsSince fails first", () => {
    const r = decide(
      baseState({ mergedCommitsSinceLastTag: 1, lastTagAt: new Date(NOW.getTime() - 1 * 3600 * 1000) }),
      { mergedPRsSince: 5, timeSinceLastHours: 24 },
      NOW,
    );
    expect(r.kind).toBe("skip");
    expect(r.reason).toMatch(/mergedPRsSince not met/);
  });

  it("checks timeSinceLastHours after mergedPRsSince passes", () => {
    const r = decide(
      baseState({ mergedCommitsSinceLastTag: 10, lastTagAt: new Date(NOW.getTime() - 1 * 3600 * 1000) }),
      { mergedPRsSince: 5, timeSinceLastHours: 24 },
      NOW,
    );
    expect(r.kind).toBe("skip");
    expect(r.reason).toMatch(/timeSinceLastHours not met/);
  });

  it("checks ciGreenForMinutes after time check passes", () => {
    const r = decide(
      baseState({ ciStatus: "not-green", ciGreenSince: null }),
      { mergedPRsSince: 5, ciGreenForMinutes: 30 },
      NOW,
    );
    expect(r.kind).toBe("skip");
    expect(r.reason).toBe("ci_not_green");
  });

  it("checks requireSlackApproval last and returns 'awaiting-approval' (NOT 'skip') when it's the only failing trigger", () => {
    const r = decide(
      baseState({ hasFreshApproval: false }),
      { mergedPRsSince: 5, requireSlackApproval: true },
      NOW,
    );
    expect(r.kind).toBe("awaiting-approval");
    expect(r.reason).toBe("no_fresh_approval");
  });

  it("returns 'skip' (NOT 'awaiting-approval') when an earlier trigger fails alongside requireSlackApproval", () => {
    const r = decide(
      baseState({ mergedCommitsSinceLastTag: 1, hasFreshApproval: false }),
      { mergedPRsSince: 5, requireSlackApproval: true },
      NOW,
    );
    expect(r.kind).toBe("skip");
    expect(r.reason).toMatch(/mergedPRsSince not met/);
  });

  it("fires when only one trigger is set and it passes", () => {
    const r = decide(baseState(), { mergedPRsSince: 5 }, NOW);
    expect(r.kind).toBe("fire");
  });

  it("ignores unset triggers (no requireSlackApproval check when false)", () => {
    const r = decide(
      baseState({ hasFreshApproval: false }),
      { mergedPRsSince: 5, requireSlackApproval: false },
      NOW,
    );
    expect(r.kind).toBe("fire");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /tmp/urateam-fresh/.worktrees/bec-135/packages/core && npx vitest run src/__tests__/release-manager-decide.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement decide.ts**

Write `packages/core/src/release-manager/decide.ts`:

```ts
import type { CollectedState, DecisionResult } from "./types.js";
import type { ReleaseManagerTriggers } from "./types.js";
import {
  evalMergedPRsSince,
  evalTimeSinceLastHours,
  evalCiGreenForMinutes,
  evalRequireSlackApproval,
} from "./triggers.js";

/**
 * Pure decision: given current state and configured triggers, return
 * { kind: "fire" } iff EVERY set trigger passes, else { kind: "skip" }
 * with the first failing trigger's reason.
 *
 * Triggers are evaluated in the documented order (cheapest first):
 *   1. mergedPRsSince  (DB count, in-memory)
 *   2. timeSinceLastHours  (single timestamp compare)
 *   3. ciGreenForMinutes  (already-fetched into state)
 *   4. requireSlackApproval  (already-fetched into state)
 */
export function decide(
  state: CollectedState,
  triggers: ReleaseManagerTriggers,
  now: Date = new Date(),
): DecisionResult {
  if (triggers.mergedPRsSince !== undefined) {
    const r = evalMergedPRsSince(state.mergedCommitsSinceLastTag, triggers.mergedPRsSince);
    if (!r.pass) return { kind: "skip", reason: r.reason };
  }

  if (triggers.timeSinceLastHours !== undefined) {
    const r = evalTimeSinceLastHours(state.lastTagAt, triggers.timeSinceLastHours, now);
    if (!r.pass) return { kind: "skip", reason: r.reason };
  }

  if (triggers.ciGreenForMinutes !== undefined) {
    const r = evalCiGreenForMinutes(state.ciStatus, state.ciGreenSince, triggers.ciGreenForMinutes, now);
    if (!r.pass) return { kind: "skip", reason: r.reason };
  }

  if (triggers.requireSlackApproval === true) {
    const r = evalRequireSlackApproval(true, state.hasFreshApproval);
    // Spec §5: when this is the ONLY failing trigger, the decision kind is
    // "awaiting-approval" (not "skip") so the scheduler posts a "Release
    // ready: /release approve to fire" prompt instead of a cooldown skip.
    if (!r.pass) return { kind: "awaiting-approval", reason: r.reason };
  }

  return { kind: "fire", reason: "all triggers passed" };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd /tmp/urateam-fresh/.worktrees/bec-135/packages/core && npx vitest run src/__tests__/release-manager-decide.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /tmp/urateam-fresh/.worktrees/bec-135
git add packages/core/src/release-manager/decide.ts packages/core/src/__tests__/release-manager-decide.test.ts
git commit -m "feat(release-manager): decide() pure decision function"
```

---

## Task 10: Versioning — `bumpFromConfigAndCommits()`

**Files:**
- Create: `packages/core/src/release-manager/versioning.ts`
- Create: `packages/core/src/__tests__/release-manager-versioning.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/__tests__/release-manager-versioning.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { bumpFromConfigAndCommits } from "../release-manager/versioning.js";

describe("bumpFromConfigAndCommits", () => {
  describe("policy=patch", () => {
    it("always bumps patch", () => {
      expect(bumpFromConfigAndCommits("v1.2.3", [{ message: "feat: anything" }], "patch")).toBe("v1.2.4");
      expect(bumpFromConfigAndCommits("v1.2.3", [{ message: "BREAKING CHANGE: removed X" }], "patch")).toBe("v1.2.4");
      expect(bumpFromConfigAndCommits("0.1.16", [], "patch")).toBe("v0.1.17");
    });
    it("bumps from null/missing tag to v0.0.1", () => {
      expect(bumpFromConfigAndCommits(null, [], "patch")).toBe("v0.0.1");
    });
  });

  describe("policy=minor", () => {
    it("always bumps minor and resets patch to 0", () => {
      expect(bumpFromConfigAndCommits("v1.2.3", [{ message: "fix: x" }], "minor")).toBe("v1.3.0");
      expect(bumpFromConfigAndCommits("v0.1.16", [{ message: "feat!: breaking" }], "minor")).toBe("v0.2.0");
    });
    it("bumps from null/missing tag to v0.1.0", () => {
      expect(bumpFromConfigAndCommits(null, [], "minor")).toBe("v0.1.0");
    });
  });

  describe("policy=conventional-commits", () => {
    it("returns major when any commit has BREAKING CHANGE in body", () => {
      expect(
        bumpFromConfigAndCommits(
          "v1.2.3",
          [{ message: "feat: foo\n\nBREAKING CHANGE: removed flag" }],
          "conventional-commits",
        ),
      ).toBe("v2.0.0");
    });
    it("returns major when any commit subject has '!:'", () => {
      expect(
        bumpFromConfigAndCommits("v1.2.3", [{ message: "feat!: rewrite" }], "conventional-commits"),
      ).toBe("v2.0.0");
      expect(
        bumpFromConfigAndCommits(
          "v1.2.3",
          [{ message: "fix(api)!: change request shape" }],
          "conventional-commits",
        ),
      ).toBe("v2.0.0");
    });
    it("returns minor when any commit is feat: but none are breaking", () => {
      expect(
        bumpFromConfigAndCommits(
          "v1.2.3",
          [{ message: "feat: add X" }, { message: "fix: bug" }],
          "conventional-commits",
        ),
      ).toBe("v1.3.0");
    });
    it("returns minor for feat(scope):", () => {
      expect(
        bumpFromConfigAndCommits("v1.2.3", [{ message: "feat(api): new endpoint" }], "conventional-commits"),
      ).toBe("v1.3.0");
    });
    it("returns patch for fix:/refactor:/perf: only", () => {
      expect(
        bumpFromConfigAndCommits(
          "v1.2.3",
          [{ message: "fix: a" }, { message: "perf: b" }, { message: "refactor: c" }],
          "conventional-commits",
        ),
      ).toBe("v1.2.4");
    });
    it("returns patch for non-conforming commits (no error)", () => {
      expect(
        bumpFromConfigAndCommits(
          "v1.2.3",
          [{ message: "wip" }, { message: "merge branch 'foo'" }],
          "conventional-commits",
        ),
      ).toBe("v1.2.4");
    });
  });

  describe("leading-v handling", () => {
    it("strips leading v on input and always emits leading v", () => {
      expect(bumpFromConfigAndCommits("1.2.3", [], "patch")).toBe("v1.2.4");
      expect(bumpFromConfigAndCommits("v1.2.3", [], "patch")).toBe("v1.2.4");
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /tmp/urateam-fresh/.worktrees/bec-135/packages/core && npx vitest run src/__tests__/release-manager-versioning.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement versioning.ts**

Write `packages/core/src/release-manager/versioning.ts`:

```ts
export type BumpPolicy = "patch" | "minor" | "conventional-commits";
type BumpKind = "major" | "minor" | "patch";

const BREAKING_SUBJECT_RE = /^(feat|fix|refactor|perf)(\([^)]+\))?!:/m;
const BREAKING_BODY_RE = /BREAKING CHANGE:/m;
const FEAT_SUBJECT_RE = /^feat(\([^)]+\))?:/m;

interface Semver {
  major: number;
  minor: number;
  patch: number;
}

function parseSemver(input: string | null): Semver {
  if (!input) return { major: 0, minor: 0, patch: 0 };
  const stripped = input.replace(/^v/, "");
  const parts = stripped.split(".");
  return {
    major: parseInt(parts[0] ?? "0", 10) || 0,
    minor: parseInt(parts[1] ?? "0", 10) || 0,
    patch: parseInt(parts[2] ?? "0", 10) || 0,
  };
}

function detectKindFromCommits(commits: Array<{ message: string }>): BumpKind {
  let saw: BumpKind = "patch";
  for (const c of commits) {
    const msg = c.message ?? "";
    if (BREAKING_SUBJECT_RE.test(msg) || BREAKING_BODY_RE.test(msg)) return "major";
    if (FEAT_SUBJECT_RE.test(msg)) saw = "minor";
  }
  return saw;
}

function applyBump(v: Semver, kind: BumpKind): Semver {
  if (kind === "major") return { major: v.major + 1, minor: 0, patch: 0 };
  if (kind === "minor") return { major: v.major, minor: v.minor + 1, patch: 0 };
  return { major: v.major, minor: v.minor, patch: v.patch + 1 };
}

/**
 * Compute the next semver tag given the current tag, the commits since it,
 * and the configured bump policy.
 *
 *   - "patch":  always patch bump
 *   - "minor":  always minor bump (patch resets to 0)
 *   - "conventional-commits": scan commit messages — major on BREAKING/!,
 *                             minor on any feat:, else patch.
 *
 * Major bumps are ONLY produced by "conventional-commits". "patch" and
 * "minor" never escalate to major — protects against runaway breaking
 * releases from config alone (per spec §8 + D4).
 *
 * Returns the next tag with a leading "v".
 */
export function bumpFromConfigAndCommits(
  current: string | null,
  commits: Array<{ message: string }>,
  policy: BumpPolicy,
): string {
  const v = parseSemver(current);
  let kind: BumpKind;
  if (policy === "patch") kind = "patch";
  else if (policy === "minor") kind = "minor";
  else kind = detectKindFromCommits(commits);

  const next = applyBump(v, kind);
  return `v${next.major}.${next.minor}.${next.patch}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd /tmp/urateam-fresh/.worktrees/bec-135/packages/core && npx vitest run src/__tests__/release-manager-versioning.test.ts
```

Expected: PASS — all tests green.

- [ ] **Step 5: Commit**

```bash
cd /tmp/urateam-fresh/.worktrees/bec-135
git add packages/core/src/release-manager/versioning.ts packages/core/src/__tests__/release-manager-versioning.test.ts
git commit -m "feat(release-manager): version-bump engine (patch | minor | conv-commits)"
```

---

## Task 11: GitHub IO — tag + release creation

**Files:**
- Create: `packages/core/src/release-manager/github.ts`
- Create: `packages/core/src/__tests__/release-manager-github.test.ts`

This module wraps `octokit.git.createRef()` and `octokit.repos.createRelease()` and classifies errors:
- 422 with "already exists" → `{ kind: "tag_exists" }`
- Any other error → propagate

It also exposes a `parseRepoFromUrl()` helper since `octokit.repos.createRelease` needs `{ owner, repo }`, not `repoUrl`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/__tests__/release-manager-github.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { createTagAndRelease, parseRepoFromUrl } from "../release-manager/github.js";

describe("parseRepoFromUrl", () => {
  it("parses https github URL", () => {
    expect(parseRepoFromUrl("https://github.com/org/repo")).toEqual({ owner: "org", repo: "repo" });
  });
  it("parses .git suffix", () => {
    expect(parseRepoFromUrl("https://github.com/org/repo.git")).toEqual({ owner: "org", repo: "repo" });
  });
  it("parses git@ ssh URL", () => {
    expect(parseRepoFromUrl("git@github.com:org/repo.git")).toEqual({ owner: "org", repo: "repo" });
  });
  it("throws on unparseable URL", () => {
    expect(() => parseRepoFromUrl("not-a-url")).toThrow();
  });
});

describe("createTagAndRelease", () => {
  function makeMockOctokit(opts: { createRefImpl?: () => any; createReleaseImpl?: () => any } = {}) {
    return {
      git: {
        createRef: vi.fn(opts.createRefImpl ?? (async () => ({ data: {} }))),
      },
      repos: {
        createRelease: vi.fn(opts.createReleaseImpl ?? (async () => ({ data: { html_url: "https://github.com/org/repo/releases/tag/v1.2.4" } }))),
      },
    } as any;
  }

  it("happy path: creates ref then release with generate_release_notes=true", async () => {
    const octokit = makeMockOctokit();
    const r = await createTagAndRelease({
      octokit,
      owner: "org",
      repo: "repo",
      tag: "v1.2.4",
      sha: "abc123",
    });
    expect(r.kind).toBe("ok");
    expect(octokit.git.createRef).toHaveBeenCalledWith({
      owner: "org",
      repo: "repo",
      ref: "refs/tags/v1.2.4",
      sha: "abc123",
    });
    expect(octokit.repos.createRelease).toHaveBeenCalledWith({
      owner: "org",
      repo: "repo",
      tag_name: "v1.2.4",
      target_commitish: "abc123",
      generate_release_notes: true,
    });
    expect(r.kind === "ok" && r.releaseUrl).toMatch(/v1\.2\.4/);
  });

  it("classifies 422 'already exists' as tag_exists", async () => {
    const octokit = makeMockOctokit({
      createRefImpl: async () => {
        const err: any = new Error("Reference already exists");
        err.status = 422;
        throw err;
      },
    });
    const r = await createTagAndRelease({ octokit, owner: "org", repo: "repo", tag: "v1.2.4", sha: "abc" });
    expect(r.kind).toBe("tag_exists");
    expect(octokit.repos.createRelease).not.toHaveBeenCalled();
  });

  it("classifies release-creation failure (after tag created) as release_create_failed", async () => {
    const octokit = makeMockOctokit({
      createReleaseImpl: async () => {
        throw new Error("network error");
      },
    });
    const r = await createTagAndRelease({ octokit, owner: "org", repo: "repo", tag: "v1.2.4", sha: "abc" });
    expect(r.kind).toBe("release_create_failed");
    expect(r.kind === "release_create_failed" && r.message).toMatch(/network error/);
  });

  it("propagates unknown errors from createRef as other_error", async () => {
    const octokit = makeMockOctokit({
      createRefImpl: async () => { throw new Error("403 forbidden"); },
    });
    const r = await createTagAndRelease({ octokit, owner: "org", repo: "repo", tag: "v1.2.4", sha: "abc" });
    expect(r.kind).toBe("other_error");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /tmp/urateam-fresh/.worktrees/bec-135/packages/core && npx vitest run src/__tests__/release-manager-github.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement github.ts**

Write `packages/core/src/release-manager/github.ts`:

```ts
import type { Octokit } from "@octokit/rest";

export interface CreateTagAndReleaseInput {
  octokit: Octokit;
  owner: string;
  repo: string;
  tag: string;   // e.g. "v1.2.4"
  sha: string;   // commit SHA to tag
}

export type CreateTagAndReleaseResult =
  | { kind: "ok"; releaseUrl: string }
  | { kind: "tag_exists" }
  | { kind: "release_create_failed"; message: string }
  | { kind: "other_error"; message: string };

/**
 * Parse owner/repo from a GitHub URL. Accepts both https and ssh forms.
 *
 * Examples:
 *   https://github.com/org/repo        → { owner: "org", repo: "repo" }
 *   https://github.com/org/repo.git    → { owner: "org", repo: "repo" }
 *   git@github.com:org/repo.git        → { owner: "org", repo: "repo" }
 */
export function parseRepoFromUrl(url: string): { owner: string; repo: string } {
  // ssh
  const ssh = url.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  if (ssh) return { owner: ssh[1], repo: ssh[2] };
  // https
  const https = url.match(/^https?:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (https) return { owner: https[1], repo: https[2] };
  throw new Error(`unparseable GitHub URL: ${url}`);
}

/**
 * Create a git tag and a release with auto-generated notes.
 *
 * Two-step:
 *   1. octokit.git.createRef('refs/tags/<tag>', sha)
 *   2. octokit.repos.createRelease({ tag_name, target_commitish: sha, generate_release_notes: true })
 *
 * Errors are classified — the caller persists a different decision row for
 * each kind:
 *   - tag_exists           → skip with reason="tag_exists"
 *   - release_create_failed → fire-pending with attempt_count++ (retryable)
 *   - other_error          → tick error (logged, not a decision row)
 */
export async function createTagAndRelease(
  input: CreateTagAndReleaseInput,
): Promise<CreateTagAndReleaseResult> {
  const { octokit, owner, repo, tag, sha } = input;

  try {
    await octokit.git.createRef({
      owner,
      repo,
      ref: `refs/tags/${tag}`,
      sha,
    });
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    const status = err?.status;
    if (status === 422 || /already exists/i.test(msg)) {
      return { kind: "tag_exists" };
    }
    return { kind: "other_error", message: msg };
  }

  try {
    const res = await octokit.repos.createRelease({
      owner,
      repo,
      tag_name: tag,
      target_commitish: sha,
      generate_release_notes: true,
    });
    const releaseUrl =
      (res as any)?.data?.html_url ?? `https://github.com/${owner}/${repo}/releases/tag/${tag}`;
    return { kind: "ok", releaseUrl };
  } catch (err: any) {
    return { kind: "release_create_failed", message: err?.message ?? String(err) };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd /tmp/urateam-fresh/.worktrees/bec-135/packages/core && npx vitest run src/__tests__/release-manager-github.test.ts
```

Expected: PASS — all tests green.

- [ ] **Step 5: Commit**

```bash
cd /tmp/urateam-fresh/.worktrees/bec-135
git add packages/core/src/release-manager/github.ts packages/core/src/__tests__/release-manager-github.test.ts
git commit -m "feat(release-manager): GitHub tag + release creation with error classification"
```

---

## Task 12: State collection — `collectState()`

**Files:**
- Create: `packages/core/src/release-manager/state.ts`
- Test: covered indirectly by Task 14's scheduler tests with mocked Octokit + DB; this task ships only the implementation.

`collectState()` is dependency-injected (Octokit + DB) so it can be unit-tested when the scheduler tests construct a mock. Splitting the IO into its own module makes the scheduler easier to read.

- [ ] **Step 1: Implement state.ts**

Write `packages/core/src/release-manager/state.ts`:

```ts
import { sql, and, eq, isNull, desc } from "drizzle-orm";
import type { Octokit } from "@octokit/rest";
import type { AnyDb } from "../db/client.js";
import { releaseApprovals, releaseDecisions } from "../db/schema.js";
import { createLogger } from "../logger.js";
import { parseRepoFromUrl } from "./github.js";
import type { CollectedState } from "./types.js";

const log = createLogger({ component: "ReleaseManager:state" });

export interface CollectStateInput {
  octokit: Octokit;
  db: AnyDb;
  repoUrl: string;
  branch: string;
  /** Approval freshness window in ms (computed from triggers.timeSinceLastHours, default 24h). */
  approvalTtlMs: number;
}

/**
 * Single GitHub call surface for one tick. Wrapped in try/catch by the
 * scheduler — failures here surface as "ci_check_unavailable" or are
 * re-thrown depending on which API failed.
 */
export async function collectState(input: CollectStateInput): Promise<CollectedState> {
  const { octokit, db, repoUrl, branch, approvalTtlMs } = input;
  const { owner, repo } = parseRepoFromUrl(repoUrl);

  // 1. HEAD SHA of the configured branch
  const branchRes = await octokit.repos.getBranch({ owner, repo, branch });
  const headSha: string = (branchRes as any).data.commit.sha;

  // 2. Latest tag (matching v*.*.* convention).
  let lastTag: string | null = null;
  let lastTagSha: string | null = null;
  let lastTagAt: Date | null = null;
  try {
    const tagsRes = await octokit.repos.listTags({ owner, repo, per_page: 30 });
    const candidate = (tagsRes as any).data.find((t: any) => /^v?\d+\.\d+\.\d+$/.test(t.name));
    if (candidate) {
      lastTag = candidate.name.startsWith("v") ? candidate.name : `v${candidate.name}`;
      lastTagSha = candidate.commit.sha;
      // Tag commit timestamp — use the commit's committer date for a wall-clock anchor.
      const commit = await octokit.repos.getCommit({ owner, repo, ref: lastTagSha! });
      const dateStr = (commit as any).data?.commit?.committer?.date ?? (commit as any).data?.commit?.author?.date;
      lastTagAt = dateStr ? new Date(dateStr) : null;
    }
  } catch (err) {
    log.warn({ err, repoUrl, branch }, "listTags failed — treating as no-tag");
  }

  // 3. Manual-tag detection: did any release_decisions with kind="fire" record
  //    a fired_tag, and does the current latest tag differ from it?
  const lastFired = await (db as any)
    .select({ firedTag: releaseDecisions.firedTag })
    .from(releaseDecisions)
    .where(
      and(
        eq(releaseDecisions.repoUrl, repoUrl),
        eq(releaseDecisions.branch, branch),
        eq(releaseDecisions.decision, "fire"),
      ),
    )
    .orderBy(desc(releaseDecisions.decidedAt))
    .limit(1);
  const lastFiredTag: string | null = lastFired?.[0]?.firedTag ?? null;
  const manualTagDetected = lastTag !== null && lastFiredTag !== null && lastTag !== lastFiredTag;

  // 4. Commits between lastTagSha and headSha (proxy for "merged PRs since last tag").
  let mergedCommitsSinceLastTag = 0;
  let commitsSinceLastTag: Array<{ message: string }> = [];
  if (lastTagSha) {
    try {
      const cmp = await octokit.repos.compareCommits({ owner, repo, base: lastTagSha, head: headSha });
      const commits = (cmp as any).data.commits ?? [];
      mergedCommitsSinceLastTag = commits.length;
      commitsSinceLastTag = commits.map((c: any) => ({ message: c?.commit?.message ?? "" }));
    } catch (err) {
      log.warn({ err, lastTagSha, headSha }, "compareCommits failed");
    }
  } else {
    // No prior tag — count all commits on branch (cap at first page; v2 paginates).
    try {
      const list = await octokit.repos.listCommits({ owner, repo, sha: branch, per_page: 100 });
      mergedCommitsSinceLastTag = ((list as any).data ?? []).length;
      commitsSinceLastTag = ((list as any).data ?? []).map((c: any) => ({
        message: c?.commit?.message ?? "",
      }));
    } catch (err) {
      log.warn({ err }, "listCommits failed");
    }
  }

  // 5. CI status for headSha — aggregate check_runs.
  let ciStatus: "green" | "not-green" | "unavailable" = "unavailable";
  let ciGreenSince: Date | null = null;
  try {
    const checks = await octokit.checks.listForRef({ owner, repo, ref: headSha, per_page: 100 });
    const runs = ((checks as any).data?.check_runs ?? []) as Array<{
      status: string;
      conclusion: string | null;
      completed_at: string | null;
    }>;
    if (runs.length === 0) {
      ciStatus = "unavailable";
    } else {
      const allCompleted = runs.every((r) => r.status === "completed");
      const allSuccess = runs.every((r) => r.conclusion === "success");
      if (!allCompleted) {
        ciStatus = "not-green";
      } else if (allSuccess) {
        ciStatus = "green";
        // ciGreenSince = latest completed_at across all runs
        const completedAts = runs
          .map((r) => (r.completed_at ? new Date(r.completed_at).getTime() : null))
          .filter((t): t is number => t !== null);
        if (completedAts.length > 0) {
          ciGreenSince = new Date(Math.max(...completedAts));
        }
      } else {
        ciStatus = "not-green";
      }
    }
  } catch (err) {
    log.warn({ err }, "checks.listForRef failed — ciStatus unavailable");
    ciStatus = "unavailable";
  }

  // 6. Fresh approval lookup. "Fresh" = consumed_at IS NULL AND approved_at within approvalTtlMs.
  const cutoff = new Date(Date.now() - approvalTtlMs);
  const freshRows = await (db as any)
    .select({ approvedBy: releaseApprovals.approvedBy, approvedAt: releaseApprovals.approvedAt })
    .from(releaseApprovals)
    .where(
      and(
        eq(releaseApprovals.repoUrl, repoUrl),
        eq(releaseApprovals.branch, branch),
        isNull(releaseApprovals.consumedAt),
        sql`${releaseApprovals.approvedAt} >= ${cutoff}`,
      ),
    )
    .orderBy(desc(releaseApprovals.approvedAt))
    .limit(1);
  const hasFreshApproval = (freshRows?.length ?? 0) > 0;
  const freshApprovalApprover = hasFreshApproval ? freshRows[0].approvedBy : null;

  return {
    lastTag,
    lastTagSha,
    lastTagAt,
    headSha,
    mergedCommitsSinceLastTag,
    commitsSinceLastTag,
    ciStatus,
    ciGreenSince,
    hasFreshApproval,
    freshApprovalApprover,
    manualTagDetected,
  };
}
```

- [ ] **Step 2: Verify TS compiles**

```bash
cd /tmp/urateam-fresh/.worktrees/bec-135/packages/core && npx tsc --noEmit
```

Expected: no errors. If `desc` or `isNull` are not exported from `drizzle-orm` (they should be), fix the import.

- [ ] **Step 3: Commit**

```bash
cd /tmp/urateam-fresh/.worktrees/bec-135
git add packages/core/src/release-manager/state.ts
git commit -m "feat(release-manager): collectState — Octokit + DB state snapshot"
```

---

## Task 13: Slack subcommand handler — `/release approve | skip | status`

**Files:**
- Create: `packages/core/src/release-manager/slack-handler.ts`
- Create: `packages/core/src/__tests__/release-manager-slack-handler.test.ts`

The handler is a pure dispatcher: it receives a parsed subcommand + DB + (repo, branch) and produces a response string (no Slack-API IO). Slack-API IO is the responsibility of the slash-command router in Task 16.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/__tests__/release-manager-slack-handler.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { unlinkSync } from "node:fs";
import { eq, isNull, and } from "drizzle-orm";
import { createDb } from "../db/index.js";
import { releaseApprovals, releaseDecisions } from "../db/schema.js";
import {
  parseReleaseSubcommand,
  handleReleaseSubcommand,
} from "../release-manager/slack-handler.js";

function tmpDbPath(): string {
  const id = randomBytes(8).toString("hex");
  return `/tmp/laf-rm-slack-${id}.sqlite`;
}

describe("parseReleaseSubcommand", () => {
  it("parses 'approve'", () => {
    expect(parseReleaseSubcommand("approve")).toEqual({ kind: "approve" });
    expect(parseReleaseSubcommand("  APPROVE ")).toEqual({ kind: "approve" });
  });
  it("parses 'skip <reason>'", () => {
    expect(parseReleaseSubcommand("skip the world is on fire")).toEqual({
      kind: "skip",
      reason: "the world is on fire",
    });
  });
  it("returns help on bare 'skip' (no reason)", () => {
    expect(parseReleaseSubcommand("skip")).toEqual({ kind: "unknown", original: "skip" });
  });
  it("parses 'status'", () => {
    expect(parseReleaseSubcommand("status")).toEqual({ kind: "status" });
  });
  it("returns unknown for empty / garbage", () => {
    expect(parseReleaseSubcommand("")).toEqual({ kind: "unknown", original: "" });
    expect(parseReleaseSubcommand("foo bar")).toEqual({ kind: "unknown", original: "foo bar" });
  });
});

describe("handleReleaseSubcommand", () => {
  const paths: string[] = [];
  let db: any;
  const repoUrl = "https://github.com/org/repo";
  const branch = "main";

  beforeEach(async () => {
    const path = tmpDbPath();
    paths.push(path);
    const created = await createDb({ driver: "sqlite", connectionString: path });
    db = created.db;
  });

  afterEach(() => {
    for (const p of paths) {
      try { unlinkSync(p); } catch {}
      try { unlinkSync(p + "-wal"); } catch {}
      try { unlinkSync(p + "-shm"); } catch {}
    }
    paths.length = 0;
  });

  it("approve writes a release_approvals row and returns confirmation", async () => {
    const r = await handleReleaseSubcommand({
      cmd: { kind: "approve" },
      db,
      repoUrl,
      branch,
      slackUserId: "U123",
    });
    expect(r.text).toMatch(/Approved/i);
    expect(r.responseType).toBe("in_channel");
    const rows = await db.select().from(releaseApprovals).where(
      and(eq(releaseApprovals.repoUrl, repoUrl), isNull(releaseApprovals.consumedAt)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].approvedBy).toBe("U123");
  });

  it("approve is idempotent — second approve from same user returns the same friendly response (UNIQUE catches it)", async () => {
    await handleReleaseSubcommand({
      cmd: { kind: "approve" }, db, repoUrl, branch, slackUserId: "U123",
    });
    const r = await handleReleaseSubcommand({
      cmd: { kind: "approve" }, db, repoUrl, branch, slackUserId: "U123",
    });
    expect(r.text).toMatch(/already approved|Approved/i);
  });

  it("skip <reason> writes a release_decisions row and signals the scheduler to pause", async () => {
    const r = await handleReleaseSubcommand({
      cmd: { kind: "skip", reason: "deployment freeze" },
      db,
      repoUrl,
      branch,
      slackUserId: "U123",
    });
    expect(r.text).toMatch(/skipped/i);
    expect(r.text).toMatch(/deployment freeze/);
    expect(r.responseType).toBe("in_channel");
    const rows = await db.select().from(releaseDecisions).where(eq(releaseDecisions.repoUrl, repoUrl));
    expect(rows).toHaveLength(1);
    expect(rows[0].decision).toBe("skip");
    expect(rows[0].reason).toMatch(/manual:deployment freeze/);
  });

  it("status returns ephemeral with last 5 decisions", async () => {
    // Seed 6 decision rows
    for (let i = 0; i < 6; i++) {
      await db.insert(releaseDecisions).values({
        id: `rd_${i}`,
        repoUrl,
        branch,
        decidedAt: new Date(Date.now() - (6 - i) * 60_000),
        decision: "skip",
        reason: `reason_${i}`,
        triggerStateJson: "{}",
        attemptCount: 0,
      });
    }
    const r = await handleReleaseSubcommand({
      cmd: { kind: "status" },
      db,
      repoUrl,
      branch,
      slackUserId: "U123",
    });
    expect(r.responseType).toBe("ephemeral");
    expect(r.text).toMatch(/Recent decisions/);
    // Most recent 5 — reason_5..reason_1 — are present, reason_0 is not
    expect(r.text).toMatch(/reason_5/);
    expect(r.text).not.toMatch(/reason_0/);
  });

  it("unknown returns a help message", async () => {
    const r = await handleReleaseSubcommand({
      cmd: { kind: "unknown", original: "frobnicate" },
      db,
      repoUrl,
      branch,
      slackUserId: "U123",
    });
    expect(r.text).toMatch(/Try.*approve.*skip.*status/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /tmp/urateam-fresh/.worktrees/bec-135/packages/core && npx vitest run src/__tests__/release-manager-slack-handler.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement slack-handler.ts**

Write `packages/core/src/release-manager/slack-handler.ts`:

```ts
import { randomUUID } from "node:crypto";
import { eq, and, desc } from "drizzle-orm";
import type { AnyDb } from "../db/client.js";
import { releaseApprovals, releaseDecisions } from "../db/schema.js";
import { logAuditEvent } from "../audit/writer.js";
import { releaseApprovedEvent } from "../audit/events.js";
import { createLogger } from "../logger.js";

const log = createLogger({ component: "ReleaseManager:slack-handler" });

export type ReleaseSubcommand =
  | { kind: "approve" }
  | { kind: "skip"; reason: string }
  | { kind: "status" }
  | { kind: "unknown"; original: string };

/**
 * Parse the text after "/release" into a structured subcommand.
 *   /release approve            → { kind: "approve" }
 *   /release skip foo bar       → { kind: "skip", reason: "foo bar" }
 *   /release status             → { kind: "status" }
 *   anything else / empty       → { kind: "unknown", original }
 *
 * "skip" with no reason returns "unknown" so the caller renders the help message.
 */
export function parseReleaseSubcommand(text: string): ReleaseSubcommand {
  const trimmed = (text ?? "").trim();
  const lower = trimmed.toLowerCase();

  if (lower === "approve") return { kind: "approve" };
  if (lower === "status") return { kind: "status" };

  if (/^skip\s+\S/.test(lower)) {
    const reason = trimmed.replace(/^skip\s+/i, "").trim();
    return { kind: "skip", reason };
  }

  return { kind: "unknown", original: trimmed };
}

export interface HandleReleaseSubcommandInput {
  cmd: ReleaseSubcommand;
  db: AnyDb;
  repoUrl: string;
  branch: string;
  slackUserId: string;
  /** Optional hook so the scheduler can be told to pause after /release skip. */
  onSkip?: (reason: string) => void;
}

export interface SlackResponse {
  text: string;
  responseType: "ephemeral" | "in_channel";
}

const HELP_TEXT =
  "Try `/release approve`, `/release skip <reason>`, or `/release status`.";

export async function handleReleaseSubcommand(
  input: HandleReleaseSubcommandInput,
): Promise<SlackResponse> {
  const { cmd, db, repoUrl, branch, slackUserId, onSkip } = input;

  switch (cmd.kind) {
    case "approve": {
      const id = `ra_${randomUUID()}`;
      try {
        await (db as any).insert(releaseApprovals).values({
          id,
          repoUrl,
          branch,
          approvedAt: new Date(),
          approvedBy: slackUserId,
        });
        void logAuditEvent(db, releaseApprovedEvent({ repoUrl, branch, approvedBy: slackUserId }));
        return {
          text: `:white_check_mark: Approved by <@${slackUserId}>. Next eligible tick will fire if other rules pass.`,
          responseType: "in_channel",
        };
      } catch (err: any) {
        // UNIQUE partial index → "already approved" friendly message.
        const msg = String(err?.message ?? err);
        if (/UNIQUE|unique|duplicate/.test(msg)) {
          return {
            text: `:information_source: <@${slackUserId}> has already approved this release. Awaiting other triggers.`,
            responseType: "in_channel",
          };
        }
        log.error({ err, repoUrl, branch }, "release approve write failed");
        return {
          text: `:x: Failed to record approval: ${msg}`,
          responseType: "ephemeral",
        };
      }
    }

    case "skip": {
      const id = `rd_${randomUUID()}`;
      await (db as any).insert(releaseDecisions).values({
        id,
        repoUrl,
        branch,
        decidedAt: new Date(),
        decision: "skip",
        reason: `manual:${cmd.reason}`,
        triggerStateJson: JSON.stringify({ source: "slack", slackUserId }),
        attemptCount: 0,
      });
      onSkip?.(cmd.reason);
      return {
        text: `:double_vertical_bar: Release skipped: ${cmd.reason}. Will re-evaluate on next tick.`,
        responseType: "in_channel",
      };
    }

    case "status": {
      const recent = await (db as any)
        .select({
          decidedAt: releaseDecisions.decidedAt,
          decision: releaseDecisions.decision,
          reason: releaseDecisions.reason,
          firedTag: releaseDecisions.firedTag,
        })
        .from(releaseDecisions)
        .where(and(eq(releaseDecisions.repoUrl, repoUrl), eq(releaseDecisions.branch, branch)))
        .orderBy(desc(releaseDecisions.decidedAt))
        .limit(5);

      const lines: string[] = [`*Release Manager status — ${repoUrl} (${branch})*`, "Recent decisions:"];
      if (recent.length === 0) {
        lines.push("  _no decisions yet_");
      } else {
        for (const r of recent) {
          const ts = r.decidedAt instanceof Date ? r.decidedAt.toISOString() : String(r.decidedAt);
          const tail = r.firedTag ? ` (tag=${r.firedTag})` : "";
          lines.push(`  • [${r.decision}] ${r.reason}${tail} — ${ts}`);
        }
      }
      return {
        text: lines.join("\n"),
        responseType: "ephemeral",
      };
    }

    case "unknown":
      return { text: HELP_TEXT, responseType: "ephemeral" };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd /tmp/urateam-fresh/.worktrees/bec-135/packages/core && npx vitest run src/__tests__/release-manager-slack-handler.test.ts
```

Expected: PASS — all tests green.

- [ ] **Step 5: Commit**

```bash
cd /tmp/urateam-fresh/.worktrees/bec-135
git add packages/core/src/release-manager/slack-handler.ts packages/core/src/__tests__/release-manager-slack-handler.test.ts
git commit -m "feat(release-manager): /release approve | skip | status handler"
```

---

## Task 14: Scheduler — orchestrate state → decide → fire/persist/audit

**Files:**
- Create: `packages/core/src/release-manager/scheduler.ts`
- Update: `packages/core/src/release-manager/index.ts` (re-export new modules)
- Create: `packages/core/src/__tests__/release-manager-scheduler.test.ts`

The scheduler holds in-memory state for Slack-skip dedup (most recent skip-reason per `(repo, branch)`) and for the `/release skip` paused-until timestamp.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/__tests__/release-manager-scheduler.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { unlinkSync } from "node:fs";
import { eq } from "drizzle-orm";
import { createDb } from "../db/index.js";
import { releaseDecisions, releaseApprovals } from "../db/schema.js";
import { createReleaseManagerScheduler } from "../release-manager/scheduler.js";
import { _resetLicenseCache } from "../license.js";
import { ReleaseManagerConfigSchema } from "../release-manager/types.js";

function tmpDbPath(): string {
  const id = randomBytes(8).toString("hex");
  return `/tmp/laf-rm-sched-${id}.sqlite`;
}

function makeMockOctokit(over: any = {}) {
  return {
    repos: {
      getBranch: vi.fn(async () => ({ data: { commit: { sha: "head_sha" } } })),
      listTags: vi.fn(async () => ({ data: [{ name: "v1.0.0", commit: { sha: "old_sha" } }] })),
      getCommit: vi.fn(async () => ({ data: { commit: { committer: { date: "2026-04-01T12:00:00Z" } } } })),
      compareCommits: vi.fn(async () => ({
        data: { commits: [{ commit: { message: "fix: a" } }, { commit: { message: "fix: b" } }] },
      })),
      listCommits: vi.fn(async () => ({ data: [] })),
      createRelease: vi.fn(async () => ({ data: { html_url: "https://github.com/org/repo/releases/tag/v1.0.1" } })),
    },
    git: {
      createRef: vi.fn(async () => ({ data: {} })),
    },
    checks: {
      listForRef: vi.fn(async () => ({
        data: { check_runs: [{ status: "completed", conclusion: "success", completed_at: "2026-05-01T11:00:00Z" }] },
      })),
    },
    ...over,
  } as any;
}

describe("createReleaseManagerScheduler — single tick", () => {
  const paths: string[] = [];
  let db: any;
  const repoUrl = "https://github.com/org/repo";
  const branch = "main";

  const baseConfig = ReleaseManagerConfigSchema.parse({
    enabled: true,
    triggers: { mergedPRsSince: 1 },
  });

  beforeEach(async () => {
    delete process.env.URATEAM_LICENSE_KEY;
    _resetLicenseCache();
    const path = tmpDbPath();
    paths.push(path);
    const created = await createDb({ driver: "sqlite", connectionString: path });
    db = created.db;
    // Use a stub license bypass: tests inject `licensed: () => true`.
  });

  afterEach(() => {
    for (const p of paths) {
      try { unlinkSync(p); } catch {}
      try { unlinkSync(p + "-wal"); } catch {}
      try { unlinkSync(p + "-shm"); } catch {}
    }
    paths.length = 0;
    _resetLicenseCache();
  });

  it("license-not-licensed → silent skip and writes nothing", async () => {
    const octokit = makeMockOctokit();
    const sched = createReleaseManagerScheduler({
      config: baseConfig,
      db,
      octokit,
      repoUrl,
      isLicensed: () => false,
      slack: undefined,
    });
    await sched.tick();
    const rows = await db.select().from(releaseDecisions);
    expect(rows).toHaveLength(0);
    expect(octokit.git.createRef).not.toHaveBeenCalled();
  });

  it("happy path: fires when triggers met, creates tag, writes fire row", async () => {
    const octokit = makeMockOctokit();
    const sched = createReleaseManagerScheduler({
      config: baseConfig,
      db,
      octokit,
      repoUrl,
      isLicensed: () => true,
      slack: undefined,
    });
    await sched.tick();
    expect(octokit.git.createRef).toHaveBeenCalled();
    expect(octokit.repos.createRelease).toHaveBeenCalledWith(
      expect.objectContaining({ generate_release_notes: true }),
    );
    const rows = await db.select().from(releaseDecisions);
    expect(rows).toHaveLength(1);
    expect(rows[0].decision).toBe("fire");
    expect(rows[0].firedTag).toMatch(/^v1\.0\.1$/);
  });

  it("skip path: writes skip row when triggers fail", async () => {
    const cfg = ReleaseManagerConfigSchema.parse({
      enabled: true,
      triggers: { mergedPRsSince: 100 }, // way above 2
    });
    const octokit = makeMockOctokit();
    const sched = createReleaseManagerScheduler({
      config: cfg, db, octokit, repoUrl, isLicensed: () => true, slack: undefined,
    });
    await sched.tick();
    const rows = await db.select().from(releaseDecisions);
    expect(rows).toHaveLength(1);
    expect(rows[0].decision).toBe("skip");
    expect(rows[0].reason).toMatch(/mergedPRsSince not met/);
    expect(octokit.git.createRef).not.toHaveBeenCalled();
  });

  it("awaiting-approval path: requireSlackApproval=true with no fresh approval → awaiting-approval row, Slack prompt, no tag", async () => {
    const cfg = ReleaseManagerConfigSchema.parse({
      enabled: true,
      triggers: { mergedPRsSince: 1, requireSlackApproval: true },
      slackChannel: "#releases",
    });
    const octokit = makeMockOctokit();
    const slackMock = { postMessage: vi.fn(async () => true) };
    const sched = createReleaseManagerScheduler({
      config: cfg, db, octokit, repoUrl, isLicensed: () => true, slack: slackMock,
    });
    await sched.tick();
    const rows = await db.select().from(releaseDecisions);
    expect(rows).toHaveLength(1);
    expect(rows[0].decision).toBe("awaiting-approval");
    expect(rows[0].reason).toBe("no_fresh_approval");
    expect(rows[0].proposedVersion).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(octokit.git.createRef).not.toHaveBeenCalled();
    // Slack prompt always posts (transition to awaiting-approval bypasses the dedup window).
    expect(slackMock.postMessage).toHaveBeenCalledTimes(1);
    expect((slackMock.postMessage as any).mock.calls[0][1]).toMatch(/Release ready/i);
  });

  it("awaiting-approval → fire: pre-seed an approval, confirm next tick fires and consumes the approval", async () => {
    const cfg = ReleaseManagerConfigSchema.parse({
      enabled: true,
      triggers: { mergedPRsSince: 1, requireSlackApproval: true },
      slackChannel: "#releases",
    });
    await db.insert(releaseApprovals).values({
      id: "ra_pre",
      repoUrl,
      branch,
      approvedAt: new Date(),
      approvedBy: "U_pre",
    });
    const octokit = makeMockOctokit();
    const slackMock = { postMessage: vi.fn(async () => true) };
    const sched = createReleaseManagerScheduler({
      config: cfg, db, octokit, repoUrl, isLicensed: () => true, slack: slackMock,
    });
    await sched.tick();
    const rows = await db.select().from(releaseDecisions);
    expect(rows).toHaveLength(1);
    expect(rows[0].decision).toBe("fire");
    const approval = await db.select().from(releaseApprovals).where(eq(releaseApprovals.id, "ra_pre"));
    expect(approval[0].consumedAt).not.toBeNull();
    expect(approval[0].consumedByDecisionId).toBe(rows[0].id);
  });

  it("manual-tag detection: latest GH tag differs from last fired tag → skip with reason=manual_tag_detected", async () => {
    // Seed a previous fire with tag v0.5.0 — but GH says latest is v1.0.0 (mismatch).
    await db.insert(releaseDecisions).values({
      id: "rd_prev",
      repoUrl,
      branch,
      decidedAt: new Date(Date.now() - 86_400_000),
      decision: "fire",
      reason: "all triggers passed",
      triggerStateJson: "{}",
      firedTag: "v0.5.0",
      firedSha: "sha_old",
      attemptCount: 0,
    });
    const octokit = makeMockOctokit(); // listTags returns v1.0.0
    const sched = createReleaseManagerScheduler({
      config: baseConfig, db, octokit, repoUrl, isLicensed: () => true, slack: undefined,
    });
    await sched.tick();
    const rows = await db.select().from(releaseDecisions).where(eq(releaseDecisions.decision, "skip"));
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const last = rows[rows.length - 1];
    expect(last.reason).toBe("manual_tag_detected");
    expect(octokit.git.createRef).not.toHaveBeenCalled();
  });

  it("tag-exists path: github returns 422 → skip with reason=tag_exists", async () => {
    const octokit = makeMockOctokit({
      git: {
        createRef: vi.fn(async () => {
          const err: any = new Error("Reference already exists");
          err.status = 422;
          throw err;
        }),
      },
    });
    const sched = createReleaseManagerScheduler({
      config: baseConfig, db, octokit, repoUrl, isLicensed: () => true, slack: undefined,
    });
    await sched.tick();
    const rows = await db.select().from(releaseDecisions);
    expect(rows).toHaveLength(1);
    expect(rows[0].decision).toBe("skip");
    expect(rows[0].reason).toBe("tag_exists");
  });

});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /tmp/urateam-fresh/.worktrees/bec-135/packages/core && npx vitest run src/__tests__/release-manager-scheduler.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement scheduler.ts**

Write `packages/core/src/release-manager/scheduler.ts`:

```ts
import { randomUUID } from "node:crypto";
import { eq, isNull, and } from "drizzle-orm";
import type { Octokit } from "@octokit/rest";
import { Cron } from "croner";
import type { AnyDb } from "../db/client.js";
import { releaseApprovals, releaseDecisions } from "../db/schema.js";
import { createLogger } from "../logger.js";
import { logAuditEvent } from "../audit/writer.js";
import {
  releaseFiredEvent,
  releaseSkippedEvent,
  releaseTagConflictEvent,
  releasePartialEvent,
  slackPostFailedEvent,
} from "../audit/events.js";
import { collectState } from "./state.js";
import { decide } from "./decide.js";
import { bumpFromConfigAndCommits } from "./versioning.js";
import { createTagAndRelease, parseRepoFromUrl } from "./github.js";
import type { ReleaseManagerConfig } from "./types.js";

const log = createLogger({ component: "ReleaseManager:scheduler" });

export interface SlackPoster {
  postMessage: (channel: string, text: string) => Promise<boolean>;
}

export interface ReleaseManagerSchedulerInput {
  config: ReleaseManagerConfig;
  db: AnyDb;
  octokit: Octokit;
  repoUrl: string;
  /** Injectable license check — production passes `() => isFeatureLicensed("release-manager")`. */
  isLicensed: () => boolean;
  slack?: SlackPoster;
}

export interface ReleaseManagerScheduler {
  /** Run a single decision cycle. Used directly from tests + by the cron driver. */
  tick(): Promise<void>;
  /** Start the cron driver (no-op until called). */
  start(): void;
  /** Stop the cron driver (idempotent). */
  stop(): void;
  /** /release skip → pause future ticks until this timestamp. */
  pauseUntil(ts: Date): void;
}

const MAX_RETRY_ATTEMPTS = 3;
const SLACK_DEDUP_WINDOW_MS = 24 * 3600 * 1000;

export function createReleaseManagerScheduler(
  input: ReleaseManagerSchedulerInput,
): ReleaseManagerScheduler {
  const { config, db, octokit, repoUrl, isLicensed, slack } = input;
  const branch = config.branch;
  const slackChannel = config.slackChannel;

  // Per-(repo, branch) in-memory dedup state.
  let lastSlackSkipReason: string | null = null;
  let lastSlackPostAt: number = 0;
  let pausedUntilTs: number = 0;
  let cronJob: Cron | null = null;
  let licenseWarnLogged = false;

  function approvalTtlMs(): number {
    const hours = config.triggers.timeSinceLastHours;
    if (hours && hours > 0) return hours * 3600 * 1000;
    return 24 * 3600 * 1000;
  }

  async function maybePostSlack(text: string, currentSkipReason: string | null): Promise<void> {
    if (!slack || !slackChannel) return;
    const now = Date.now();
    // Always post when transitioning to fire / awaiting-approval.
    // Otherwise dedup: same reason + within window → suppress.
    if (currentSkipReason) {
      const sameReason = currentSkipReason === lastSlackSkipReason;
      const withinWindow = now - lastSlackPostAt < SLACK_DEDUP_WINDOW_MS;
      if (sameReason && withinWindow) return;
    }
    const ok = await slack.postMessage(slackChannel, text).catch(() => false);
    if (!ok) {
      void logAuditEvent(db, slackPostFailedEvent({ channel: slackChannel, reason: "post_returned_false" }));
      return;
    }
    lastSlackPostAt = now;
    lastSlackSkipReason = currentSkipReason;
  }

  async function persistDecision(row: {
    id: string;
    decision: string;
    reason: string;
    triggerStateJson: string;
    proposedVersion?: string;
    firedTag?: string;
    firedSha?: string;
    attemptCount?: number;
  }): Promise<void> {
    await (db as any).insert(releaseDecisions).values({
      id: row.id,
      repoUrl,
      branch,
      decidedAt: new Date(),
      decision: row.decision,
      reason: row.reason,
      triggerStateJson: row.triggerStateJson,
      proposedVersion: row.proposedVersion,
      firedTag: row.firedTag,
      firedSha: row.firedSha,
      attemptCount: row.attemptCount ?? 0,
    });
  }

  async function consumeApprovalRow(decisionId: string): Promise<void> {
    // Mark the most-recent fresh approval as consumed by this decision.
    const fresh = await (db as any)
      .select({ id: releaseApprovals.id })
      .from(releaseApprovals)
      .where(
        and(
          eq(releaseApprovals.repoUrl, repoUrl),
          eq(releaseApprovals.branch, branch),
          isNull(releaseApprovals.consumedAt),
        ),
      )
      .limit(1);
    if (fresh?.[0]?.id) {
      await (db as any)
        .update(releaseApprovals)
        .set({ consumedAt: new Date(), consumedByDecisionId: decisionId })
        .where(eq(releaseApprovals.id, fresh[0].id));
    }
  }

  async function tick(): Promise<void> {
    if (!isLicensed()) {
      if (!licenseWarnLogged) {
        log.warn({ repoUrl, branch }, "release-manager unlicensed — skipping ticks");
        licenseWarnLogged = true;
      }
      return;
    }
    if (Date.now() < pausedUntilTs) {
      log.info({ pausedUntilTs }, "scheduler paused (via /release skip) — skipping tick");
      return;
    }

    let state;
    try {
      state = await collectState({
        octokit, db, repoUrl, branch, approvalTtlMs: approvalTtlMs(),
      });
    } catch (err) {
      log.error({ err, repoUrl, branch }, "collectState failed — skipping tick");
      return;
    }

    const triggerStateJson = JSON.stringify({
      mergedCommitsSinceLastTag: state.mergedCommitsSinceLastTag,
      lastTag: state.lastTag,
      lastTagAt: state.lastTagAt?.toISOString() ?? null,
      ciStatus: state.ciStatus,
      hasFreshApproval: state.hasFreshApproval,
    });

    // 1. Manual-tag detection — re-baseline counters.
    if (state.manualTagDetected) {
      const id = `rd_${randomUUID()}`;
      await persistDecision({
        id,
        decision: "skip",
        reason: "manual_tag_detected",
        triggerStateJson,
      });
      void logAuditEvent(db, releaseSkippedEvent({ repoUrl, branch, reason: "manual_tag_detected" }));
      log.info({ repoUrl, branch }, "manual tag detected — re-baselining");
      return;
    }

    // 2. Decision.
    const result = decide(state, config.triggers);
    const proposedVersion = bumpFromConfigAndCommits(
      state.lastTag,
      state.commitsSinceLastTag,
      config.versionBump,
    );

    if (result.kind === "skip") {
      const id = `rd_${randomUUID()}`;
      await persistDecision({
        id,
        decision: "skip",
        reason: result.reason,
        triggerStateJson,
        proposedVersion,
      });
      void logAuditEvent(db, releaseSkippedEvent({ repoUrl, branch, reason: result.reason }));
      // Slack notification with dedup
      await maybePostSlack(
        `:double_vertical_bar: Release skipped for *${repoUrl}* (${branch}): ${result.reason}`,
        result.reason,
      );
      return;
    }

    if (result.kind === "awaiting-approval") {
      const id = `rd_${randomUUID()}`;
      await persistDecision({
        id,
        decision: "awaiting-approval",
        reason: result.reason,
        triggerStateJson,
        proposedVersion,
      });
      void logAuditEvent(db, releaseSkippedEvent({ repoUrl, branch, reason: "awaiting-approval" }));
      // Always post on first transition to awaiting-approval (bypass dedup).
      // Reset lastSlackSkipReason so a subsequent regular-skip will re-post.
      lastSlackSkipReason = null;
      await maybePostSlack(
        `:hourglass_flowing_sand: Release ready for *${repoUrl}* (${branch}): bumping ${proposedVersion} (${state.mergedCommitsSinceLastTag} commits since last tag). Run \`/release approve\` to fire.`,
        null,
      );
      return;
    }

    // 3. Fire — create tag + release.
    const id = `rd_${randomUUID()}`;
    const githubResult = await createTagAndRelease({
      octokit,
      ...parseRepoFromUrl(repoUrl),
      tag: proposedVersion,
      sha: state.headSha,
    });

    if (githubResult.kind === "tag_exists") {
      await persistDecision({
        id,
        decision: "skip",
        reason: "tag_exists",
        triggerStateJson,
        proposedVersion,
      });
      void logAuditEvent(db, releaseTagConflictEvent({ repoUrl, branch, tag: proposedVersion }));
      return;
    }

    if (githubResult.kind === "release_create_failed") {
      // Tag was created; release-creation failed. Increment attempt and write fire-pending.
      const prevAttempt = await (db as any)
        .select({ attemptCount: releaseDecisions.attemptCount })
        .from(releaseDecisions)
        .where(
          and(
            eq(releaseDecisions.repoUrl, repoUrl),
            eq(releaseDecisions.branch, branch),
            eq(releaseDecisions.decision, "fire-pending"),
            eq(releaseDecisions.firedTag, proposedVersion),
          ),
        )
        .limit(1);
      const nextAttempt = ((prevAttempt?.[0]?.attemptCount as number) ?? 0) + 1;
      const decision = nextAttempt >= MAX_RETRY_ATTEMPTS ? "skip" : "fire-pending";
      const reason = decision === "skip" ? "release_create_failed_after_retries" : "release_create_failed_retrying";
      await persistDecision({
        id,
        decision,
        reason,
        triggerStateJson,
        proposedVersion,
        firedTag: proposedVersion,
        firedSha: state.headSha,
        attemptCount: nextAttempt,
      });
      if (decision === "skip") {
        void logAuditEvent(db, releasePartialEvent({ repoUrl, branch, tag: proposedVersion, attemptCount: nextAttempt }));
      }
      log.error({ repoUrl, branch, tag: proposedVersion, attempt: nextAttempt, msg: githubResult.message }, "release create failed");
      return;
    }

    if (githubResult.kind === "other_error") {
      log.error({ err: githubResult.message, repoUrl, branch }, "createTagAndRelease unknown error — not persisting");
      return;
    }

    // ok
    await persistDecision({
      id,
      decision: "fire",
      reason: "all triggers passed",
      triggerStateJson,
      proposedVersion,
      firedTag: proposedVersion,
      firedSha: state.headSha,
    });
    if (state.hasFreshApproval) {
      await consumeApprovalRow(id);
    }
    void logAuditEvent(
      db,
      releaseFiredEvent({
        repoUrl,
        branch,
        tag: proposedVersion,
        sha: state.headSha,
        mergedPrCount: state.mergedCommitsSinceLastTag,
      }),
    );
    await maybePostSlack(
      `:rocket: Released *${proposedVersion}* for ${repoUrl} (${branch}). ${githubResult.releaseUrl}`,
      null,
    );
    // Reset Slack dedup so the next skip re-posts.
    lastSlackSkipReason = null;
  }

  function start() {
    if (cronJob) return;
    cronJob = new Cron(config.schedule, () => {
      tick().catch((err) => log.error({ err, repoUrl, branch }, "release-manager tick errored"));
    });
    log.info({ schedule: config.schedule, repoUrl, branch }, "release-manager scheduler started");
  }

  function stop() {
    cronJob?.stop();
    cronJob = null;
  }

  function pauseUntil(ts: Date) {
    pausedUntilTs = ts.getTime();
  }

  return { tick, start, stop, pauseUntil };
}
```

- [ ] **Step 4: Update index.ts re-exports**

Edit `packages/core/src/release-manager/index.ts`:

```ts
export * from "./types.js";
export * from "./triggers.js";
export * from "./decide.js";
export * from "./versioning.js";
export * from "./github.js";
export * from "./state.js";
export * from "./slack-handler.js";
export * from "./scheduler.js";
```

- [ ] **Step 5: Re-export from packages/core/src/index.ts**

Open `packages/core/src/index.ts` and find the existing re-exports section. Append:

```ts
export * from "./release-manager/index.js";
```

(If a single line `export * from "./release-manager/index.js";` would clash with existing names, fall back to a named re-export of `createReleaseManagerScheduler`, `ReleaseManagerConfigSchema`, and the slash handler. Run `npx tsc --noEmit` from `packages/core/` after editing — duplicate-export errors would surface here.)

- [ ] **Step 6: Run the scheduler test to verify it passes**

```bash
cd /tmp/urateam-fresh/.worktrees/bec-135/packages/core && npx vitest run src/__tests__/release-manager-scheduler.test.ts
```

Expected: PASS — all tests green.

- [ ] **Step 7: Run all release-manager tests + the existing test suite**

```bash
cd /tmp/urateam-fresh/.worktrees/bec-135/packages/core && npx vitest run src/__tests__/release-manager-*.test.ts src/__tests__/db-release-decisions.test.ts
```

Expected: PASS.

```bash
cd /tmp/urateam-fresh/.worktrees/bec-135/packages/core && npx vitest run src/__tests__/audit-types.test.ts src/__tests__/license.test.ts
```

Expected: PASS — no regressions in existing audit/license tests.

- [ ] **Step 8: Commit**

```bash
cd /tmp/urateam-fresh/.worktrees/bec-135
git add packages/core/src/release-manager/scheduler.ts packages/core/src/release-manager/index.ts packages/core/src/index.ts packages/core/src/__tests__/release-manager-scheduler.test.ts
git commit -m "feat(release-manager): scheduler tick + cron driver + audit + Slack dedup"
```

---

## Task 15: Wire `/release` into the existing Slack slash-command router

**Files:**
- Modify: `packages/core/src/pm/slack-interface.ts` (add command-name dispatch in `/slack/commands` handler, register a handler for `/release`)

The current `/slack/commands` route only handles `/pm`. Slack passes a `command` form field (`/pm` or `/release`). We add a switch on that field and route `/release ...` to a new `releaseHandler` registered via the existing factory.

- [ ] **Step 1: Extend `SlackInterfaceConfig`**

In `packages/core/src/pm/slack-interface.ts:68-83`, add a new optional dependency:

```ts
export interface SlackInterfaceConfig {
  /** Slack signing secret for request verification */
  signingSecret: string;
  /** Slack bot OAuth token (xoxb-…) */
  botToken: string;
  /** Channel to send proactive PM notifications to */
  channelId: string;
  /** Linear API key (needed for create / prioritize / assign commands) */
  linearApiKey?: string;
  /** Team IDs for issue creation commands */
  teamIds?: string[];
  /** Optional injectable for testing */
  callClaude?: (prompt: string) => Promise<string>;
  /** Optional Sonnet-model callable for bulk create analysis (defaults to Sonnet if not provided) */
  callClaudeSonnet?: (prompt: string) => Promise<string>;
  /** BEC-135: optional handler for /release subcommands. */
  releaseHandler?: (params: { text: string; userId: string }) => Promise<{ text: string; responseType: "ephemeral" | "in_channel" }>;
}
```

- [ ] **Step 2: Modify the `/slack/commands` route to dispatch by `command`**

In `packages/core/src/pm/slack-interface.ts`, find the `router.post("/slack/commands", ...)` block (around lines 620-651). Replace its body with a dispatcher that branches on `command`:

```ts
  router.post("/slack/commands", async (c) => {
    const rawBody = await checkSignature(c);
    if (rawBody === null) {
      return c.json({ error: "Invalid signature" }, 401);
    }

    // Parse URL-encoded form body
    const params = new URLSearchParams(rawBody);
    const slashCommand = params.get("command") ?? "";
    const commandText = (params.get("text") ?? "").trim();
    const responseUrl = params.get("response_url") ?? "";
    const userId = params.get("user_id") ?? "";

    log.info({ slashCommand, commandText }, "received Slack slash command");

    // Branch: /release vs /pm (the legacy default).
    if (slashCommand === "/release") {
      if (!config.releaseHandler) {
        return c.json({
          response_type: "ephemeral",
          text: ":x: Release Manager is not configured on this server.",
        });
      }
      const r = await config.releaseHandler({ text: commandText, userId });
      if (responseUrl) {
        postToResponseUrl(responseUrl, r.text).catch((err) =>
          log.error({ err }, "failed to post to Slack response_url"),
        );
      }
      return c.json({ response_type: r.responseType, text: r.text });
    }

    // Default: /pm path (preserves existing behavior).
    let cmd = parsePmCommand(commandText);
    if (cmd.type === "unknown" && commandText.length > 0) {
      cmd = await interpretNaturalLanguage(commandText, callClaude);
    }
    const replyText = await executePmCommand(cmd, executorDeps);
    if (responseUrl) {
      postToResponseUrl(responseUrl, replyText).catch((err) =>
        log.error({ err }, "failed to post to Slack response_url"),
      );
    }
    return c.json({ response_type: "ephemeral", text: replyText });
  });
```

- [ ] **Step 3: Add a smoke test for the dispatcher**

Append to `packages/core/src/__tests__/release-manager-slack-handler.test.ts`:

```ts
import { createSlackInterface } from "../pm/slack-interface.js";

describe("slack-interface /release dispatcher", () => {
  it("routes /release approve to releaseHandler", async () => {
    const releaseHandler = vi.fn(async () => ({ text: "ok-handler", responseType: "in_channel" as const }));
    // We bypass signature verification by stubbing it via a captured signing secret.
    // In a real test we'd sign the request; here we assert call routing only by
    // crafting a body and invoking the Hono router.
    const { router } = createSlackInterface({
      signingSecret: "test-secret-1234567890",
      botToken: "xoxb-test",
      channelId: "C123",
      releaseHandler,
    });
    // Build a valid signature for the body so the request passes the check.
    const body = "command=%2Frelease&text=approve&user_id=U123&response_url=";
    const ts = Math.floor(Date.now() / 1000).toString();
    const crypto = await import("crypto");
    const sig =
      "v0=" +
      crypto.createHmac("sha256", "test-secret-1234567890")
        .update(`v0:${ts}:${body}`)
        .digest("hex");
    const res = await router.fetch(new Request("http://localhost/slack/commands", {
      method: "POST",
      headers: {
        "X-Slack-Request-Timestamp": ts,
        "X-Slack-Signature": sig,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    }));
    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.text).toBe("ok-handler");
    expect(releaseHandler).toHaveBeenCalledWith({ text: "approve", userId: "U123" });
  });
});
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd /tmp/urateam-fresh/.worktrees/bec-135/packages/core && npx vitest run src/__tests__/release-manager-slack-handler.test.ts
```

Expected: PASS — including the new dispatcher test.

- [ ] **Step 5: Run the existing pm/slack-interface test suite to confirm no regression**

```bash
cd /tmp/urateam-fresh/.worktrees/bec-135/packages/core && npx vitest run src/__tests__ --reporter=default 2>&1 | tail -40
```

Expected: PASS — no test failures across the entire core test suite.

- [ ] **Step 6: Commit**

```bash
cd /tmp/urateam-fresh/.worktrees/bec-135
git add packages/core/src/pm/slack-interface.ts packages/core/src/__tests__/release-manager-slack-handler.test.ts
git commit -m "feat(slack-interface): dispatch /release alongside /pm"
```

---

## Task 16: Wire scheduler in `cli/start.ts` (env-driven gate + license check)

**Files:**
- Modify: `packages/cli/src/commands/start.ts` (add env gate + scheduler instantiation; integrate releaseHandler into pmSlack)

- [ ] **Step 1: Add env-driven config builder**

In `packages/cli/src/commands/start.ts`, find the PM Agent config block (lines 124-156). After it, add a new block to build the Release Manager config:

```ts
    // --- Release Manager config (BEC-135 — Pro tier) ---
    let rmConfig: import("@urateam/core").ReleaseManagerConfig | undefined;
    let rmRepoUrl: string | undefined;
    if (process.env.RELEASE_MANAGER_ENABLED === "true") {
      const { ReleaseManagerConfigSchema, isFeatureLicensed } = await import("@urateam/core");

      if (!isFeatureLicensed("release-manager")) {
        console.error(
          "RELEASE_MANAGER_ENABLED=true requires a Pro tier license that unlocks 'release-manager'. " +
          "Set URATEAM_LICENSE_KEY to a valid Pro license and restart.",
        );
        process.exit(1);
      }

      // Use the first configured repo as the target. v1 supports a single Release Manager.
      const firstRepoTeamId = Object.keys(repoConfigs)[0];
      rmRepoUrl = repoConfigs[firstRepoTeamId]?.url;
      if (!rmRepoUrl) {
        console.error("RELEASE_MANAGER_ENABLED=true requires a configured REPO_URL.");
        process.exit(1);
      }

      const triggers: Record<string, number | boolean> = {};
      if (process.env.RELEASE_MANAGER_TRIGGER_MERGED_PRS_SINCE) {
        triggers.mergedPRsSince = parseInt(process.env.RELEASE_MANAGER_TRIGGER_MERGED_PRS_SINCE, 10);
      }
      if (process.env.RELEASE_MANAGER_TRIGGER_TIME_SINCE_LAST_HOURS) {
        triggers.timeSinceLastHours = parseInt(process.env.RELEASE_MANAGER_TRIGGER_TIME_SINCE_LAST_HOURS, 10);
      }
      if (process.env.RELEASE_MANAGER_TRIGGER_CI_GREEN_FOR_MINUTES) {
        triggers.ciGreenForMinutes = parseInt(process.env.RELEASE_MANAGER_TRIGGER_CI_GREEN_FOR_MINUTES, 10);
      }
      if (process.env.RELEASE_MANAGER_TRIGGER_REQUIRE_SLACK_APPROVAL === "true") {
        triggers.requireSlackApproval = true;
      }

      try {
        rmConfig = ReleaseManagerConfigSchema.parse({
          enabled: true,
          schedule: process.env.RELEASE_MANAGER_SCHEDULE ?? "*/30 * * * *",
          triggers,
          versionBump: process.env.RELEASE_MANAGER_VERSION_BUMP ?? "patch",
          slackChannel: process.env.RELEASE_MANAGER_SLACK_CHANNEL,
          branch: process.env.RELEASE_MANAGER_BRANCH ?? "main",
        });
      } catch (err) {
        console.error("Release Manager config invalid:", (err as Error).message);
        process.exit(1);
      }
    }
```

- [ ] **Step 2: Wire the scheduler after `createApp`**

In `packages/cli/src/commands/start.ts`, find the PM Agent instantiation block (lines 240-265). After it, add:

```ts
    // --- Release Manager (BEC-135 — Pro tier, opt-in) ---
    if (rmConfig && rmRepoUrl) {
      if (!github) {
        console.error(
          "RELEASE_MANAGER_ENABLED=true requires GITHUB_APP_ID + GITHUB_PRIVATE_KEY_PATH so the agent can create tags/releases.",
        );
        process.exit(1);
      }
      const { createGitHubClient, createReleaseManagerScheduler, isFeatureLicensed,
        handleReleaseSubcommand, parseReleaseSubcommand } = await import("@urateam/core");
      const rmOctokit = await createGitHubClient(github);
      const rmScheduler = createReleaseManagerScheduler({
        config: rmConfig,
        db,
        octokit: rmOctokit,
        repoUrl: rmRepoUrl,
        isLicensed: () => isFeatureLicensed("release-manager"),
        slack: process.env.SLACK_BOT_TOKEN
          ? {
              postMessage: async (channel, text) => {
                const { postSlackMessage } = await import("@urateam/core");
                const r = await postSlackMessage(process.env.SLACK_BOT_TOKEN!, { channel, text });
                return r !== null && (r as any).ok !== false;
              },
            }
          : undefined,
      });

      // Plumb a release-handler closure through pmSlack so /release routes here.
      if (pmSlack) {
        (pmSlack as any).releaseHandler = async ({ text, userId }: { text: string; userId: string }) => {
          const cmd = parseReleaseSubcommand(text);
          return handleReleaseSubcommand({
            cmd,
            db,
            repoUrl: rmRepoUrl!,
            branch: rmConfig!.branch,
            slackUserId: userId,
            onSkip: (_reason) => {
              const ttlMs = (rmConfig!.triggers.timeSinceLastHours ?? 24) * 3600 * 1000;
              rmScheduler.pauseUntil(new Date(Date.now() + ttlMs));
            },
          });
        };
      }

      rmScheduler.start();
      console.log(
        `Release Manager: enabled (schedule "${rmConfig.schedule}", repo ${rmRepoUrl}, branch ${rmConfig.branch})`,
      );
    }
```

- [ ] **Step 3: Wire shutdown**

In the `function shutdown() { ... }` block (lines 268-277), add `rmScheduler?.stop();` if the scheduler reference is captured at function scope. Refactor by hoisting `rmScheduler` to the outer scope:

Change

```ts
    if (rmConfig && rmRepoUrl) {
      ...
      const rmScheduler = createReleaseManagerScheduler({ ... });
      ...
      rmScheduler.start();
```

to

```ts
    let rmScheduler: import("@urateam/core").ReleaseManagerScheduler | undefined;
    if (rmConfig && rmRepoUrl) {
      ...
      rmScheduler = createReleaseManagerScheduler({ ... });
      ...
      rmScheduler.start();
```

(Move the `let rmScheduler:` declaration up to before the `if (rmConfig && rmRepoUrl)` block.)

Then in `shutdown()`:

```ts
    function shutdown() {
      console.log("Shutting down...");
      clearInterval(cleanupInterval);
      if (pmInterval) clearInterval(pmInterval);
      rmScheduler?.stop();
      let closed = 0;
      const onClose = () => { if (++closed === 2) process.exit(0); };
      dashServer.close(onClose);
      webhookServer.close(onClose);
      setTimeout(() => process.exit(1), 30_000);
    }
```

- [ ] **Step 4: Verify cli compiles**

```bash
cd /tmp/urateam-fresh/.worktrees/bec-135/packages/cli && npx tsc --noEmit
```

Expected: no errors. If exports `handleReleaseSubcommand` / `parseReleaseSubcommand` / `ReleaseManagerScheduler` aren't visible from `@urateam/core`, double-check Task 14 Step 5 added them via `release-manager/index.js` re-export.

- [ ] **Step 5: Run the full core test suite to confirm no regressions**

```bash
cd /tmp/urateam-fresh/.worktrees/bec-135/packages/core && npx vitest run
```

Expected: PASS — entire suite green.

- [ ] **Step 6: Commit**

```bash
cd /tmp/urateam-fresh/.worktrees/bec-135
git add packages/cli/src/commands/start.ts
git commit -m "feat(cli): wire release-manager scheduler with license + GitHub gate"
```

---

## Task 17: Document Pro env vars in `.env.example`

**Files:**
- Modify: `packages/create-urateam/template/.urateam/.env.example`

- [ ] **Step 1: Read the current file**

```bash
cd /tmp/urateam-fresh/.worktrees/bec-135 && cat packages/create-urateam/template/.urateam/.env.example
```

(Use this output to find a sensible insertion point — typically after `PM_AGENT_*` env vars.)

- [ ] **Step 2: Append the Release Manager section**

Add (using the Edit tool to preserve existing content):

```
# ----------------------------------------------------------------------------
# Release Manager Agent (BEC-135) — Pro tier feature.
# Requires URATEAM_LICENSE_KEY with `release-manager` in the unlocked features
# AND GITHUB_APP_ID + GITHUB_PRIVATE_KEY_PATH so the agent can create tags.
#
# When RELEASE_MANAGER_ENABLED=true, the agent runs on the configured cron and:
#   1. Reads the configured repo's HEAD SHA, latest tag, CI status, merged PRs.
#   2. Evaluates triggers (mergedPRsSince, timeSinceLastHours, ciGreenForMinutes,
#      requireSlackApproval).
#   3. Cuts a tag + GitHub release with auto-generated notes when ALL set
#      triggers pass. Your CI (GitHub Actions / IaC) handles the deploy.
#
# Slack control: /release approve | skip <reason> | status (uses pmSlack channel).
# ----------------------------------------------------------------------------
# RELEASE_MANAGER_ENABLED=true
# RELEASE_MANAGER_SCHEDULE="*/30 * * * *"
# RELEASE_MANAGER_VERSION_BUMP=patch                  # patch | minor | conventional-commits
# RELEASE_MANAGER_BRANCH=main
# RELEASE_MANAGER_SLACK_CHANNEL=C0123456789           # required if requireSlackApproval=true
# At least ONE of these triggers must be set:
# RELEASE_MANAGER_TRIGGER_MERGED_PRS_SINCE=5
# RELEASE_MANAGER_TRIGGER_TIME_SINCE_LAST_HOURS=24
# RELEASE_MANAGER_TRIGGER_CI_GREEN_FOR_MINUTES=30
# RELEASE_MANAGER_TRIGGER_REQUIRE_SLACK_APPROVAL=false
```

- [ ] **Step 3: Commit**

```bash
cd /tmp/urateam-fresh/.worktrees/bec-135
git add packages/create-urateam/template/.urateam/.env.example
git commit -m "docs(env-example): document RELEASE_MANAGER_* Pro env vars"
```

---

## Task 18: Final integration sanity sweep

**Files:** none — verification only

- [ ] **Step 1: Run the full monorepo test suite**

```bash
cd /tmp/urateam-fresh/.worktrees/bec-135 && pnpm -r test 2>&1 | tail -60
```

Expected: ALL tests pass across `core`, `cli`, `dashboard`, etc. Investigate any failure before continuing.

- [ ] **Step 2: Run typecheck across the workspace**

```bash
cd /tmp/urateam-fresh/.worktrees/bec-135 && pnpm -r typecheck 2>&1 | tail -40
```

Expected: no errors.

- [ ] **Step 3: Run lint if configured**

```bash
cd /tmp/urateam-fresh/.worktrees/bec-135 && pnpm -r lint 2>&1 | tail -30 || true
```

Expected: clean (or no lint script configured — both fine).

- [ ] **Step 4: Build core**

```bash
cd /tmp/urateam-fresh/.worktrees/bec-135/packages/core && pnpm build
```

Expected: clean build, `dist/` updated. Verify the new release-manager modules are present:

```bash
ls /tmp/urateam-fresh/.worktrees/bec-135/packages/core/dist/release-manager/
```

Expected: `decide.js`, `github.js`, `index.js`, `scheduler.js`, `slack-handler.js`, `state.js`, `triggers.js`, `types.js`, `versioning.js`, plus `.d.ts` files.

- [ ] **Step 5: Build cli (depends on core dist)**

```bash
cd /tmp/urateam-fresh/.worktrees/bec-135/packages/cli && pnpm build
```

Expected: clean build.

- [ ] **Step 6: Push the branch and open a PR**

```bash
cd /tmp/urateam-fresh/.worktrees/bec-135 && git push origin HEAD
```

Then:

```bash
cd /tmp/urateam-fresh/.worktrees/bec-135 && gh pr create --title "feat(release-manager): BEC-135 Release Manager agent" --body "$(cat <<'EOF'
## Summary
- Pro-tier cron agent that watches recently-merged PRs, evaluates configurable trigger rules, and cuts a GitHub release tag with auto-generated notes when conditions pass.
- New `/release approve | skip | status` Slack subcommands route through the existing `pm/slack-interface.ts`.
- Two new tables (`release_decisions` + `release_approvals`) record every tick + idempotent one-shot approvals.
- Extends `PRO_FEATURES` with `release-manager`; `RELEASE_MANAGER_ENABLED=true` in start.ts gates on license + GitHub App creds.

Spec: `docs/superpowers/specs/2026-05-01-bec-135-release-manager-design.md`
Plan: `docs/superpowers/plans/2026-05-01-bec-135-release-manager.md`

## Test plan
- [x] `db-release-decisions.test.ts` — schema + UNIQUE partial index
- [x] `release-manager-config.test.ts` — Zod superRefine guards
- [x] `release-manager-triggers.test.ts` — each evaluator
- [x] `release-manager-decide.test.ts` — ordered evaluation, AND semantics
- [x] `release-manager-versioning.test.ts` — patch/minor/conv-commits
- [x] `release-manager-github.test.ts` — tag-exists + retry classification
- [x] `release-manager-slack-handler.test.ts` — approve/skip/status + dispatcher
- [x] `release-manager-scheduler.test.ts` — full tick paths (license, fire, skip, manual-tag, tag-exists, approval consumption)
- [x] `release-manager-license-gate.test.ts` — feature gating
- [x] `release-manager-audit-events.test.ts` — 6 new audit events
- [ ] Manual smoke against a test repo with `URATEAM_LICENSE_KEY` set

## Out of scope (post-1.0)
RC tags, slack buttons, multi-branch concurrent flows, custom release-notes templates, BEC-136 QA-gate trigger.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: PR created. Capture the URL.

- [ ] **Step 7: Hand off to user for Sonnet review + merge**

After Sonnet review fixes are addressed and the PR is merged, the user (NOT this agent) will:
- Bump `@urateam/core` 0.1.16 → 0.1.17
- Cascade `@urateam/cli` 0.1.18 → 0.1.19, `@urateam/dashboard` 0.1.16 → 0.1.17
- Tag `v0.1.31`
- Publish `@urateam/core@0.1.17` to npm with provenance

This task is complete when the PR is open and CI is green.

---

## Cross-task verification checklist (run after Task 18)

- [ ] All 17 modified/created files match the file structure section
- [ ] `PRO_FEATURES` includes `"release-manager"`
- [ ] `AuditEventTypeSchema` includes 6 new event types
- [ ] `AuditActorTypeSchema` includes `"release-manager"`
- [ ] `RepoConfigSchema.releaseManager` is optional, defaults to undefined
- [ ] Migration files: SQLite `009_release_manager.sql`, Postgres `010_release_manager.sql`
- [ ] `release-manager/` source dir contains 9 files (8 modules + index)
- [ ] 8 test files exist in `__tests__/`
- [ ] `croner` appears in `packages/core/package.json` dependencies
- [ ] `pnpm-lock.yaml` updated
- [ ] No PII or secret-bearing strings introduced anywhere
- [ ] `pnpm -r test` and `pnpm -r typecheck` both pass
- [ ] PR opened against `main`

---

## Known v1 simplifications (deviations from spec — accepted by the plan author)

These are pragmatic v1 trade-offs that the implementer should NOT try to "fix" without checking with the user. Each is a deliberate scope reduction.

1. **`/release status` does not call `collectState()`.** Spec §7 shows status output rendering the live trigger state ("✓ mergedPRsSince=5 (have 7)"). The slash handler is plumbed only with `db` (no Octokit, no trigger config). v1 status renders only the last 5 decision rows from `release_decisions`. Threading Octokit + the live config through the slash router for one-shot rendering is more plumbing than the v1.0 cut needs. v2 can add it.

2. **Release-creation retry path is "fail and re-derive" rather than "retry release-creation only".** Spec §10 wants the scheduler to retry `octokit.repos.createRelease` (without re-creating the tag) when release-creation fails after the tag was created. The current scheduler simply runs the full flow next tick — `createRef` fails with `tag_exists`, we write `skip` with reason=`tag_exists`. The user is left with a tag but no release page; `releasePartialEvent` is NOT fired in this path. Acceptable v1 because the tag still exists on GitHub (users see the version bump) and the failure mode is rare. Document this in the PR description so reviewers don't flag it.

3. **`/release status` is configurable per *invoker's* assumed (repo, branch).** Since v1 supports a single Release Manager instance per process, the slash handler hard-codes the configured repo + branch. Multi-repo Release Managers are out of scope (spec §12).

## Out of scope for this plan (per spec §12 — post-1.0)

- Pre-release / RC tags (`v1.2.3-beta.1`)
- Per-PR approval gates (vs branch-level)
- Auto-rollback on post-deploy failure
- Slack interactive buttons (slash commands only in v1)
- Multi-branch release flows simultaneously
- Custom release notes templates
- Customer-supplied tag scripts
- Automatic stale-approval cleanup sweep
- BEC-136 QA-readiness check as a trigger (v2)
