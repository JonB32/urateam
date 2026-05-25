/**
 * BEC-251 — executor error-capture enrichment.
 *
 * Verifies that when the Agent SDK throws a process-exit error, executor.ts
 * writes a structured-JSON payload to agent_logs.content containing:
 *   exitCode, stderr, authMethod, sessionType, durationMs
 * and a compact one-liner to stage_runs.errorMessage / StageResult.errorMessage.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module mocks (declared before imports) ────────────────────────────────────

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

vi.mock("../executor/auth-check.js", () => ({
  isClaudeAuthValid: vi.fn().mockResolvedValue(true),
  resolveClaudeAuth: vi.fn().mockReturnValue({ method: "api-key" }),
}));

vi.mock("../executor/extract-handoff.js", () => ({
  extractHandoff: vi.fn().mockResolvedValue({
    artifact: {
      runId: "run-bec251",
      issueId: "BEC-251",
      stage: "implement",
      timestamp: new Date().toISOString(),
      summary: "stub",
      filesChanged: [],
      approach: "stub",
      context: { issueIntent: "x", constraints: [], assumptions: [] },
      tokenBudget: { contextTokensUsed: 0, recommendedMaxTurns: 1 },
    },
    structured: true,
    decisions: null,
  }),
}));

vi.mock("../executor/session-store.js", async () => {
  const real = await vi.importActual<typeof import("../executor/session-store.js")>(
    "../executor/session-store.js",
  );
  return { ...real, transcriptExists: vi.fn().mockReturnValue(false) };
});

// ── Imports ───────────────────────────────────────────────────────────────────

import { eq } from "drizzle-orm";
import { executeStage } from "../executor/executor.js";
import { createDb, type Db } from "../db/client.js";
import { pipelineRuns, agentLogs } from "../db/schema.js";
import type { SanitizedIssue, RepoConfig } from "../types.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const testIssue: SanitizedIssue = {
  id: "BEC-251",
  slug: "error-capture-repro",
  title: "Error capture reproduction",
  description: "Reproduce BEC-251",
  acceptanceCriteria: ["exitCode and stderr captured"],
  labels: ["auto-implement"],
  priority: 3,
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

function makeProcessExitError(exitCode: number): Error {
  return new Error(`Claude Code process exited with code ${exitCode}`);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("BEC-251 — executor error enrichment", () => {
  let db: Db;

  beforeEach(async () => {
    db = await createDb({ connectionString: ":memory:" });
    vi.clearAllMocks();
  });

  it("writes structured JSON with exitCode and stderr to agent_logs.content", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");

    const sdkError = makeProcessExitError(1);
    // Simulate the production path: stderr arrives via the options.stderr callback
    // before the process exits and query() throws.
    (query as any).mockImplementation((opts: any) => {
      opts?.options?.stderr?.("auth: 401");
      throw sdkError;
    });

    const runId = "run-bec251-json";
    await seedPipelineRun(db, runId);

    const result = await executeStage({
      runId,
      issueId: testIssue.id,
      stage: "implement",
      sanitizedIssue: testIssue,
      repoConfig: testRepoConfig,
      workdir: "/tmp/bec251-workdir",
      db,
      agentSessionId: null,
    });

    expect(result.status).toBe("failed");

    const logs = await (db as any)
      .select()
      .from(agentLogs)
      .where(eq(agentLogs.type, "error"));

    expect(logs).toHaveLength(1);
    const content = logs[0].content;

    // Content must be valid JSON
    let parsed: Record<string, unknown>;
    expect(() => {
      parsed = JSON.parse(content);
    }).not.toThrow();

    // exitCode must be captured
    expect(parsed!.exitCode).toBe(1);

    // stderr must appear
    expect(parsed!.stderr).toBe("auth: 401");

    // authMethod must be captured
    expect(parsed!.authMethod).toBe("api-key");

    // sessionType must be present (no session in this test)
    expect(parsed!.sessionType).toBe("none");

    // durationMs must be a non-negative number
    expect(typeof parsed!.durationMs).toBe("number");
    expect(parsed!.durationMs as number).toBeGreaterThanOrEqual(0);

    // message must be the original error message
    expect(parsed!.message).toContain("Claude Code process exited with code 1");

    // Payload must stay within 2 KB
    expect(content.length).toBeLessThanOrEqual(2048);
  });

  it("writes an enriched one-liner to StageResult.errorMessage (→ pipeline_runs.error_message)", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");

    (query as any).mockImplementation(() => {
      throw makeProcessExitError(1);
    });

    const runId = "run-bec251-oneliner";
    await seedPipelineRun(db, runId);

    const result = await executeStage({
      runId,
      issueId: testIssue.id,
      stage: "implement",
      sanitizedIssue: testIssue,
      repoConfig: testRepoConfig,
      workdir: "/tmp/bec251-workdir",
      db,
      agentSessionId: null,
    });

    expect(result.status).toBe("failed");

    // errorMessage must contain inline context fields
    expect(result.errorMessage).toContain("Claude Code process exited with code 1");
    expect(result.errorMessage).toContain("exitCode=1");
    expect(result.errorMessage).toContain("auth=api-key");
    expect(result.errorMessage).toContain("session=none");
    expect(result.errorMessage).toMatch(/duration=\d+ms/);
  });

  it("captures sessionType=resumed when agentSessionId is set and transcript exists", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const { transcriptExists } = await import("../executor/session-store.js");
    (transcriptExists as any).mockReturnValue(true); // JSONL on disk → resume path

    (query as any).mockImplementation(() => {
      throw makeProcessExitError(1);
    });

    const runId = "run-bec251-resumed";
    await seedPipelineRun(db, runId);

    await executeStage({
      runId,
      issueId: testIssue.id,
      stage: "implement",
      sanitizedIssue: testIssue,
      repoConfig: testRepoConfig,
      workdir: "/tmp/bec251-workdir",
      db,
      agentSessionId: "session-uuid-1",
    });

    const logs = await (db as any)
      .select()
      .from(agentLogs)
      .where(eq(agentLogs.type, "error"));

    const parsed = JSON.parse(logs[0].content);
    expect(parsed.sessionType).toBe("resumed");
  });

  it("captures sessionType=fresh when agentSessionId is set but transcript does not exist yet", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const { transcriptExists } = await import("../executor/session-store.js");
    (transcriptExists as any).mockReturnValue(false); // no JSONL → create path

    (query as any).mockImplementation(() => {
      throw makeProcessExitError(1);
    });

    const runId = "run-bec251-fresh";
    await seedPipelineRun(db, runId);

    await executeStage({
      runId,
      issueId: testIssue.id,
      stage: "implement",
      sanitizedIssue: testIssue,
      repoConfig: testRepoConfig,
      workdir: "/tmp/bec251-workdir",
      db,
      agentSessionId: "session-uuid-2",
    });

    const logs = await (db as any)
      .select()
      .from(agentLogs)
      .where(eq(agentLogs.type, "error"));

    const parsed = JSON.parse(logs[0].content);
    expect(parsed.sessionType).toBe("fresh");
  });

  it("parses exitCode from message string when error has no exitCode property", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");

    // Plain error with no exitCode property — matches real SDK behaviour
    const plainErr = new Error("Claude Code process exited with code 127");
    (query as any).mockImplementation(() => {
      throw plainErr;
    });

    const runId = "run-bec251-parse";
    await seedPipelineRun(db, runId);

    await executeStage({
      runId,
      issueId: testIssue.id,
      stage: "implement",
      sanitizedIssue: testIssue,
      repoConfig: testRepoConfig,
      workdir: "/tmp/bec251-workdir",
      db,
      agentSessionId: null,
    });

    const logs = await (db as any)
      .select()
      .from(agentLogs)
      .where(eq(agentLogs.type, "error"));

    const parsed = JSON.parse(logs[0].content);
    expect(parsed.exitCode).toBe(127);
  });

  it("omits stderr key when stderr is empty", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");

    // No opts.stderr callback invocation → capturedStderr stays empty
    (query as any).mockImplementation(() => {
      throw makeProcessExitError(1);
    });

    const runId = "run-bec251-nostderr";
    await seedPipelineRun(db, runId);

    await executeStage({
      runId,
      issueId: testIssue.id,
      stage: "implement",
      sanitizedIssue: testIssue,
      repoConfig: testRepoConfig,
      workdir: "/tmp/bec251-workdir",
      db,
      agentSessionId: null,
    });

    const logs = await (db as any)
      .select()
      .from(agentLogs)
      .where(eq(agentLogs.type, "error"));

    const parsed = JSON.parse(logs[0].content);
    // stderr key should be absent when there is nothing to report
    expect("stderr" in parsed).toBe(false);
  });
});
