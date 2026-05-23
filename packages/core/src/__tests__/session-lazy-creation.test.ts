/**
 * BEC-231 — Lazy / retry SDK session creation.
 *
 * Reproduces the production bug surfaced during the BEC-227 Phase 2 dogfood
 * soak: when the first resumable stage's SDK call fails before any JSONL
 * message is written (auth 401, pre-stream stall, etc.), subsequent stages
 * MUST retry the create path (`sessionId:`) rather than blindly using
 * `resume:` against a transcript that never materialized.
 *
 * The pre-BEC-231 implementation used an in-memory `hasInitiatedSession` flag
 * (flipped after the first resumable stage's CALL, not after the SDK actually
 * wrote a message). The new implementation derives the shape from
 * `transcriptExists()` on every stage entry, so a stage 2 invocation against
 * a non-existent JSONL re-attempts creation.
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
      runId: "run-bec231",
      issueId: "BEC-231",
      stage: "implement",
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
  transcriptExistsMock: vi.fn(),
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
import { pipelineRuns } from "../db/schema.js";
import type { SanitizedIssue, RepoConfig } from "../types.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const testIssue: SanitizedIssue = {
  id: "BEC-231",
  slug: "lazy-session-creation",
  title: "BEC-231 lazy session creation",
  description: "Verify session shape is derived from on-disk state",
  acceptanceCriteria: ["transcriptExists drives sessionId vs resume choice"],
  labels: ["bug"],
  priority: 2,
};

const testRepoConfig: RepoConfig = {
  url: "https://github.com/test-org/test-repo",
  defaultBranch: "main",
  testCommand: "echo ok",
  buildCommand: "echo ok",
};

async function seedPipelineRun(db: Db, runId: string): Promise<void> {
  await (db as any).insert(pipelineRuns).values({
    id: runId,
    issueId: testIssue.id,
    issueTitle: testIssue.title,
    pipelineKey: "auto-implement",
    repoUrl: testRepoConfig.url,
    branch: `agent/${runId}`,
    status: "running",
  });
}

function makeMinimalStream() {
  return (async function* () {
    yield { type: "assistant", content: [{ type: "text", text: "done" }] };
  })();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("BEC-231 — lazy session creation derives shape from transcriptExists()", () => {
  let db: Db;

  beforeEach(async () => {
    db = await createDb({ connectionString: ":memory:" });
    vi.clearAllMocks();
  });

  it("isFirstResumableStage=false BUT transcript absent → retries create (sessionId:), not resume:", async () => {
    // This is the exact bug pattern: a "second" stage gets called with
    // isFirstResumableStage=false (because the runner's in-memory flag
    // believed the first stage initiated the session) but the JSONL was
    // never written (first stage failed at auth before any SDK message).
    // Pre-BEC-231: routed to resume:, found JSONL missing, dropped to
    // legacy fresh-session-no-opts, lost the session permanently.
    // Post-BEC-231: routes to sessionId: → SDK creates the session now.
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    (query as any).mockReturnValue(makeMinimalStream());
    transcriptExistsMock.mockReturnValue(false);

    await seedPipelineRun(db, "run-bec231-stage2-recreate");

    await executeStage({
      runId: "run-bec231-stage2-recreate",
      issueId: testIssue.id,
      stage: "implement",
      sanitizedIssue: testIssue,
      repoConfig: testRepoConfig,
      workdir: "/tmp/bec231-workdir",
      db,
      agentSessionId: "uuid-bec231",
      isFirstResumableStage: false,
    });

    const opts = (query as any).mock.calls[0][0].options;
    expect(opts.sessionId).toBe("uuid-bec231");
    expect(opts.resume).toBeUndefined();
  });

  it("isFirstResumableStage=true AND transcript present → resumes (transcriptExists wins over the flag)", async () => {
    // Symmetric case: the runner says "this is the first resumable stage"
    // but the JSONL actually already exists (e.g. retriable resume after a
    // restart that lost the in-memory flag). BEC-231 still routes to
    // resume: because the transcript is on disk.
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    (query as any).mockReturnValue(makeMinimalStream());
    transcriptExistsMock.mockReturnValue(true);

    await seedPipelineRun(db, "run-bec231-restarted");

    await executeStage({
      runId: "run-bec231-restarted",
      issueId: testIssue.id,
      stage: "implement",
      sanitizedIssue: testIssue,
      repoConfig: testRepoConfig,
      workdir: "/tmp/bec231-workdir",
      db,
      agentSessionId: "uuid-bec231-existing",
      isFirstResumableStage: true,
    });

    const opts = (query as any).mock.calls[0][0].options;
    expect(opts.resume).toBe("uuid-bec231-existing");
    expect(opts.sessionId).toBeUndefined();
  });
});
