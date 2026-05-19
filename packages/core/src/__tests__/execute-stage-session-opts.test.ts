/**
 * Tests for BEC-227 — Task 6:
 * Thread `agentSessionId` + `isFirstResumableStage` into `executeStage()`,
 * verify the resulting SDK `query()` options carry the right session shape:
 *
 *  - First resumable stage    → `options.sessionId` (NOT `options.resume`)
 *  - Non-first resumable stage → `options.resume`   (NOT `options.sessionId`)
 *  - `agentSessionId === null` → neither in options
 *
 * Also asserts the Track C-1 (Phase 1, default-on) `systemPrompt` shape:
 *  - `{ type: "preset", preset: "claude_code", excludeDynamicSections: true }`
 *
 * The SDK `query` function and side-effecting helpers are mocked so this is
 * a pure options-shape test — no Agent SDK calls, no git ops, no auth checks.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module mocks (declared before imports) ────────────────────────────────────

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

vi.mock("../executor/auth-check.js", () => ({
  isClaudeAuthValid: vi.fn().mockResolvedValue(true),
  resolveClaudeAuth: vi.fn().mockReturnValue({ method: "session" }),
}));

vi.mock("../executor/extract-handoff.js", () => ({
  extractHandoff: vi.fn().mockResolvedValue({
    artifact: {
      runId: "run-bec227",
      issueId: "BEC-227",
      stage: "implement",
      timestamp: new Date().toISOString(),
      summary: "Stub handoff",
      filesChanged: [],
      approach: "Stub",
      context: { issueIntent: "x", constraints: [], assumptions: [] },
      tokenBudget: { contextTokensUsed: 0, recommendedMaxTurns: 1 },
    },
    structured: true,
  }),
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import { executeStage } from "../executor/executor.js";
import { createDb, type Db } from "../db/client.js";
import { pipelineRuns } from "../db/schema.js";
import type { SanitizedIssue, RepoConfig } from "../types.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const testIssue: SanitizedIssue = {
  id: "BEC-227",
  slug: "agent-session-continuity",
  title: "Agent session continuity Phase 1",
  description: "Thread session opts through executeStage",
  acceptanceCriteria: ["session opts passed correctly"],
  labels: ["auto-implement"],
  priority: 4,
};

const testRepoConfig: RepoConfig = {
  url: "https://github.com/test-org/test-repo",
  defaultBranch: "main",
  testCommand: "echo ok",
  buildCommand: "echo ok",
};

/** Seed the required pipeline_runs parent row so stage_runs FK is satisfied. */
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

/** Minimal Agent SDK stream — one assistant text message then end. */
function makeMinimalStream() {
  return (async function* () {
    yield {
      type: "assistant",
      content: [{ type: "text", text: "done" }],
    };
  })();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("executeStage — agent session options (BEC-227, Task 6)", () => {
  let db: Db;

  beforeEach(async () => {
    db = await createDb({ connectionString: ":memory:" });
    vi.clearAllMocks();
  });

  it("first resumable stage: passes options.sessionId, NOT options.resume", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    (query as any).mockReturnValue(makeMinimalStream());

    await seedPipelineRun(db, "run-first-resumable");

    await executeStage({
      runId: "run-first-resumable",
      issueId: testIssue.id,
      stage: "reproduce",
      sanitizedIssue: testIssue,
      repoConfig: testRepoConfig,
      workdir: "/tmp/bec227-workdir",
      db,
      agentSessionId: "uuid-1",
      isFirstResumableStage: true,
    });

    expect(query).toHaveBeenCalledOnce();
    const opts = (query as any).mock.calls[0][0].options;
    expect(opts.sessionId).toBe("uuid-1");
    expect(opts.resume).toBeUndefined();
    // Track C-1: systemPrompt preset with excludeDynamicSections=true
    expect(opts.systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      excludeDynamicSections: true,
    });
  });

  it("non-first resumable stage: passes options.resume, NOT options.sessionId", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    (query as any).mockReturnValue(makeMinimalStream());

    await seedPipelineRun(db, "run-non-first-resumable");

    await executeStage({
      runId: "run-non-first-resumable",
      issueId: testIssue.id,
      stage: "implement",
      sanitizedIssue: testIssue,
      repoConfig: testRepoConfig,
      workdir: "/tmp/bec227-workdir",
      db,
      agentSessionId: "uuid-1",
      isFirstResumableStage: false,
    });

    expect(query).toHaveBeenCalledOnce();
    const opts = (query as any).mock.calls[0][0].options;
    expect(opts.resume).toBe("uuid-1");
    expect(opts.sessionId).toBeUndefined();
    // Track C-1 is on regardless of session state
    expect(opts.systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      excludeDynamicSections: true,
    });
  });

  it("agentSessionId=null: neither sessionId nor resume in options, but excludeDynamicSections still ON", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    (query as any).mockReturnValue(makeMinimalStream());

    await seedPipelineRun(db, "run-flag-off");

    await executeStage({
      runId: "run-flag-off",
      issueId: testIssue.id,
      stage: "implement",
      sanitizedIssue: testIssue,
      repoConfig: testRepoConfig,
      workdir: "/tmp/bec227-workdir",
      db,
      agentSessionId: null,
      isFirstResumableStage: false,
    });

    expect(query).toHaveBeenCalledOnce();
    const opts = (query as any).mock.calls[0][0].options;
    expect(opts.sessionId).toBeUndefined();
    expect(opts.resume).toBeUndefined();
    // Track C-1 ships unconditionally — even when no session is involved
    expect(opts.systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      excludeDynamicSections: true,
    });
  });
});
