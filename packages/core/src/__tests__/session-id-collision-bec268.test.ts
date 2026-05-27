/**
 * BEC-268 — regression tests for session-ID collision recovery.
 *
 * When a stage calls `query({ sessionId: X })` and fails before any JSONL
 * message is written, the Claude SDK registers ID X internally but writes
 * nothing to disk. Without recovery, every retry re-sends `{ sessionId: X }`
 * and hits the same "Session ID X is already in use" wall.
 *
 * Fix (Option A): executor detects the collision pattern in stderr, mints a
 * fresh UUID, persists it to `pipeline_runs.agent_session_id`, logs a warn,
 * emits `pipeline.agent_session_collision_recovered`, and includes a
 * transient-matching sentinel in the errorMessage so `isTransientError()`
 * marks the run retriable.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { isTransientError } from "../pipeline/error-classifier.js";

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

// Capture logAuditEvent calls — bypasses the enterprise license gate in tests.
const { logAuditEventMock } = vi.hoisted(() => ({
  logAuditEventMock: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../audit/writer.js", async () => {
  const real = await vi.importActual<typeof import("../audit/writer.js")>(
    "../audit/writer.js",
  );
  return { ...real, logAuditEvent: logAuditEventMock };
});

// ── Imports ───────────────────────────────────────────────────────────────────

import { executeStage } from "../executor/executor.js";
import { createDb, type Db } from "../db/client.js";
import { pipelineRuns } from "../db/schema.js";
import { eq } from "drizzle-orm";
import type { SanitizedIssue, RepoConfig } from "../types.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const testIssue: SanitizedIssue = {
  id: "BEC-268",
  slug: "session-id-collision",
  title: "Session-ID collision after partial first-stage failure",
  description: "Regression test for BEC-268 session collision recovery",
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
  agentSessionId: string | null,
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

describe("BEC-268 — session-ID collision recovery (Option A fix)", () => {
  let db: Db;

  beforeEach(async () => {
    db = await createDb({ connectionString: ":memory:" });
    vi.clearAllMocks();
    logAuditEventMock.mockResolvedValue(undefined);
    // No JSONL on disk — resolver returns { sessionId: X } (create branch).
    transcriptExistsMock.mockReturnValue(false);
  });

  it("collision detected: mints new UUID, persists it, emits audit event, errorMessage is transient", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");

    (query as any).mockImplementation(({ options }: { options: { stderr?: (chunk: string) => void } }) => {
      return (async function* () {
        options.stderr?.(COLLISION_STDERR);
        throw new Error(COLLISION_EXIT_ERROR);
      })();
    });

    const runId = "run-bec268-collision";
    await seedPipelineRunWithSession(db, runId, COLLISION_SESSION_ID);

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

    // Stage returns "failed" — the agent invocation did fail.
    expect(result.status).toBe("failed");

    // errorMessage contains the transient sentinel so isTransientError() marks
    // the run retriable and the recovery loop retries with the new UUID.
    expect(result.errorMessage).toContain("session-id-collision-recovered");
    expect(isTransientError(result.errorMessage!)).toBe(true);

    // A fresh UUID is persisted — the recovery loop reads this new ID from DB.
    const rows = await (db as any)
      .select({ agentSessionId: pipelineRuns.agentSessionId })
      .from(pipelineRuns)
      .where(eq(pipelineRuns.id, runId));
    expect(rows).toHaveLength(1);
    const newSessionId = rows[0].agentSessionId as string;
    expect(newSessionId).toBeTruthy();
    expect(newSessionId).not.toBe(COLLISION_SESSION_ID);

    // logAuditEvent called with the collision-recovered event.
    expect(logAuditEventMock).toHaveBeenCalledOnce();
    const [, event] = logAuditEventMock.mock.calls[0] as [unknown, { eventType: string; payload: Record<string, unknown> }];
    expect(event.eventType).toBe("pipeline.agent_session_collision_recovered");
    expect(event.payload.oldSessionId).toBe(COLLISION_SESSION_ID);
    expect(event.payload.newSessionId).toBe(newSessionId);
    expect(event.payload.stage).toBe("triage");
    expect(event.payload.runId).toBe(runId);
  });

  it("recovery loop reads fresh UUID from DB on retry — no second collision", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");

    let callCount = 0;
    (query as any).mockImplementation(({ options }: { options: { stderr?: (chunk: string) => void } }) => {
      callCount++;
      if (callCount === 1) {
        return (async function* () {
          options.stderr?.(COLLISION_STDERR);
          throw new Error(COLLISION_EXIT_ERROR);
        })();
      }
      // Second attempt (with fresh UUID): succeeds
      return (async function* () {
        yield { type: "assistant", content: [{ type: "text", text: "done" }] };
      })();
    });

    const runId = "run-bec268-recovery-loop";
    await seedPipelineRunWithSession(db, runId, COLLISION_SESSION_ID);

    // First attempt — collision handled, new UUID persisted.
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
    expect(result1.errorMessage).toContain("session-id-collision-recovered");

    // Simulate recovery loop: read the new agentSessionId from DB.
    const afterFirst = await (db as any)
      .select({ agentSessionId: pipelineRuns.agentSessionId })
      .from(pipelineRuns)
      .where(eq(pipelineRuns.id, runId));
    const freshSessionId = afterFirst[0].agentSessionId as string;
    expect(freshSessionId).not.toBe(COLLISION_SESSION_ID);

    // Second attempt uses the fresh UUID — succeeds.
    const result2 = await executeStage({
      runId,
      issueId: testIssue.id,
      stage: "triage",
      sanitizedIssue: testIssue,
      repoConfig: testRepoConfig,
      workdir: "/tmp/bec268-workdir",
      db,
      agentSessionId: freshSessionId,
      isFirstResumableStage: true,
    });
    expect(result2.status).toBe("completed");
  });

  it("non-collision stderr — agentSessionId unchanged, no audit event, not transient", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");

    (query as any).mockImplementation(({ options }: { options: { stderr?: (chunk: string) => void } }) => {
      return (async function* () {
        options.stderr?.("Error: ANTHROPIC_API_KEY is not set\n");
        throw new Error(COLLISION_EXIT_ERROR);
      })();
    });

    const runId = "run-bec268-non-collision";
    const OTHER_SESSION_ID = "aaaa-bbbb-cccc-dddd-eeee";
    await seedPipelineRunWithSession(db, runId, OTHER_SESSION_ID);

    const result = await executeStage({
      runId,
      issueId: testIssue.id,
      stage: "triage",
      sanitizedIssue: testIssue,
      repoConfig: testRepoConfig,
      workdir: "/tmp/bec268-workdir",
      db,
      agentSessionId: OTHER_SESSION_ID,
      isFirstResumableStage: true,
    });

    expect(result.status).toBe("failed");
    // No collision sentinel in the errorMessage.
    expect(result.errorMessage).not.toContain("session-id-collision-recovered");
    // Not transient — regular (non-auth, non-network) failure.
    expect(isTransientError(result.errorMessage!)).toBe(false);

    // agentSessionId in DB is unchanged — no collision recovery triggered.
    const rows = await (db as any)
      .select({ agentSessionId: pipelineRuns.agentSessionId })
      .from(pipelineRuns)
      .where(eq(pipelineRuns.id, runId));
    expect(rows[0].agentSessionId).toBe(OTHER_SESSION_ID);

    // No audit event for non-collision failures.
    expect(logAuditEventMock).not.toHaveBeenCalled();
  });

  it("agentSessionId=null — collision not applicable, no recovery attempted", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");

    // Even with collision stderr, recovery requires a non-null agentSessionId.
    (query as any).mockImplementation(({ options }: { options: { stderr?: (chunk: string) => void } }) => {
      return (async function* () {
        options.stderr?.(COLLISION_STDERR);
        throw new Error(COLLISION_EXIT_ERROR);
      })();
    });

    const runId = "run-bec268-null-session";
    await seedPipelineRunWithSession(db, runId, null);

    const result = await executeStage({
      runId,
      issueId: testIssue.id,
      stage: "triage",
      sanitizedIssue: testIssue,
      repoConfig: testRepoConfig,
      workdir: "/tmp/bec268-workdir",
      db,
      agentSessionId: null,
      isFirstResumableStage: false,
    });

    // Returns failed without collision recovery (agentSessionId was null).
    expect(result.status).toBe("failed");
    expect(result.errorMessage).not.toContain("session-id-collision-recovered");
    expect(logAuditEventMock).not.toHaveBeenCalled();
  });
});
