/**
 * BEC-268 — Reproduce: Session-ID collision after partial first-stage failure.
 *
 * When a stage calls `query({ sessionId: X })` and fails before any JSONL
 * message is written (SDK auth-retry loop, MCP init crash, pre-stream stall),
 * the Claude SDK has already registered ID X internally. On disk, urateam sees
 * no transcript. The next stage / recovery-loop retry:
 *
 *   1. `transcriptExists(X)` → false (no JSONL on disk)
 *   2. resolver returns `{ sessionId: X }` (create branch)
 *   3. SDK rejects: "Session ID X is already in use."
 *
 * This test reproduces the gap in the current executor: the catch block
 * records the failure but does NOT detect the collision substring in stderr,
 * does NOT mint a new UUID, does NOT persist it, and does NOT re-throw as a
 * transient error. Every subsequent retry hits the same wall.
 *
 * The test is deliberately written to FAIL once the fix (Option A from the
 * issue) is implemented — at that point the assertions should be inverted so
 * the test becomes the regression guard instead.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module mocks (declared before imports) ────────────────────────────────────

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

vi.mock("../executor/auth-check.js", () => ({
  isClaudeAuthValid: vi.fn().mockResolvedValue(true),
  resolveClaudeAuth: vi.fn().mockReturnValue({ method: "mounted-session" }),
}));

vi.mock("../executor/extract-handoff.js", () => ({
  extractHandoff: vi.fn().mockResolvedValue({
    artifact: {
      runId: "run-bec268",
      issueId: "BEC-268",
      stage: "triage",
      timestamp: new Date().toISOString(),
      summary: "Stub handoff",
      filesChanged: [],
      approach: "Stub",
      context: { issueIntent: "x", constraints: [], assumptions: [] },
      tokenBudget: { contextTokensUsed: 0, recommendedMaxTurns: 1 },
    },
    structured: true,
    decisions: null,
  }),
}));

const { transcriptExistsMock } = vi.hoisted(() => ({
  transcriptExistsMock: vi.fn().mockReturnValue(false),
}));
vi.mock("../executor/session-store.js", async () => {
  const real = await vi.importActual<typeof import("../executor/session-store.js")>(
    "../executor/session-store.js",
  );
  return {
    ...real,
    transcriptExists: transcriptExistsMock,
  };
});

// ── Imports ───────────────────────────────────────────────────────────────────

import { executeStage } from "../executor/executor.js";
import { createDb, type Db } from "../db/client.js";
import { pipelineRuns, auditEvents } from "../db/schema.js";
import { eq } from "drizzle-orm";
import type { SanitizedIssue, RepoConfig } from "../types.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const testIssue: SanitizedIssue = {
  id: "BEC-268",
  slug: "session-id-collision",
  title: "Session-ID collision after partial first-stage failure",
  description: "Reproduce BEC-268 session collision bug",
  acceptanceCriteria: ["executor detects and recovers from session ID collision"],
  labels: ["auto-implement"],
  priority: 2,
};

const testRepoConfig: RepoConfig = {
  url: "https://github.com/test-org/test-repo",
  defaultBranch: "main",
  testCommand: "echo ok",
  buildCommand: "echo ok",
};

const COLLISION_SESSION_ID = "7ddad1c1-e174-4d66-b2dc-a36e607ae7f3";
const COLLISION_STDERR = `Error: Session ID ${COLLISION_SESSION_ID} is already in use.\n`;
const COLLISION_EXIT_ERROR = "Claude Code process exited with code 1";

async function seedPipelineRunWithSession(
  db: Db,
  runId: string,
  agentSessionId: string,
): Promise<void> {
  await (db as any).insert(pipelineRuns).values({
    id: runId,
    issueId: testIssue.id,
    issueTitle: testIssue.title,
    pipelineKey: "auto-implement",
    repoUrl: testRepoConfig.url,
    branch: `agent/${runId}`,
    status: "running",
    agentSessionId,
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("BEC-268 — Session-ID collision after partial first-stage failure", () => {
  let db: Db;

  beforeEach(async () => {
    db = await createDb({ connectionString: ":memory:" });
    vi.clearAllMocks();
    // No JSONL on disk — executor sees transcript absent → `{ sessionId: X }`
    transcriptExistsMock.mockReturnValue(false);
  });

  it("BUG: collision stderr is present in agent_logs but executor returns failed (not transient) and leaves agentSessionId unchanged", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");

    // Simulate the SDK registering the ID, calling stderr, then throwing.
    // This is exactly what the Claude Code subprocess does when it rejects
    // a session ID that is already claimed in its local state.
    (query as any).mockImplementation(({ options }: { options: { stderr?: (chunk: string) => void } }) => {
      return (async function* () {
        // SDK writes collision message to stderr before the process exits.
        options.stderr?.(COLLISION_STDERR);
        throw new Error(COLLISION_EXIT_ERROR);
      })();
    });

    const runId = "run-bec268-collision";
    await seedPipelineRunWithSession(db, runId, COLLISION_SESSION_ID);

    // executeStage should (ideally) throw a transient error so the recovery
    // loop retries with a fresh session ID. Currently it does not — it absorbs
    // the error and returns { status: "failed" }.
    const result = await executeStage({
      runId,
      issueId: testIssue.id,
      stage: "triage",
      sanitizedIssue: testIssue,
      repoConfig: testRepoConfig,
      workdir: "/tmp/bec268-workdir",
      db,
      agentSessionId: COLLISION_SESSION_ID,
      isFirstResumableStage: true,
    });

    // BUG CONFIRMED: executor returns "failed" — it does not re-throw a
    // transient error that would trigger the recovery loop with a new UUID.
    expect(result.status).toBe("failed");

    // Verify the collision message propagated into the enriched error context.
    // This shows the executor DID see the stderr — it just didn't act on it.
    expect(result.errorMessage).toContain(COLLISION_EXIT_ERROR);

    // BUG CONFIRMED: pipeline_runs.agent_session_id is UNCHANGED —
    // the executor never minted a fresh UUID or persisted it.
    const rows = await (db as any)
      .select({ agentSessionId: pipelineRuns.agentSessionId })
      .from(pipelineRuns)
      .where(eq(pipelineRuns.id, runId));

    expect(rows).toHaveLength(1);
    expect(rows[0].agentSessionId).toBe(COLLISION_SESSION_ID);
    // ^ Still the old (poisoned) UUID — every retry will collide again.

    // BUG CONFIRMED: no collision-recovery audit event was emitted.
    const recoveryEvents = await (db as any)
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.eventType, "pipeline.agent_session_collision_recovered" as any));

    expect(recoveryEvents).toHaveLength(0);
    // ^ When the fix ships, this should be 1 (and the assertions above should flip).
  });

  it("BUG: retry with the same agentSessionId hits the same collision — no session refresh occurs", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");

    // Always fail with the collision error, simulating what happens on every
    // retry since the session ID is never refreshed.
    (query as any).mockImplementation(({ options }: { options: { stderr?: (chunk: string) => void } }) => {
      return (async function* () {
        options.stderr?.(COLLISION_STDERR);
        throw new Error(COLLISION_EXIT_ERROR);
      })();
    });

    const runId = "run-bec268-retry";
    await seedPipelineRunWithSession(db, runId, COLLISION_SESSION_ID);

    // First attempt
    const result1 = await executeStage({
      runId,
      issueId: testIssue.id,
      stage: "triage",
      sanitizedIssue: testIssue,
      repoConfig: testRepoConfig,
      workdir: "/tmp/bec268-workdir",
      db,
      agentSessionId: COLLISION_SESSION_ID,
      isFirstResumableStage: true,
    });
    expect(result1.status).toBe("failed");

    // Check agentSessionId unchanged after first attempt
    const rowsAfterFirst = await (db as any)
      .select({ agentSessionId: pipelineRuns.agentSessionId })
      .from(pipelineRuns)
      .where(eq(pipelineRuns.id, runId));
    expect(rowsAfterFirst[0].agentSessionId).toBe(COLLISION_SESSION_ID);

    // Second attempt (simulating what the recovery loop does — uses the same
    // agentSessionId from pipeline_runs.agent_session_id)
    const result2 = await executeStage({
      runId,
      issueId: testIssue.id,
      stage: "triage",
      sanitizedIssue: testIssue,
      repoConfig: testRepoConfig,
      workdir: "/tmp/bec268-workdir",
      db,
      agentSessionId: COLLISION_SESSION_ID, // same poisoned UUID
      isFirstResumableStage: true,
    });

    // BUG CONFIRMED: second attempt also fails with the same collision.
    // Without a fix, every retry hits this wall indefinitely.
    expect(result2.status).toBe("failed");

    // Still no refresh
    const rowsAfterSecond = await (db as any)
      .select({ agentSessionId: pipelineRuns.agentSessionId })
      .from(pipelineRuns)
      .where(eq(pipelineRuns.id, runId));
    expect(rowsAfterSecond[0].agentSessionId).toBe(COLLISION_SESSION_ID);
  });

  it("non-collision failure: stderr without collision substring — behavior unchanged (baseline)", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");

    // Regular non-collision failure (auth error, build error, etc.)
    (query as any).mockImplementation(({ options }: { options: { stderr?: (chunk: string) => void } }) => {
      return (async function* () {
        options.stderr?.("Error: ANTHROPIC_API_KEY is not set\n");
        throw new Error("Claude Code process exited with code 1");
      })();
    });

    const runId = "run-bec268-non-collision";
    const DIFFERENT_SESSION_ID = "aaaa-bbbb-cccc-dddd-eeee";
    await seedPipelineRunWithSession(db, runId, DIFFERENT_SESSION_ID);

    const result = await executeStage({
      runId,
      issueId: testIssue.id,
      stage: "triage",
      sanitizedIssue: testIssue,
      repoConfig: testRepoConfig,
      workdir: "/tmp/bec268-workdir",
      db,
      agentSessionId: DIFFERENT_SESSION_ID,
      isFirstResumableStage: true,
    });

    // Non-collision failures still return "failed" — behavior unchanged.
    expect(result.status).toBe("failed");

    // agentSessionId also unchanged — this is the expected behavior for
    // non-collision failures (no UUID refresh needed).
    const rows = await (db as any)
      .select({ agentSessionId: pipelineRuns.agentSessionId })
      .from(pipelineRuns)
      .where(eq(pipelineRuns.id, runId));
    expect(rows[0].agentSessionId).toBe(DIFFERENT_SESSION_ID);
  });
});
