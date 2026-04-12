/**
 * Integration tests for the Agent SDK query() integration.
 *
 * These tests spin up a real Agent SDK session against the Anthropic API and
 * verify that executeStage() correctly tracks tokens, accumulates turns, and
 * extracts a handoff artifact end-to-end.
 *
 * Gate: set RUN_INTEGRATION_TESTS=1 (and provide ANTHROPIC_API_KEY) to run.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { eq } from "drizzle-orm";

import { executeStage } from "../executor/executor.js";
import { createDb, type Db } from "../db/client.js";
import { pipelineRuns, stageRuns, agentLogs } from "../db/schema.js";
import type { SanitizedIssue, RepoConfig } from "../types.js";

// ---------------------------------------------------------------------------
// Gate: skip everything unless RUN_INTEGRATION_TESTS=1 is in the environment
// ---------------------------------------------------------------------------
const RUN_INTEGRATION = process.env.RUN_INTEGRATION_TESTS === "1";
const itIntegration = RUN_INTEGRATION ? it : it.skip;

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/** Minimal sanitized issue for the implement stage */
const testIssue: SanitizedIssue = {
  id: "INT-1",
  slug: "add-greeting-function",
  title: "Add a greeting function",
  description:
    "Create a file called `greet.ts` in the repository root that exports a function `greet(name: string): string` which returns `Hello, {name}!`.",
  acceptanceCriteria: [
    "greet.ts exists at the root of the repository",
    "greet() returns the correct greeting string",
  ],
  labels: ["auto-implement"],
  priority: 2,
};

/** Minimal repo config pointing at the temp directory */
const testRepoConfig: RepoConfig = {
  url: "https://github.com/test-org/test-repo",
  defaultBranch: "main",
  testCommand: "echo 'no tests'",
  buildCommand: "echo 'no build'",
};

/** Create a minimal git repository with one committed file */
async function createTestRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "executor-integration-"));
  execFileSync("git", ["init"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "ci@test.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "CI Bot"], { cwd: dir });
  await writeFile(join(dir, "README.md"), "# Test repo\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-m", "initial commit"], { cwd: dir });
  return dir;
}

/** Create an in-memory SQLite database with all tables */
async function createTestDb(): Promise<Db> {
  return createDb({ connectionString: ":memory:" });
}

/** Insert the required pipeline_runs parent row so stageRuns FK is satisfied */
async function seedPipelineRun(db: Db, runId: string): Promise<void> {
  await (db as any).insert(pipelineRuns).values({
    id: runId,
    issueId: testIssue.id,
    issueTitle: testIssue.title,
    pipelineKey: "default",
    repoUrl: testRepoConfig.url,
    branch: "agent/INT-1-add-greeting-function",
    status: "running",
  });
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------
describe("executeStage() — Agent SDK integration", () => {
  let workdir: string;
  let db: Db;
  const runId = "integration-run-1";

  beforeEach(async () => {
    workdir = await createTestRepo();
    db = await createTestDb();
    await seedPipelineRun(db, runId);
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Test 1: End-to-end implement stage with real Agent SDK
  // -------------------------------------------------------------------------
  itIntegration(
    "runs an implement stage and returns a completed StageResult",
    async () => {
      const result = await executeStage({
        runId,
        issueId: testIssue.id,
        stage: "implement",
        sanitizedIssue: testIssue,
        repoConfig: testRepoConfig,
        workdir,
        db,
      });

      // Stage must complete (not fail due to API errors or timeouts)
      expect(result.status).toBe("completed");

      // A handoff artifact must be present
      expect(result.handoffArtifact).toBeDefined();
      expect(result.handoffArtifact!.runId).toBe(runId);
      expect(result.handoffArtifact!.issueId).toBe(testIssue.id);
      expect(result.handoffArtifact!.stage).toBe("implement");

      // Timestamp must be a valid ISO-8601 string
      const ts = new Date(result.handoffArtifact!.timestamp);
      expect(Number.isNaN(ts.getTime())).toBe(false);
    },
    // Real API calls can take a while — allow up to 3 minutes
    180_000,
  );

  // -------------------------------------------------------------------------
  // Test 2: Token tracking accuracy
  // -------------------------------------------------------------------------
  itIntegration(
    "reports non-zero input and output token counts after a real API call",
    async () => {
      const result = await executeStage({
        runId,
        issueId: testIssue.id,
        stage: "implement",
        sanitizedIssue: testIssue,
        repoConfig: testRepoConfig,
        workdir,
        db,
      });

      // Both token counts must be positive integers
      expect(result.inputTokens).toBeGreaterThan(0);
      expect(result.outputTokens).toBeGreaterThan(0);
      expect(Number.isInteger(result.inputTokens)).toBe(true);
      expect(Number.isInteger(result.outputTokens)).toBe(true);

      // At least one turn must have occurred
      expect(result.turns).toBeGreaterThan(0);
    },
    180_000,
  );

  // -------------------------------------------------------------------------
  // Test 3: DB persistence — stageRuns row is written correctly
  // -------------------------------------------------------------------------
  itIntegration(
    "persists the stage result to the stageRuns table with accurate token counts",
    async () => {
      const result = await executeStage({
        runId,
        issueId: testIssue.id,
        stage: "implement",
        sanitizedIssue: testIssue,
        repoConfig: testRepoConfig,
        workdir,
        db,
      });

      // Query the DB for the stage run record
      const rows = await (db as any)
        .select()
        .from(stageRuns)
        .where(eq(stageRuns.pipelineRunId, runId));

      expect(rows).toHaveLength(1);
      const row = rows[0];

      // Status must match the returned result
      expect(row.status).toBe(result.status);

      // Token counts in DB must match the returned StageResult
      expect(row.inputTokens).toBe(result.inputTokens);
      expect(row.outputTokens).toBe(result.outputTokens);
      expect(row.turns).toBe(result.turns);

      // completedAt must be set for a finished stage
      expect(row.completedAt).not.toBeNull();

      // Handoff artifact JSON must be present and parseable
      if (result.handoffArtifact) {
        expect(row.handoffArtifact).toBeDefined();
        const parsed = JSON.parse(row.handoffArtifact as string);
        expect(parsed.runId).toBe(runId);
        expect(parsed.issueId).toBe(testIssue.id);
        expect(parsed.stage).toBe("implement");
      }
    },
    180_000,
  );

  // -------------------------------------------------------------------------
  // Test 4: Handoff artifact extraction — structured or git-fallback path
  // -------------------------------------------------------------------------
  itIntegration(
    "extracts a handoff artifact with required fields from agent output",
    async () => {
      const result = await executeStage({
        runId,
        issueId: testIssue.id,
        stage: "implement",
        sanitizedIssue: testIssue,
        repoConfig: testRepoConfig,
        workdir,
        db,
      });

      const artifact = result.handoffArtifact!;
      expect(artifact).toBeDefined();

      // Identity fields must always be injected by the pipeline, not the agent
      expect(artifact.runId).toBe(runId);
      expect(artifact.issueId).toBe(testIssue.id);
      expect(artifact.stage).toBe("implement");

      // Summary must be a non-empty string (either from agent JSON or git fallback)
      expect(typeof artifact.summary).toBe("string");
      expect(artifact.summary.length).toBeGreaterThan(0);

      // filesChanged must be an array (may be empty if agent produced JSON)
      expect(Array.isArray(artifact.filesChanged)).toBe(true);

      // Context must have the required shape
      expect(typeof artifact.context.issueIntent).toBe("string");
      expect(Array.isArray(artifact.context.constraints)).toBe(true);
      expect(Array.isArray(artifact.context.assumptions)).toBe(true);

      // Token budget must have non-negative integers
      expect(artifact.tokenBudget.contextTokensUsed).toBeGreaterThanOrEqual(0);
      expect(artifact.tokenBudget.recommendedMaxTurns).toBeGreaterThanOrEqual(0);
    },
    180_000,
  );

  // -------------------------------------------------------------------------
  // Test 5: Agent logs are written to the DB
  // -------------------------------------------------------------------------
  itIntegration(
    "writes agent log entries to the agentLogs table during execution",
    async () => {
      await executeStage({
        runId,
        issueId: testIssue.id,
        stage: "implement",
        sanitizedIssue: testIssue,
        repoConfig: testRepoConfig,
        workdir,
        db,
      });

      // Find the stage run so we can look up its logs
      const stageRows = await (db as any)
        .select()
        .from(stageRuns)
        .where(eq(stageRuns.pipelineRunId, runId));

      expect(stageRows).toHaveLength(1);
      const stageRunId = stageRows[0].id;

      // There should be at least one agent log entry (tool calls, results, etc.)
      const logRows = await (db as any)
        .select()
        .from(agentLogs)
        .where(eq(agentLogs.stageRunId, stageRunId));

      // An implement stage will typically produce tool_use/tool_result entries
      // We only assert non-zero if the agent took at least one tool turn
      if (stageRows[0].turns > 0) {
        expect(logRows.length).toBeGreaterThan(0);
      }

      // All log entries must have valid type and non-empty content
      for (const log of logRows) {
        expect(typeof log.type).toBe("string");
        expect(log.type.length).toBeGreaterThan(0);
        expect(typeof log.content).toBe("string");
        expect(log.content.length).toBeGreaterThan(0);
        // Content is capped at 2048 chars per executor.ts
        expect(log.content.length).toBeLessThanOrEqual(2048);
      }
    },
    180_000,
  );
});
