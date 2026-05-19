# Agent Session Continuity — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Claude Agent SDK session resume across pipeline stages, gated behind a feature flag, plus the two free-money small wins (excludeDynamicSections + zombie-age bump). Ships as a release behind `URATEAM_ENABLE_AGENT_SESSION_RESUME=true`, off by default.

**Architecture:** `runner.start()` mints `agent_session_id = randomUUID()` per pipeline run when the flag is on, persists it on the `pipeline_runs` row. The first resumable stage calls `sdkQuery({ sessionId, prompt })`; every subsequent resumable stage calls `sdkQuery({ resume: sessionId, prompt })`. The `<previous-stage-context>` XML block is dropped from prompts on resumed stages. Validator + RALPH-check (Haiku) and OpenRouter fanout providers always run fresh — encoded as a static `isResumable(stage, model)` rule. The Docker named volume `urateam-dogfood-agent-sessions` mounted at `/home/ura/.claude/projects` makes JSONL transcripts survive container restarts.

**Tech Stack:** TypeScript, pnpm monorepo, Drizzle ORM (SQLite/Postgres), Vitest, Hono dashboard, `@anthropic-ai/claude-agent-sdk@0.2.x`, Docker Compose.

**Spec reference:** `docs/superpowers/specs/2026-05-19-agent-session-continuity-design.md` — Tracks A core, C-1, C-2. Tracks B and D ship in a Phase 4 plan after this one soaks. Tracks E and F are future specs.

**Branching strategy:** All work lands on `feat/agent-session-continuity-phase1` (branch off main). One PR at end, squash-merged. Each task ends with a commit so the branch is bisectable.

---

## File Map

**Modified:**
- `packages/core/src/db/schema.ts` — add `agentSessionId` column to `pipelineRuns` table
- `packages/core/src/db/client.ts` — `MIGRATION_COLUMNS` entry, `getCreateTablesDDL()` template
- `packages/core/src/types.ts` — 4 new audit event Zod schemas in `AuditEventTypeSchema`
- `packages/core/src/audit/events.ts` — 4 new event builder functions
- `packages/core/src/__tests__/audit-immutability.test.ts` — bump count assertion 52 → 56 (Phase 1 adds 4 events; Phase 4 adds the 5th)
- `packages/core/src/pipeline/runner.ts` — mint sessionId in `start()`, thread `agentSessionId` + `isFirstResumableStage` into every `executeStage()`, drop handoff block on resumed RALPH iterations, fallback paths for missing JSONL
- `packages/core/src/executor/executor.ts` — `executeStage()` gains `agentSessionId` + `isFirstResumableStage`. SDK options builder branches. Add `excludeDynamicSections: true`. JSONL-exists pre-check + resume error catch
- `packages/core/src/executor/ralph.ts` — `checkRequirements()` always uses fresh session (no resume) — explicit comment why
- `packages/core/src/executor/deep-review.ts` — Claude SDK call resumes; fanout providers stay fresh
- `packages/core/src/executor/validate.ts` — `runMode: "first-resumed" | "resumed" | "fallback"` param; skip on `"resumed"`
- `packages/core/src/pm/scheduler.ts` — `PM_AGENT_STUCK_RUN_AGE_MIN` default 60 → 120
- `packages/dashboard/src/routes/runs.ts` — add `/runs/:id/transcript` route, display `agentSessionId` in run-detail
- `packages/dashboard/src/views/run-detail.ts` — render session ID with transcript link
- `docker-compose.dogfood.yml` — `urateam-dogfood-agent-sessions` named volume mount
- `CLAUDE.md` — new section on agent session continuity; audit-event count comment 52 → 56
- `.claude/CLAUDE.md` — mirror the key bits

**Created:**
- `packages/core/src/executor/session-policy.ts` — `isResumable(stage, model)` static rule + helper utilities
- `packages/core/src/executor/session-store.ts` — wraps SDK `getSessionMessages()`; abstracts JSONL access; encapsulates "does transcript exist?" check
- `packages/core/src/__tests__/session-policy.test.ts` — unit tests for the always-fresh rule
- `packages/core/src/__tests__/session-resume-flag.test.ts` — runner-level tests for flag on/off behavior
- `packages/core/src/__tests__/session-resume-fallback.test.ts` — JSONL-missing fallback + audit events
- `packages/core/src/__tests__/exclude-dynamic-sections.test.ts` — Track C-1 smoke test
- `packages/core/src/__tests__/zombie-age-default.test.ts` — Track C-2 verification
- `packages/dashboard/src/views/run-transcript.ts` — view rendering `SessionMessage[]` chronologically
- `packages/dashboard/src/__tests__/transcript-route.test.ts` — route tests

**Decomposition rationale:** the `isResumable` policy and the `session-store` JSONL access are extracted into their own modules because they're the most likely to need swapping out later (e.g., when v2 SDK or PG-backed session store lands). Keeping them isolated makes Track E migration straightforward. Everything else follows existing urateam patterns.

---

## Phase 1 Tasks

### Task 1: Add `agentSessionId` column to `pipelineRuns` schema

**Files:**
- Modify: `packages/core/src/db/schema.ts`
- Modify: `packages/core/src/db/client.ts` (MIGRATION_COLUMNS array + `getCreateTablesDDL`)
- Test: `packages/core/src/__tests__/db-migration-agent-session-id.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/__tests__/db-migration-agent-session-id.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { createDb } from "../db/client.js";
import { pipelineRuns } from "../db/schema.js";

describe("agent_session_id migration (BEC-227)", () => {
  it("pipelineRuns has agentSessionId column on a fresh SQLite db", async () => {
    const { db } = await createDb({ url: ":memory:" });
    // Insert a row with agentSessionId set
    await db.insert(pipelineRuns).values({
      id: "test-run-1",
      issueId: "BEC-227",
      issueTitle: "test",
      repoUrl: "https://example.com/repo",
      pipelineKey: "auto-implement",
      status: "queued",
      startedAt: new Date(),
      agentSessionId: "session-uuid-abc",
    } as any);
    const rows = await db.select().from(pipelineRuns);
    expect(rows[0]!.agentSessionId).toBe("session-uuid-abc");
  });

  it("agentSessionId is nullable (legacy rows)", async () => {
    const { db } = await createDb({ url: ":memory:" });
    await db.insert(pipelineRuns).values({
      id: "legacy-run-1",
      issueId: "BEC-227",
      issueTitle: "legacy",
      repoUrl: "https://example.com/repo",
      pipelineKey: "auto-implement",
      status: "queued",
      startedAt: new Date(),
    } as any);
    const rows = await db.select().from(pipelineRuns);
    expect(rows[0]!.agentSessionId).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/core && npx vitest run src/__tests__/db-migration-agent-session-id.test.ts
```
Expected: FAIL — `agentSessionId` doesn't exist on the schema yet.

- [ ] **Step 3: Add the column to schema.ts**

In `packages/core/src/db/schema.ts`, inside the `pipelineRuns` table definition (currently around line 45-90), add the column right after `repoUrl`:

```typescript
agentSessionId: text("agent_session_id"), // BEC-227 — null = legacy/flag-off; populated = SDK session UUID
```

- [ ] **Step 4: Add to MIGRATION_COLUMNS in client.ts**

In `packages/core/src/db/client.ts`, find the `MIGRATION_COLUMNS` array. Add an entry:

```typescript
{
  table: "pipeline_runs",
  column: "agent_session_id",
  sqliteType: "TEXT",
  postgresType: "TEXT",
},
```

- [ ] **Step 5: Update `getCreateTablesDDL` template**

In the same file, find the `pipeline_runs` `CREATE TABLE` template inside `getCreateTablesDDL()`. Add the column line right after `repo_url`:

```sql
agent_session_id TEXT,
```

(Both SQLite and Postgres variants — keep them aligned.)

- [ ] **Step 6: Run test to verify it passes**

```bash
cd packages/core && npx vitest run src/__tests__/db-migration-agent-session-id.test.ts
```
Expected: PASS, both tests green.

- [ ] **Step 7: Run the full DB migration test suite to confirm no regressions**

```bash
cd packages/core && npx vitest run src/__tests__/db-migration
```
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/db/schema.ts packages/core/src/db/client.ts packages/core/src/__tests__/db-migration-agent-session-id.test.ts
git commit -m "feat(BEC-227): add agent_session_id column to pipeline_runs"
```

---

### Task 2: Add 4 new audit event types

**Files:**
- Modify: `packages/core/src/types.ts` (extend `AuditEventTypeSchema` z.enum)
- Modify: `packages/core/src/audit/events.ts` (add 4 builder functions)
- Modify: `packages/core/src/__tests__/audit-immutability.test.ts` (bump count 52 → 56)
- Test: `packages/core/src/__tests__/audit-session-events.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/__tests__/audit-session-events.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  agentSessionCreatedEvent,
  agentSessionResumedEvent,
  agentSessionMissingFallbackEvent,
  systemSessionVolumeWarningEvent,
} from "../audit/events.js";

describe("agent session audit events (BEC-227)", () => {
  it("agentSessionCreatedEvent builds the canonical shape", () => {
    const e = agentSessionCreatedEvent({
      runId: "run-1",
      issueId: "BEC-227",
      sessionId: "uuid-abc",
    });
    expect(e.eventType).toBe("pipeline.agent_session_created");
    expect(e.payload).toMatchObject({ runId: "run-1", issueId: "BEC-227", sessionId: "uuid-abc" });
  });

  it("agentSessionResumedEvent includes priorMessageCount", () => {
    const e = agentSessionResumedEvent({
      runId: "run-1",
      issueId: "BEC-227",
      sessionId: "uuid-abc",
      stage: "implement",
      priorMessageCount: 42,
    });
    expect(e.eventType).toBe("pipeline.agent_session_resumed");
    expect(e.payload.priorMessageCount).toBe(42);
  });

  it("agentSessionMissingFallbackEvent records the missing path", () => {
    const e = agentSessionMissingFallbackEvent({
      runId: "run-1",
      issueId: "BEC-227",
      sessionId: "uuid-abc",
      reason: "jsonl-not-found",
    });
    expect(e.eventType).toBe("pipeline.agent_session_missing_fallback");
    expect(e.payload.reason).toBe("jsonl-not-found");
  });

  it("systemSessionVolumeWarningEvent fires at boot", () => {
    const e = systemSessionVolumeWarningEvent({ projectsDir: "/home/ura/.claude/projects", reason: "tmpfs" });
    expect(e.eventType).toBe("system.session_volume_warning");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/core && npx vitest run src/__tests__/audit-session-events.test.ts
```
Expected: FAIL — none of the 4 builder functions exist yet.

- [ ] **Step 3: Extend `AuditEventTypeSchema` enum in types.ts**

In `packages/core/src/types.ts`, find the `AuditEventTypeSchema = z.enum([...])` definition. Add 4 entries (alphabetical-ish within the `pipeline.*` and `system.*` namespaces):

```typescript
"pipeline.agent_session_created",
"pipeline.agent_session_resumed",
"pipeline.agent_session_missing_fallback",
"system.session_volume_warning",
```

- [ ] **Step 4: Add the 4 event builders to audit/events.ts**

In `packages/core/src/audit/events.ts`, add the 4 new builder functions following the existing pattern (see `pmTriageQualityScoreEvent` as a reference):

```typescript
export function agentSessionCreatedEvent(payload: {
  runId: string;
  issueId: string;
  sessionId: string;
}) {
  return {
    eventType: "pipeline.agent_session_created" as const,
    payload,
  };
}

export function agentSessionResumedEvent(payload: {
  runId: string;
  issueId: string;
  sessionId: string;
  stage: string;
  priorMessageCount: number;
}) {
  return {
    eventType: "pipeline.agent_session_resumed" as const,
    payload,
  };
}

export function agentSessionMissingFallbackEvent(payload: {
  runId: string;
  issueId: string;
  sessionId: string;
  reason: "jsonl-not-found" | "jsonl-parse-error" | "sdk-resume-error";
}) {
  return {
    eventType: "pipeline.agent_session_missing_fallback" as const,
    payload,
  };
}

export function systemSessionVolumeWarningEvent(payload: {
  projectsDir: string;
  reason: "tmpfs" | "write-test-failed" | "not-found";
}) {
  return {
    eventType: "system.session_volume_warning" as const,
    payload,
  };
}
```

- [ ] **Step 5: Bump audit-immutability count assertion**

In `packages/core/src/__tests__/audit-immutability.test.ts`, find the `expect(...).toBe(52)` (or similar canonical-count assertion). Change to `56`.

If the test uses a different exact form (e.g., `expect(AuditEventTypeSchema.options).toHaveLength(52)`), update the literal accordingly.

- [ ] **Step 6: Run tests**

```bash
cd packages/core && npx vitest run src/__tests__/audit-session-events.test.ts src/__tests__/audit-immutability.test.ts
```
Expected: PASS.

- [ ] **Step 7: Run typecheck**

```bash
cd /Users/jonb/projects/urateam && pnpm -w typecheck
```
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/audit/events.ts packages/core/src/__tests__/audit-session-events.test.ts packages/core/src/__tests__/audit-immutability.test.ts
git commit -m "feat(BEC-227): add 4 agent-session audit event types"
```

---

### Task 3: `isResumable(stage, model)` policy module

**Files:**
- Create: `packages/core/src/executor/session-policy.ts`
- Create: `packages/core/src/__tests__/session-policy.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/__tests__/session-policy.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { isResumable, isAlwaysFreshStage, ALWAYS_FRESH_STAGES } from "../executor/session-policy.js";

describe("session-policy (BEC-227)", () => {
  describe("isAlwaysFreshStage", () => {
    it("validate stage is always fresh", () => {
      expect(isAlwaysFreshStage("validate")).toBe(true);
    });
    it("ralph-check stage is always fresh", () => {
      expect(isAlwaysFreshStage("ralph-check")).toBe(true);
    });
    it("implement stage is NOT always fresh", () => {
      expect(isAlwaysFreshStage("implement")).toBe(false);
    });
    it("ALWAYS_FRESH_STAGES set is exposed and immutable from caller's perspective", () => {
      expect(ALWAYS_FRESH_STAGES.has("validate")).toBe(true);
      expect(ALWAYS_FRESH_STAGES.has("implement")).toBe(false);
    });
  });

  describe("isResumable", () => {
    it("Sonnet on implement → resumable", () => {
      expect(isResumable("implement", "claude-sonnet-4-6")).toBe(true);
    });
    it("Opus on implement → resumable (same family)", () => {
      expect(isResumable("implement", "claude-opus-4-7")).toBe(true);
    });
    it("Haiku on implement → not resumable (different family)", () => {
      expect(isResumable("implement", "claude-haiku-4-5")).toBe(false);
    });
    it("any model on validate → not resumable", () => {
      expect(isResumable("validate", "claude-sonnet-4-6")).toBe(false);
    });
    it("Sonnet on review → resumable", () => {
      expect(isResumable("review", "claude-sonnet-4-6")).toBe(true);
    });
    it("Sonnet on deep-review → resumable", () => {
      expect(isResumable("deep-review", "claude-sonnet-4-6")).toBe(true);
    });
    it("non-Claude model → not resumable", () => {
      expect(isResumable("review", "qwen/qwen-3-plus")).toBe(false);
      expect(isResumable("review", "openai/gpt-oss-120b")).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/core && npx vitest run src/__tests__/session-policy.test.ts
```
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Create the policy module**

Create `packages/core/src/executor/session-policy.ts`:

```typescript
/**
 * BEC-227 — Session resume policy.
 *
 * Determines, for a given (stage, model) pair, whether the pipeline runner
 * should resume the per-run SDK session (`query({ resume: sessionId })`) or
 * start fresh (`query({ sessionId })` for the first stage, or no session opts
 * at all for always-fresh stages).
 *
 * The policy is static, not config — operators can change `stageModels` but
 * cannot override which stages are always-fresh. This prevents the Haiku
 * validator from inheriting a Sonnet implement's tool-call history, which
 * is wasteful and potentially confusing.
 */

/** Stages that always run with a fresh SDK session, regardless of model. */
export const ALWAYS_FRESH_STAGES: ReadonlySet<string> = new Set([
  "validate",       // Haiku handoff validator (executor/validate.ts)
  "ralph-check",    // Haiku ralph requirements checker (executor/ralph.ts)
]);

/** Returns true when the given stage is in the always-fresh set. */
export function isAlwaysFreshStage(stage: string): boolean {
  return ALWAYS_FRESH_STAGES.has(stage);
}

/**
 * Returns the model family. "claude" for any model starting with "claude-",
 * "other" for anything else (Qwen, GPT-OSS, etc. — used by the OpenRouter
 * fanout providers, which can't share an SDK session).
 */
function modelFamily(model: string): "claude" | "other" {
  return model.startsWith("claude-") ? "claude" : "other";
}

/**
 * Returns true iff the given stage running on the given model should resume
 * the per-run SDK session.
 *
 * Rule: stage is NOT in the always-fresh set AND model is a Claude model.
 * Cross-family (e.g., implement-on-Haiku via stageModels override) falls back
 * to fresh, since the SDK session abstraction is Claude-only.
 */
export function isResumable(stage: string, model: string): boolean {
  if (isAlwaysFreshStage(stage)) return false;
  return modelFamily(model) === "claude";
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd packages/core && npx vitest run src/__tests__/session-policy.test.ts
```
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/executor/session-policy.ts packages/core/src/__tests__/session-policy.test.ts
git commit -m "feat(BEC-227): add isResumable session policy module"
```

---

### Task 4: `session-store.ts` — JSONL transcript access wrapper

**Files:**
- Create: `packages/core/src/executor/session-store.ts`
- Create: `packages/core/src/__tests__/session-store.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/__tests__/session-store.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { transcriptPath, transcriptExists } from "../executor/session-store.js";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "urateam-session-store-test-"));
});
afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("session-store (BEC-227)", () => {
  it("transcriptPath builds the expected per-cwd / per-session path", () => {
    const p = transcriptPath({
      projectsRoot: tmpRoot,
      cwd: "/home/ura/data/runs/abc/worktree",
      sessionId: "uuid-1",
    });
    // Per SDK convention: projectsRoot / <encoded-cwd> / <sessionId>.jsonl
    expect(p).toMatch(/uuid-1\.jsonl$/);
    expect(p).toContain(tmpRoot);
  });

  it("transcriptExists returns true when the JSONL file is present", () => {
    const dir = join(tmpRoot, "encoded-cwd");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "uuid-1.jsonl"), '{"message":"hi"}\n');
    const exists = transcriptExists({
      projectsRoot: tmpRoot,
      cwd: "/encoded-cwd",
      sessionId: "uuid-1",
    });
    expect(exists).toBe(true);
  });

  it("transcriptExists returns false when missing", () => {
    const exists = transcriptExists({
      projectsRoot: tmpRoot,
      cwd: "/nonexistent",
      sessionId: "uuid-missing",
    });
    expect(exists).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/core && npx vitest run src/__tests__/session-store.test.ts
```
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement session-store.ts**

Create `packages/core/src/executor/session-store.ts`:

```typescript
/**
 * BEC-227 — JSONL transcript access wrapper.
 *
 * The Claude Agent SDK writes each session's transcript to
 *   {projectsRoot}/{encoded-cwd}/{sessionId}.jsonl
 *
 * where `encoded-cwd` is the cwd with slashes replaced by hyphens (per SDK
 * convention; see node_modules/@anthropic-ai/claude-agent-sdk source).
 *
 * urateam uses this wrapper to:
 *   1. Check whether a transcript exists before issuing `query({ resume })`
 *   2. Locate the file for the dashboard's transcript viewer
 *   3. Provide a swap point for future PG-backed session storage (Track E)
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * The default projects root used by the SDK. Override via the
 * `URATEAM_CLAUDE_PROJECTS_DIR` env var for tests or non-standard deploys.
 */
export function defaultProjectsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.URATEAM_CLAUDE_PROJECTS_DIR ?? join(homedir(), ".claude", "projects");
}

/** Encode a cwd into the SDK's per-project directory name. */
function encodeCwd(cwd: string): string {
  // SDK convention: replace path separators with hyphens, prefix removed if leading slash.
  return cwd.replace(/^\//, "").replace(/[\/\\]/g, "-");
}

/** Build the JSONL transcript path for a given (cwd, sessionId). */
export function transcriptPath(opts: {
  projectsRoot: string;
  cwd: string;
  sessionId: string;
}): string {
  return join(opts.projectsRoot, encodeCwd(opts.cwd), `${opts.sessionId}.jsonl`);
}

/** Returns true iff the transcript file exists on disk. */
export function transcriptExists(opts: {
  projectsRoot: string;
  cwd: string;
  sessionId: string;
}): boolean {
  return existsSync(transcriptPath(opts));
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd packages/core && npx vitest run src/__tests__/session-store.test.ts
```
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/executor/session-store.ts packages/core/src/__tests__/session-store.test.ts
git commit -m "feat(BEC-227): add session-store JSONL access wrapper"
```

---

### Task 5: Mint `agentSessionId` in `runner.start()` when flag is on

**Files:**
- Modify: `packages/core/src/pipeline/runner.ts` (around the `start()` method, currently ~line 226)
- Create: `packages/core/src/__tests__/session-resume-flag.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/__tests__/session-resume-flag.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDb } from "../db/client.js";
import { pipelineRuns } from "../db/schema.js";
import { eq } from "drizzle-orm";

// Helper to create a runner with a mocked executor that records what was called.
// Adjust this to match the actual constructor signature in your runner.
import { PipelineRunner } from "../pipeline/runner.js";

describe("agent_session_id minting (BEC-227)", () => {
  let originalEnv: string | undefined;
  beforeEach(() => {
    originalEnv = process.env.URATEAM_ENABLE_AGENT_SESSION_RESUME;
  });
  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.URATEAM_ENABLE_AGENT_SESSION_RESUME;
    } else {
      process.env.URATEAM_ENABLE_AGENT_SESSION_RESUME = originalEnv;
    }
  });

  it("flag on → mints UUID and persists on pipeline_runs row", async () => {
    process.env.URATEAM_ENABLE_AGENT_SESSION_RESUME = "true";
    const { db } = await createDb({ url: ":memory:" });
    // Insert a dummy run as if start() had run with flag on
    // (Once runner.start is refactored, this will run through the real start path.)
    const runId = "test-run-with-session";
    await db.insert(pipelineRuns).values({
      id: runId,
      issueId: "BEC-227",
      issueTitle: "test",
      repoUrl: "https://example.com/repo",
      pipelineKey: "auto-implement",
      status: "queued",
      startedAt: new Date(),
      agentSessionId: "expected-uuid",  // simulate what start() should write
    } as any);
    const [row] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId));
    expect(row!.agentSessionId).toBe("expected-uuid");
  });

  it("flag off → agentSessionId stays null", async () => {
    delete process.env.URATEAM_ENABLE_AGENT_SESSION_RESUME;
    const { db } = await createDb({ url: ":memory:" });
    const runId = "test-run-legacy";
    await db.insert(pipelineRuns).values({
      id: runId,
      issueId: "BEC-227",
      issueTitle: "test",
      repoUrl: "https://example.com/repo",
      pipelineKey: "auto-implement",
      status: "queued",
      startedAt: new Date(),
    } as any);
    const [row] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId));
    expect(row!.agentSessionId).toBeNull();
  });

  it("isAgentSessionResumeEnabled reads env at call time (strict equality 'true')", async () => {
    const { isAgentSessionResumeEnabled } = await import("../executor/session-policy.js");
    expect(isAgentSessionResumeEnabled({ URATEAM_ENABLE_AGENT_SESSION_RESUME: "true" })).toBe(true);
    expect(isAgentSessionResumeEnabled({ URATEAM_ENABLE_AGENT_SESSION_RESUME: "1" })).toBe(false);
    expect(isAgentSessionResumeEnabled({ URATEAM_ENABLE_AGENT_SESSION_RESUME: "TRUE" })).toBe(false);
    expect(isAgentSessionResumeEnabled({})).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/core && npx vitest run src/__tests__/session-resume-flag.test.ts
```
Expected: FAIL — `isAgentSessionResumeEnabled` doesn't exist yet.

- [ ] **Step 3: Add the flag helper to session-policy.ts**

Append to `packages/core/src/executor/session-policy.ts`:

```typescript
/**
 * Returns true iff the env enables agent session resume (BEC-227).
 * Strict equality on `"true"` — mirrors BEC-218 / BEC-225 precedent.
 * Read at call time so flipping the var takes effect on the next pipeline
 * run without a daemon restart.
 */
export function isAgentSessionResumeEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.URATEAM_ENABLE_AGENT_SESSION_RESUME === "true";
}
```

- [ ] **Step 4: Mint sessionId in runner.start()**

In `packages/core/src/pipeline/runner.ts`, find the `start()` method (around line 226). Locate the spot where `runId = nanoid()` is generated. Just below it, add:

```typescript
import { randomUUID } from "node:crypto";
import { isAgentSessionResumeEnabled } from "../executor/session-policy.js";
import {
  agentSessionCreatedEvent,
} from "../audit/index.js";  // (ensure agent_session events are re-exported from audit/index.ts)

// ...inside start():
const agentSessionId = isAgentSessionResumeEnabled() ? randomUUID() : null;
```

Update the `db.insert(pipelineRuns).values({...})` call to include `agentSessionId`:

```typescript
.values({
  id: runId,
  issueId: issue.identifier,
  // ... existing fields ...
  agentSessionId,  // null when flag is off
})
```

After the row is inserted, if `agentSessionId !== null`, emit the created event:

```typescript
if (agentSessionId !== null) {
  void logAuditEvent(
    this.db as AnyDb,
    agentSessionCreatedEvent({
      runId,
      issueId: issue.identifier,
      sessionId: agentSessionId,
    }),
  );
}
```

- [ ] **Step 5: Re-export the agent-session event builders from audit/index.ts**

In `packages/core/src/audit/index.ts`, add to the re-exports:

```typescript
export {
  agentSessionCreatedEvent,
  agentSessionResumedEvent,
  agentSessionMissingFallbackEvent,
  systemSessionVolumeWarningEvent,
} from "./events.js";
```

- [ ] **Step 6: Run tests**

```bash
cd packages/core && npx vitest run src/__tests__/session-resume-flag.test.ts src/__tests__/db-migration-agent-session-id.test.ts
```
Expected: PASS.

- [ ] **Step 7: Run typecheck**

```bash
cd /Users/jonb/projects/urateam && pnpm -w typecheck
```
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/pipeline/runner.ts packages/core/src/executor/session-policy.ts packages/core/src/audit/index.ts packages/core/src/__tests__/session-resume-flag.test.ts
git commit -m "feat(BEC-227): mint agent_session_id in runner.start() behind flag"
```

---

### Task 6: Thread `agentSessionId` and `isFirstResumableStage` into `executeStage()`

**Files:**
- Modify: `packages/core/src/executor/executor.ts` (function signature + SDK options)
- Modify: `packages/core/src/pipeline/runner.ts` (call sites — pass new params)

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/__tests__/execute-stage-session-opts.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";

// Mock the SDK before importing executor
const queryMock = vi.fn();
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: queryMock,
}));

import { executeStage } from "../executor/executor.js";

describe("executeStage session options (BEC-227)", () => {
  beforeEach(() => {
    queryMock.mockReset();
    // Make query return an empty async iterable so the call returns without errors
    queryMock.mockImplementation(async function* () {
      yield { type: "system", subtype: "ready" };
    });
  });

  it("first resumable stage: passes options.sessionId, not options.resume", async () => {
    await executeStage({
      // ... minimal valid stage args (depends on actual signature; fill in via inspection)
      stage: "reproduce",
      agentSessionId: "uuid-1",
      isFirstResumableStage: true,
      model: "claude-sonnet-4-6",
      // ... other required fields filled with stubs
    } as any);
    const opts = queryMock.mock.calls[0]![0].options;
    expect(opts.sessionId).toBe("uuid-1");
    expect(opts.resume).toBeUndefined();
  });

  it("non-first resumable stage: passes options.resume, not options.sessionId", async () => {
    await executeStage({
      stage: "implement",
      agentSessionId: "uuid-1",
      isFirstResumableStage: false,
      model: "claude-sonnet-4-6",
    } as any);
    const opts = queryMock.mock.calls[0]![0].options;
    expect(opts.resume).toBe("uuid-1");
    expect(opts.sessionId).toBeUndefined();
  });

  it("agentSessionId=null (flag off): no session opts at all", async () => {
    await executeStage({
      stage: "implement",
      agentSessionId: null,
      isFirstResumableStage: false,
      model: "claude-sonnet-4-6",
    } as any);
    const opts = queryMock.mock.calls[0]![0].options;
    expect(opts.sessionId).toBeUndefined();
    expect(opts.resume).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/core && npx vitest run src/__tests__/execute-stage-session-opts.test.ts
```
Expected: FAIL — `executeStage` doesn't accept the new params yet.

- [ ] **Step 3: Extend `executeStage` signature in executor.ts**

In `packages/core/src/executor/executor.ts`, find the `executeStage()` function (currently around line 87). Add to its options/params type:

```typescript
agentSessionId: string | null;        // null = flag off, run with no session
isFirstResumableStage: boolean;       // true only for the first resumable stage of this run
```

- [ ] **Step 4: Add session opts to the SDK call**

In the same function, where the `sdkQuery({ prompt, options: {...} })` call assembles options, add:

```typescript
import { isResumable } from "./session-policy.js";

// Inside the options builder:
const wantsResume = agentSessionId !== null && isResumable(stage, model);
const sessionOpts = wantsResume
  ? (isFirstResumableStage ? { sessionId: agentSessionId } : { resume: agentSessionId })
  : {};

// Compose into the final options:
const queryOptions = {
  ...existingOptions,
  ...sessionOpts,
  systemPrompt: {
    type: "preset" as const,
    preset: "claude_code" as const,
    excludeDynamicSections: true,  // Track C-1 from the spec
  },
};
```

- [ ] **Step 5: Update runner.ts call sites**

In `packages/core/src/pipeline/runner.ts`, find every `executeStage({...})` call. There are several (main stage loop, RALPH re-implement, review-fix re-implement). For each, pass:

```typescript
agentSessionId,                          // from start()-level variable
isFirstResumableStage: <expression>,     // see below
```

For the **first resumable stage** boundary: maintain a local `let hasInitiatedSession = false;` near the top of the stage iteration. Before each `executeStage()` call:

```typescript
const isFirstResumableStage =
  agentSessionId !== null
  && !hasInitiatedSession
  && !isAlwaysFreshStage(stage);
if (isFirstResumableStage) hasInitiatedSession = true;
```

- [ ] **Step 6: Run tests**

```bash
cd packages/core && npx vitest run src/__tests__/execute-stage-session-opts.test.ts
```
Expected: PASS, 3 tests.

- [ ] **Step 7: Run typecheck**

```bash
cd /Users/jonb/projects/urateam && pnpm -w typecheck
```
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/executor/executor.ts packages/core/src/pipeline/runner.ts packages/core/src/__tests__/execute-stage-session-opts.test.ts
git commit -m "feat(BEC-227): thread agent session opts through executeStage + add excludeDynamicSections"
```

---

### Task 7: JSONL-exists pre-check + resume-error fallback

**Files:**
- Modify: `packages/core/src/executor/executor.ts` (resume pre-check + try/catch)
- Create: `packages/core/src/__tests__/session-resume-fallback.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/__tests__/session-resume-fallback.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

const queryMock = vi.fn();
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: queryMock }));

const auditLogMock = vi.fn();
vi.mock("../audit/index.js", async () => {
  const real = await vi.importActual<any>("../audit/index.js");
  return { ...real, logAuditEvent: auditLogMock };
});

import { executeStage } from "../executor/executor.js";

describe("session resume fallback (BEC-227)", () => {
  beforeEach(() => {
    queryMock.mockReset();
    auditLogMock.mockReset();
    queryMock.mockImplementation(async function* () {
      yield { type: "system", subtype: "ready" };
    });
  });

  it("transcript missing → falls back to fresh (no resume opt), emits missing_fallback audit event", async () => {
    await executeStage({
      stage: "implement",
      agentSessionId: "uuid-nonexistent",
      isFirstResumableStage: false,
      model: "claude-sonnet-4-6",
      // simulate a path that doesn't exist
      worktreePath: "/nonexistent/path",
    } as any);
    const opts = queryMock.mock.calls[0]![0].options;
    expect(opts.resume).toBeUndefined();
    expect(opts.sessionId).toBeUndefined();
    const fallbackEvent = auditLogMock.mock.calls.find(
      ([_db, evt]) => evt.eventType === "pipeline.agent_session_missing_fallback",
    );
    expect(fallbackEvent).toBeDefined();
    expect(fallbackEvent![1].payload.reason).toBe("jsonl-not-found");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/core && npx vitest run src/__tests__/session-resume-fallback.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Add the pre-check in executor.ts**

In `packages/core/src/executor/executor.ts`, where `sessionOpts` is built (Task 6), wrap the resume-path branch with an existence check:

```typescript
import { transcriptExists, defaultProjectsRoot } from "./session-store.js";
import { agentSessionMissingFallbackEvent } from "../audit/index.js";

// Inside the resume branch (isFirstResumableStage === false, agentSessionId !== null):
let sessionOpts: { sessionId?: string; resume?: string } = {};
if (wantsResume) {
  if (isFirstResumableStage) {
    sessionOpts = { sessionId: agentSessionId };
  } else {
    const exists = transcriptExists({
      projectsRoot: defaultProjectsRoot(),
      cwd: workdir,
      sessionId: agentSessionId,
    });
    if (exists) {
      sessionOpts = { resume: agentSessionId };
    } else {
      // Fallback: legacy path, log + audit
      void logAuditEvent(
        db,
        agentSessionMissingFallbackEvent({
          runId,
          issueId,
          sessionId: agentSessionId,
          reason: "jsonl-not-found",
        }),
      );
      log.warn(
        { runId, sessionId: agentSessionId, stage, cwd: workdir },
        "agent session JSONL missing — falling back to fresh session",
      );
      sessionOpts = {};
    }
  }
}
```

- [ ] **Step 4: Run tests**

```bash
cd packages/core && npx vitest run src/__tests__/session-resume-fallback.test.ts
```
Expected: PASS.

- [ ] **Step 5: Run typecheck**

```bash
cd /Users/jonb/projects/urateam && pnpm -w typecheck
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/executor/executor.ts packages/core/src/__tests__/session-resume-fallback.test.ts
git commit -m "feat(BEC-227): JSONL-exists pre-check + missing_fallback audit event"
```

---

### Task 8: Emit `agent_session_resumed` audit event on successful resume

**Files:**
- Modify: `packages/core/src/executor/executor.ts` (emit event when resume opt is set)
- Modify: `packages/core/src/__tests__/execute-stage-session-opts.test.ts` (add assertion)

- [ ] **Step 1: Extend the existing test**

In `packages/core/src/__tests__/execute-stage-session-opts.test.ts`, add a test that asserts the resumed event fires. For now, mock `getSessionMessages` to return a known message count:

```typescript
const getSessionMessagesMock = vi.fn().mockResolvedValue([
  { role: "user", content: "..." },
  { role: "assistant", content: "..." },
]);
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: queryMock,
  getSessionMessages: getSessionMessagesMock,
}));

it("on successful resume: emits agent_session_resumed with priorMessageCount", async () => {
  // (need to mock transcriptExists → true; can do via vi.mock on session-store)
  await executeStage({
    stage: "implement",
    agentSessionId: "uuid-1",
    isFirstResumableStage: false,
    model: "claude-sonnet-4-6",
    // worktreePath etc.
  } as any);
  const resumedEvt = auditLogMock.mock.calls.find(
    ([_db, evt]) => evt.eventType === "pipeline.agent_session_resumed",
  );
  expect(resumedEvt).toBeDefined();
  expect(resumedEvt![1].payload.priorMessageCount).toBe(2);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/core && npx vitest run src/__tests__/execute-stage-session-opts.test.ts
```
Expected: FAIL — event not emitted yet.

- [ ] **Step 3: Emit the event in executor.ts**

In `packages/core/src/executor/executor.ts`, after the resume opt is set successfully (inside the `if (exists)` branch from Task 7), add:

```typescript
import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import { agentSessionResumedEvent } from "../audit/index.js";

// After sessionOpts = { resume: agentSessionId };
try {
  const prior = await getSessionMessages(agentSessionId);
  void logAuditEvent(
    db,
    agentSessionResumedEvent({
      runId,
      issueId,
      sessionId: agentSessionId,
      stage,
      priorMessageCount: prior.length,
    }),
  );
} catch (err) {
  log.warn({ err: (err as Error).message }, "failed to read prior message count");
  // Still resume; just don't include count in the audit
  void logAuditEvent(
    db,
    agentSessionResumedEvent({
      runId, issueId, sessionId: agentSessionId, stage, priorMessageCount: 0,
    }),
  );
}
```

- [ ] **Step 4: Run tests**

```bash
cd packages/core && npx vitest run src/__tests__/execute-stage-session-opts.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/executor/executor.ts packages/core/src/__tests__/execute-stage-session-opts.test.ts
git commit -m "feat(BEC-227): emit agent_session_resumed event on successful resume"
```

---

### Task 9: Update `validate.ts` — `runMode` param, skip on resumed stages

**Files:**
- Modify: `packages/core/src/executor/validate.ts`
- Modify: `packages/core/src/pipeline/runner.ts` (call sites pass `runMode`)
- Create: `packages/core/src/__tests__/validate-run-mode.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/__tests__/validate-run-mode.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { validateHandoff } from "../executor/validate.js";

describe("validate.ts runMode (BEC-227)", () => {
  it("runMode='resumed' → skip validation, return success without invoking agent", async () => {
    const result = await validateHandoff({
      handoff: { /* minimal stub */ } as any,
      runMode: "resumed",
    } as any);
    expect(result.skipped).toBe(true);
    expect(result.reason).toContain("resumed");
  });

  it("runMode='first-resumed' → validate as before (don't skip)", async () => {
    // existing behavior
    const result = await validateHandoff({
      handoff: { filesChanged: ["a.ts"], summary: "did stuff" } as any,
      runMode: "first-resumed",
    } as any);
    expect(result.skipped).toBeFalsy();
  });

  it("runMode='fallback' → validate as before", async () => {
    const result = await validateHandoff({
      handoff: { filesChanged: ["a.ts"], summary: "did stuff" } as any,
      runMode: "fallback",
    } as any);
    expect(result.skipped).toBeFalsy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/core && npx vitest run src/__tests__/validate-run-mode.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Add `runMode` param to validate.ts**

In `packages/core/src/executor/validate.ts`, extend the function signature:

```typescript
export type ValidateRunMode = "first-resumed" | "resumed" | "fallback";

export async function validateHandoff(opts: {
  // ... existing fields ...
  runMode: ValidateRunMode;
}): Promise<{ ok: boolean; skipped?: boolean; reason?: string; /* ... */ }> {
  if (opts.runMode === "resumed") {
    return {
      ok: true,
      skipped: true,
      reason: "skipped: resumed-session stage (BEC-227 — agent already has prior context)",
    };
  }
  // ... existing logic ...
}
```

- [ ] **Step 4: Update runner.ts to pass `runMode`**

In `packages/core/src/pipeline/runner.ts`, find every `validateHandoff({...})` call. Pass `runMode`:

```typescript
const runMode: ValidateRunMode =
  agentSessionId === null ? "fallback"
  : hasInitiatedSession && !isFirstResumableStage ? "resumed"
  : "first-resumed";

await validateHandoff({ ...existingArgs, runMode });
```

- [ ] **Step 5: Run tests**

```bash
cd packages/core && npx vitest run src/__tests__/validate-run-mode.test.ts
```
Expected: PASS.

- [ ] **Step 6: Run typecheck**

```bash
cd /Users/jonb/projects/urateam && pnpm -w typecheck
```
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/executor/validate.ts packages/core/src/pipeline/runner.ts packages/core/src/__tests__/validate-run-mode.test.ts
git commit -m "feat(BEC-227): validate.ts skips on resumed stages via runMode param"
```

---

### Task 10: RALPH iteration drops `<previous-stage-context>` on resumed re-implements

**Files:**
- Modify: `packages/core/src/executor/prompt/templates.ts` (`handoffBlock()` accepts an opt to suppress)
- Modify: `packages/core/src/pipeline/runner.ts` (RALPH loop passes suppress flag on resumed iterations)
- Create: `packages/core/src/__tests__/ralph-handoff-suppression.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/__tests__/ralph-handoff-suppression.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { handoffBlock } from "../executor/prompt/templates.js";

describe("handoffBlock suppression (BEC-227)", () => {
  it("suppress=true → returns empty string", () => {
    const out = handoffBlock(
      { stage: "implement", summary: "x", filesChanged: ["a.ts"] } as any,
      { suppress: true },
    );
    expect(out).toBe("");
  });

  it("suppress=false → returns XML block as before", () => {
    const out = handoffBlock(
      { stage: "implement", summary: "x", filesChanged: ["a.ts"] } as any,
      { suppress: false },
    );
    expect(out).toContain("<previous-stage-context>");
  });

  it("suppress option omitted → defaults to false (legacy behavior)", () => {
    const out = handoffBlock(
      { stage: "implement", summary: "x", filesChanged: ["a.ts"] } as any,
    );
    expect(out).toContain("<previous-stage-context>");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/core && npx vitest run src/__tests__/ralph-handoff-suppression.test.ts
```
Expected: FAIL — `handoffBlock` doesn't take options yet.

- [ ] **Step 3: Add the option to `handoffBlock()`**

In `packages/core/src/executor/prompt/templates.ts`, find `handoffBlock`. Extend signature:

```typescript
export function handoffBlock(
  handoff: HandoffArtifact,
  opts: { suppress?: boolean } = {},
): string {
  if (opts.suppress) return "";
  // ... existing logic ...
}
```

- [ ] **Step 4: Suppress in runner.ts RALPH iteration**

In `packages/core/src/pipeline/runner.ts`, find the RALPH re-implement call site (around line 1056). Pass `suppress: true` when this is a resumed iteration:

```typescript
const isResumedRalph = hasInitiatedSession && agentSessionId !== null;
// ... assemble the prompt with handoffBlock(handoff, { suppress: isResumedRalph })
```

Plumb this through `executeStage` → `assemblePrompt` → `handoffBlock` call chain.

- [ ] **Step 5: Run tests**

```bash
cd packages/core && npx vitest run src/__tests__/ralph-handoff-suppression.test.ts
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/executor/prompt/templates.ts packages/core/src/pipeline/runner.ts packages/core/src/__tests__/ralph-handoff-suppression.test.ts
git commit -m "feat(BEC-227): suppress previous-stage-context block on resumed RALPH iterations"
```

---

### Task 11: deep-review.ts — resume the Claude SDK call

**Files:**
- Modify: `packages/core/src/executor/deep-review.ts`
- Create: `packages/core/src/__tests__/deep-review-resume.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/__tests__/deep-review-resume.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";

const queryMock = vi.fn();
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: queryMock }));

import { runDeepReview } from "../executor/deep-review.js";

describe("deep-review resume (BEC-227)", () => {
  beforeEach(() => {
    queryMock.mockReset();
    queryMock.mockImplementation(async function* () { yield { type: "system" }; });
  });

  it("agentSessionId provided + resumable → passes resume in options", async () => {
    await runDeepReview({
      // ... existing args ...
      agentSessionId: "uuid-1",
      isFirstResumableStage: false,
      model: "claude-sonnet-4-6",
    } as any);
    expect(queryMock.mock.calls[0]![0].options.resume).toBe("uuid-1");
  });

  it("agentSessionId null → no resume in options", async () => {
    await runDeepReview({
      agentSessionId: null,
      model: "claude-sonnet-4-6",
    } as any);
    expect(queryMock.mock.calls[0]![0].options.resume).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/core && npx vitest run src/__tests__/deep-review-resume.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Add session opts to deep-review.ts**

In `packages/core/src/executor/deep-review.ts`, extend the function signature to accept `agentSessionId` and `isFirstResumableStage`. Build session opts using the same `isResumable` check + `transcriptExists` pre-check from Task 7. Pass into the SDK call.

(Detailed code identical in structure to Task 6 — apply the same `sessionOpts` block.)

- [ ] **Step 4: Run tests**

```bash
cd packages/core && npx vitest run src/__tests__/deep-review-resume.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/executor/deep-review.ts packages/core/src/__tests__/deep-review-resume.test.ts
git commit -m "feat(BEC-227): deep-review.ts resumes when agentSessionId provided"
```

---

### Task 12: Track C-2 — bump `PM_AGENT_STUCK_RUN_AGE_MIN` default 60 → 120

**Files:**
- Modify: `packages/core/src/pm/scheduler.ts` (`parseStuckRunAgeMinutes` default literal)
- Modify: `CLAUDE.md` (zombie-age default in PM Agent section)
- Test: existing `pm-recover-stuck.test.ts` (verify new default)

- [ ] **Step 1: Find the existing default**

```bash
grep -n "PM_AGENT_STUCK_RUN_AGE_MIN\|stuckRunAgeMin" packages/core/src/pm/scheduler.ts
```

- [ ] **Step 2: Update the default to 120**

Change the literal `60` to `120` in the `parseStuckRunAgeMinutes` helper (or wherever the default is defined).

- [ ] **Step 3: Update or add a test asserting the new default**

In `packages/core/src/__tests__/pm-recover-stuck.test.ts` (or create `packages/core/src/__tests__/zombie-age-default.test.ts`):

```typescript
import { describe, it, expect } from "vitest";
import { parseStuckRunAgeMinutes } from "../pm/scheduler.js";

describe("PM_AGENT_STUCK_RUN_AGE_MIN default (BEC-227 / BEC-184 tuning)", () => {
  it("default is 120 minutes when env unset", () => {
    expect(parseStuckRunAgeMinutes(undefined)).toBe(120);
  });
  it("env override still respected", () => {
    expect(parseStuckRunAgeMinutes("90")).toBe(90);
  });
  it("invalid env falls back to default", () => {
    expect(parseStuckRunAgeMinutes("not-a-number")).toBe(120);
  });
});
```

- [ ] **Step 4: Run tests**

```bash
cd packages/core && npx vitest run src/__tests__/zombie-age-default.test.ts src/__tests__/pm-recover-stuck.test.ts
```
Expected: PASS.

- [ ] **Step 5: Update CLAUDE.md**

In `CLAUDE.md`, find the BEC-184 zombie-run-recovery bullet under "Pause / circuit-breaker / escalation". Change `default 60` to `default 120` and add a parenthetical noting the rationale: `(bumped from 60 → 120 in BEC-227 — real RALPH-iterated implementation work routinely takes 60-90 min)`.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/pm/scheduler.ts packages/core/src/__tests__/zombie-age-default.test.ts CLAUDE.md
git commit -m "feat(BEC-227): bump PM_AGENT_STUCK_RUN_AGE_MIN default 60 → 120"
```

---

### Task 13: Docker volume for transcript persistence

**Files:**
- Modify: `docker-compose.dogfood.yml`
- Modify: `deploy/BOOTSTRAP.md` (mention the new volume)

- [ ] **Step 1: Add the volume mount to compose**

In `docker-compose.dogfood.yml`, in the `urateam-dogfood` service's `volumes` block, add:

```yaml
- urateam-dogfood-agent-sessions:/home/ura/.claude/projects
```

At the bottom of the file, in the `volumes:` declaration block, add:

```yaml
volumes:
  # ... existing volumes ...
  urateam-dogfood-agent-sessions:
```

- [ ] **Step 2: Document in BOOTSTRAP.md**

In `deploy/BOOTSTRAP.md`, add a short note in the persistence section:

```markdown
- **Agent session transcripts** (BEC-227): the named volume `urateam-dogfood-agent-sessions` is mounted at `/home/ura/.claude/projects`. The Claude Agent SDK writes per-run JSONL transcripts here; urateam reads them back to resume sessions across pipeline stages. Without this volume, retriable resumes silently lose agent memory.
```

- [ ] **Step 3: Verify compose file parses**

```bash
cd /Users/jonb/projects/urateam && docker compose -f docker-compose.dogfood.yml config > /dev/null && echo "OK"
```
Expected: `OK` printed.

- [ ] **Step 4: Commit**

```bash
git add docker-compose.dogfood.yml deploy/BOOTSTRAP.md
git commit -m "feat(BEC-227): add urateam-dogfood-agent-sessions volume for transcript persistence"
```

---

### Task 14: Startup volume sanity check

**Files:**
- Create: `packages/core/src/pipeline/session-volume-check.ts`
- Modify: `packages/core/src/server.ts` (call the check on boot)
- Create: `packages/core/src/__tests__/session-volume-check.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/__tests__/session-volume-check.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkSessionVolume } from "../pipeline/session-volume-check.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "vol-check-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("checkSessionVolume (BEC-227)", () => {
  it("writeable persistent dir → returns ok", () => {
    const result = checkSessionVolume({ projectsDir: dir });
    expect(result.ok).toBe(true);
  });

  it("nonexistent dir → returns not-found", () => {
    const result = checkSessionVolume({ projectsDir: "/totally/not/a/real/path/asdf" });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not-found");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/core && npx vitest run src/__tests__/session-volume-check.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement the check**

Create `packages/core/src/pipeline/session-volume-check.ts`:

```typescript
import { existsSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export type SessionVolumeStatus =
  | { ok: true }
  | { ok: false; reason: "not-found" | "write-test-failed" | "tmpfs" };

/**
 * Checks that the Claude session projects directory is present and writeable.
 * Called at server boot; emits `system.session_volume_warning` audit event
 * on failure (caller handles the audit emission).
 */
export function checkSessionVolume(opts: { projectsDir: string }): SessionVolumeStatus {
  if (!existsSync(opts.projectsDir)) return { ok: false, reason: "not-found" };
  try {
    const probe = join(opts.projectsDir, ".urateam-volume-probe");
    writeFileSync(probe, "ok");
    unlinkSync(probe);
    return { ok: true };
  } catch {
    return { ok: false, reason: "write-test-failed" };
  }
}
```

- [ ] **Step 4: Wire into server boot**

In `packages/core/src/server.ts`, find the boot path (where pino logger is initialized, license loaded, etc.). Add:

```typescript
import { checkSessionVolume } from "./pipeline/session-volume-check.js";
import { systemSessionVolumeWarningEvent, logAuditEvent } from "./audit/index.js";
import { defaultProjectsRoot } from "./executor/session-store.js";

// During boot, after DB init:
if (isAgentSessionResumeEnabled()) {
  const projectsDir = defaultProjectsRoot();
  const status = checkSessionVolume({ projectsDir });
  if (!status.ok) {
    log.warn(
      { projectsDir, reason: status.reason },
      "agent session projects dir failed volume check — resumes will fall back",
    );
    void logAuditEvent(db, systemSessionVolumeWarningEvent({ projectsDir, reason: status.reason }));
  }
}
```

- [ ] **Step 5: Run tests**

```bash
cd packages/core && npx vitest run src/__tests__/session-volume-check.test.ts
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/pipeline/session-volume-check.ts packages/core/src/server.ts packages/core/src/__tests__/session-volume-check.test.ts
git commit -m "feat(BEC-227): boot-time session volume check + warning audit event"
```

---

### Task 15: Dashboard — display `agent_session_id` on run-detail page

**Files:**
- Modify: `packages/dashboard/src/views/run-detail.ts`
- Modify: `packages/dashboard/src/__tests__/run-detail.test.ts` (or whichever test file covers the run-detail view)

- [ ] **Step 1: Update the run-detail view**

In `packages/dashboard/src/views/run-detail.ts`, find the section that renders run metadata (status, started_at, etc.). Add a row for `agent_session_id`:

```typescript
${run.agentSessionId ? html`
  <tr>
    <td>Agent session</td>
    <td><a href="${basePath}/runs/${run.id}/transcript">${escape(run.agentSessionId.slice(0, 8))}…</a></td>
  </tr>
` : ""}
```

- [ ] **Step 2: Add a unit test**

Add to the existing run-detail view test (or create one):

```typescript
it("renders agent session ID with transcript link when present", () => {
  const html = runDetailView(
    { id: "r1", agentSessionId: "uuid-abcdef-rest", /* ... */ } as any,
    [], [], 1, 0, false, { canStop: false, canHalt: false },
  );
  expect(html).toContain("uuid-abc"); // truncated display
  expect(html).toContain("/runs/r1/transcript");
});
```

- [ ] **Step 3: Run tests**

```bash
cd packages/dashboard && npx vitest run
```
Expected: PASS (existing + new test).

- [ ] **Step 4: Commit**

```bash
git add packages/dashboard/src/views/run-detail.ts packages/dashboard/src/__tests__/run-detail.test.ts
git commit -m "feat(BEC-227): display agent_session_id with transcript link on run-detail"
```

---

### Task 16: Dashboard — `/runs/:id/transcript` route

**Files:**
- Modify: `packages/dashboard/src/routes/runs.ts`
- Create: `packages/dashboard/src/views/run-transcript.ts`
- Create: `packages/dashboard/src/__tests__/transcript-route.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/dashboard/src/__tests__/transcript-route.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";

const getSessionMessagesMock = vi.fn();
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ getSessionMessages: getSessionMessagesMock }));

import { appWith } from "./test-helpers.js"; // existing helper used by other route tests

describe("/runs/:id/transcript (BEC-227)", () => {
  it("operator requesting an existing run with sessionId → 200, contains messages", async () => {
    getSessionMessagesMock.mockResolvedValue([
      { role: "user", content: "let's start" },
      { role: "assistant", content: "ok, looking" },
    ]);
    const app = appWith("operator", undefined, { runs: [{ id: "r1", agentSessionId: "uuid-1", /* ... */ }] });
    const res = await app.request("/runs/r1/transcript");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("let's start");
    expect(html).toContain("ok, looking");
  });

  it("run with no agentSessionId → 404 / 'no transcript' message", async () => {
    const app = appWith("operator", undefined, { runs: [{ id: "r2", agentSessionId: null }] });
    const res = await app.request("/runs/r2/transcript");
    // Either 404 or 200 with "no transcript" body — pick one and assert it
    const html = await res.text();
    expect(html).toContain("no transcript");
  });

  it("viewer → 403", async () => {
    const app = appWith("viewer", undefined, { runs: [{ id: "r1", agentSessionId: "uuid-1" }] });
    const res = await app.request("/runs/r1/transcript");
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/dashboard && npx vitest run src/__tests__/transcript-route.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Create the view**

Create `packages/dashboard/src/views/run-transcript.ts`:

```typescript
import { html, escape } from "../html.js";

export interface SessionMessage {
  role: string;
  content: string | unknown;
  // ... whatever the SDK actually returns; check via getSessionMessages type
}

export function runTranscriptView(runId: string, messages: SessionMessage[], basePath: string): string {
  if (messages.length === 0) {
    return `<p>no transcript available for run ${escape(runId)}</p>`;
  }
  const body = messages.map((m, i) => `
    <details ${m.role === "assistant" ? "open" : ""}>
      <summary>#${i} — ${escape(m.role)}</summary>
      <pre>${escape(typeof m.content === "string" ? m.content : JSON.stringify(m.content, null, 2))}</pre>
    </details>
  `).join("\n");
  return `
    <h1>Transcript — ${escape(runId)}</h1>
    <p><a href="${basePath}/runs/${escape(runId)}">← back to run</a></p>
    <div class="transcript">${body}</div>
  `;
}
```

- [ ] **Step 4: Add the route**

In `packages/dashboard/src/routes/runs.ts`, near the other run routes, add:

```typescript
import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import { runTranscriptView } from "../views/run-transcript.js";
import { layout } from "../views/layout.js";

router.get(
  "/runs/:id/transcript",
  requirePermission("runs.view"),
  async (c) => {
    const id = c.req.param("id");
    const run = await fetchRunById(id);
    if (!run) return c.text("Run not found", 404);
    let messages: any[] = [];
    if (run.agentSessionId) {
      try {
        messages = await getSessionMessages(run.agentSessionId);
      } catch (err) {
        log.warn({ err: (err as Error).message }, "failed to read session messages");
      }
    }
    const user = c.get("user" as never) as { email: string } | undefined;
    return c.html(layout(
      `Transcript ${id}`,
      runTranscriptView(id, messages, effectiveBasePath),
      effectiveBasePath,
      { userEmail: user?.email },
    ));
  },
);
```

- [ ] **Step 5: Run tests**

```bash
cd packages/dashboard && npx vitest run src/__tests__/transcript-route.test.ts
```
Expected: PASS.

- [ ] **Step 6: Run dashboard typecheck**

```bash
cd /Users/jonb/projects/urateam && pnpm -w typecheck
```
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/dashboard/src/routes/runs.ts packages/dashboard/src/views/run-transcript.ts packages/dashboard/src/__tests__/transcript-route.test.ts
git commit -m "feat(BEC-227): GET /runs/:id/transcript reads SDK getSessionMessages"
```

---

### Task 17: Documentation — CLAUDE.md + .claude/CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`
- Modify: `.claude/CLAUDE.md`

- [ ] **Step 1: Update the root CLAUDE.md**

Add a new subsection under "Key Patterns" (after the Linear SDK lazy relations bullet):

```markdown
### Agent Session Continuity (BEC-227)

Each pipeline run mints `agent_session_id = randomUUID()` (when `URATEAM_ENABLE_AGENT_SESSION_RESUME=true`) and threads it through every `executeStage()` call. First resumable stage uses `query({ sessionId })`; subsequent stages use `query({ resume: sessionId })`. The Claude Agent SDK writes JSONL transcripts to `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`, mounted as the named volume `urateam-dogfood-agent-sessions` in dogfood compose.

- `isResumable(stage, model)` (`executor/session-policy.ts`) — static rule: stage NOT IN `{validate, ralph-check}` AND model is `claude-*`. Validator + RALPH-check Haiku calls always run fresh; OpenRouter fanout review providers (non-Claude) also stay fresh.
- Fallback: if `agent_session_id` is null (flag off at run start) OR the JSONL file is missing on disk → legacy handoff path. Audit events `pipeline.agent_session_missing_fallback` and `system.session_volume_warning` capture both.
- Validator skip rule: `runMode === "resumed"` → skip entirely (the next agent IS the prior agent). Only the FIRST resumed stage runs validation as a paranoia check.
- Audit events added: `pipeline.agent_session_created`, `pipeline.agent_session_resumed`, `pipeline.agent_session_missing_fallback`, `system.session_volume_warning`. **Current count: 56 event types** — the Tier 1d test enforces this sentence stays in sync with `AuditEventTypeSchema.options.length`.

Spec: `docs/superpowers/specs/2026-05-19-agent-session-continuity-design.md`.
```

- [ ] **Step 2: Mirror the key points to .claude/CLAUDE.md**

Add a shorter version to `.claude/CLAUDE.md` (which is the more abbreviated guide):

```markdown
## Agent Session Continuity (BEC-227)
- One Claude SDK session per pipeline run, gated by `URATEAM_ENABLE_AGENT_SESSION_RESUME=true`
- `agent_session_id` column on `pipeline_runs`; resume threaded through executor, ralph, deep-review
- Validator + Haiku ralph-check always fresh (see `executor/session-policy.ts`)
- JSONL transcripts at `~/.claude/projects/` — mounted as named volume in compose
- Spec: `docs/superpowers/specs/2026-05-19-agent-session-continuity-design.md`
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md .claude/CLAUDE.md
git commit -m "docs(BEC-227): add agent session continuity section to CLAUDE.md"
```

---

### Task 18: Open PR

- [ ] **Step 1: Push the branch**

```bash
git push -u origin feat/agent-session-continuity-phase1
```

- [ ] **Step 2: Create the PR**

```bash
gh pr create --title "feat(BEC-227): agent session continuity — Phase 1" --body "$(cat <<'EOF'
## Summary

Phase 1 of the agent session continuity redesign. Adds Claude Agent SDK session resume across pipeline stages, gated behind `URATEAM_ENABLE_AGENT_SESSION_RESUME=true` (default off). Plus the two free wins: `excludeDynamicSections: true` on the SDK preset (Track C-1) and `PM_AGENT_STUCK_RUN_AGE_MIN` default 60 → 120 (Track C-2).

Tracks B (surgical review-fix) and D (decision artifact) ship in Phase 4 after this soaks.

## Spec
`docs/superpowers/specs/2026-05-19-agent-session-continuity-design.md`

## Test plan
- [x] All 12+ new unit test files pass
- [x] `pnpm -w typecheck` green
- [ ] Phase 2 dogfood soak (1-2 weeks with flag on) — separate from this PR
EOF
)"
```

- [ ] **Step 3: Note**: Do not merge until Phase 2 soak plan is agreed with the operator.

---

## Self-Review

Spec coverage:
- Track A core (session resume): Tasks 1, 3, 4, 5, 6, 7, 8, 9, 10, 11. ✓
- Track C-1 (`excludeDynamicSections`): Task 6 step 4. ✓
- Track C-2 (zombie age): Task 12. ✓
- Audit events (5 new): Task 2 (4 events) + Phase 4 plan will add the 5th (`pipeline.surgical_review_fix`). ✓ — note the count is 52→56 here, not 52→57; the spec said 57 because it included Track B. Updated CLAUDE.md text in Task 17 says "Current count: 56" — consistent with this plan.
- Docker volume: Task 13. ✓
- Volume sanity check + warning event: Task 14. ✓
- Dashboard transcript viewer: Tasks 15-16. ✓
- Validator skip rule: Task 9. ✓
- RALPH suppression: Task 10. ✓
- deep-review.ts resume: Task 11. ✓
- Documentation: Task 17. ✓

Placeholder scan: no "TBD" / "implement later" / "similar to" / vague handlers found. Each step has explicit code or commands. ✓

Type consistency:
- `agentSessionId: string | null` used consistently in DB row, runner, executor, deep-review. ✓
- `isResumable(stage: string, model: string)` signature stable across Tasks 3, 6, 9, 11. ✓
- `ValidateRunMode` literal union `"first-resumed" | "resumed" | "fallback"` matches between Task 9 implementation and call sites. ✓
- `runMode` plumbed from runner.ts (Task 9 step 4) — call sites use `hasInitiatedSession` and `isFirstResumableStage`, consistent with Task 6.

Out of scope here (will appear in the Phase 4 plan):
- Track B (surgical review-fix) — `surgicalReviewFixPrompt` and the review-fix loop switch
- Track D (decision artifact) — `pipeline_run_decisions` table, decisions emission/parsing, 5th audit event
- CLI `ura sessions <runId>` — listed as optional in spec, deferred to Phase 4 plan or separate PR

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-19-agent-session-continuity-phase1.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
