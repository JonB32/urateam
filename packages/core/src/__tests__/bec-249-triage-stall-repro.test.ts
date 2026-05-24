/**
 * BEC-249 Fix verification: stall guards now fire for the triage stage.
 *
 * ## Root cause (confirmed during reproduce phase)
 *
 * In `executor.ts` (pre-fix), the sequence was:
 *
 *   line 264:  const sessionOpts = await resolveSessionOpts({...});  // could hang
 *   line 327:  const stageTimeoutPromise = new Promise<never>(...    // wall-clock timer
 *   line 333:  await Promise.race([consumeAgentStream(...), stageTimeoutPromise]);
 *
 * `resolveSessionOpts` calls `countLines()` — a `createReadStream`-backed
 * line counter — which hangs indefinitely on an unresponsive Docker volume.
 *
 * ## Fix
 *
 * `stageTimeoutPromise` is now created BEFORE any pre-flight `await`:
 *
 *   line ~230: stageTimeoutPromise = new Promise<never>(...  // wall-clock timer (EARLY)
 *   line ~278: await Promise.race([resolveSessionOpts(...), stageTimeoutPromise])
 *   line ~344: await Promise.race([consumeAgentStream(...), stageTimeoutPromise])
 *
 * Both pre-flight and stream phases are now covered by the wall-clock guard.
 *
 * ## Test sections
 *
 * Section 1 ("gap fixed"): mocks `resolveSessionOpts` to never resolve,
 * advances fake time 35 min, verifies the stage resolves as 'failed'.
 *
 * Section 2 ("static ordering proof"): reads executor.ts source and asserts
 * `stageTimeoutPromise` appears BEFORE the `resolveSessionOpts` call.
 *
 * Section 3 ("AC delivered"): confirms the executeStage+triage AC test
 * was added to bec-183-pre-stream-stall.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Module mocks — must be declared before any imports that use them
// ---------------------------------------------------------------------------

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

vi.mock("../executor/auth-check.js", () => ({
  isClaudeAuthValid: vi.fn().mockResolvedValue(true),
  resolveClaudeAuth: vi.fn().mockReturnValue({ method: "api-key" }),
}));

vi.mock("../executor/extract-handoff.js", () => ({
  extractHandoff: vi.fn().mockResolvedValue({
    artifact: null,
    structured: false,
    decisions: null,
  }),
}));

vi.mock("../executor/session-resolver.js", () => ({
  resolveSessionOpts: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { executeStage } from "../executor/executor.js";
import { createDb, type Db } from "../db/client.js";
import { pipelineRuns, stageRuns } from "../db/schema.js";
import { eq } from "drizzle-orm";
import type { SanitizedIssue, RepoConfig } from "../types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const testIssue: SanitizedIssue = {
  id: "BEC-249",
  slug: "triage-stall-repro",
  title: "Triage stall reproduction",
  description: "Trigger the BEC-249 stall gap in the triage stage.",
  acceptanceCriteria: ["Stall protection fires for the triage stage."],
  labels: ["needs-design"],
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
    pipelineKey: "needs-design",
    repoUrl: testRepoConfig.url,
    branch: `agent/${runId}`,
    status: "running",
  });
}

// ---------------------------------------------------------------------------
// Section 1: Functional proof — pre-flight hang bypasses wall-clock guard
// ---------------------------------------------------------------------------

describe("BEC-249 gap fixed: wall-clock guard fires even when pre-flight hangs", () => {
  let db: Db;

  beforeEach(async () => {
    db = await createDb({ connectionString: ":memory:" });
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it(
    "stage resolves as 'failed' after WALL_CLOCK_STAGE_TIMEOUT_MS fires when pre-flight hangs",
    async () => {
      // Simulate unresponsive Docker volume: resolveSessionOpts never returns.
      const { resolveSessionOpts } = await import("../executor/session-resolver.js");
      (resolveSessionOpts as ReturnType<typeof vi.fn>).mockImplementation(
        () => new Promise<never>(() => {}),
      );

      await seedPipelineRun(db, "run-bec249-fixed");

      // Start the stage — it reaches Promise.race([resolveSessionOpts(...), stageTimeoutPromise]).
      // With the fix, stageTimeoutPromise is created BEFORE this race, so it fires.
      const stagePromise = executeStage({
        runId: "run-bec249-fixed",
        issueId: testIssue.id,
        stage: "triage",
        sanitizedIssue: testIssue,
        repoConfig: testRepoConfig,
        workdir: "/tmp/repro",
        db,
        agentSessionId: null,
      });

      // Advance fake time past DEFAULT_WALL_CLOCK_STAGE_TIMEOUT_MS (30 min).
      // stageTimeoutPromise fires, the race rejects, the stage fails cleanly.
      await vi.advanceTimersByTimeAsync(35 * 60_000);

      // stagePromise should now be settled (wall-clock guard fired and was handled).
      const result = await stagePromise;
      expect(result.status).toBe("failed");
      expect(result.errorMessage).toMatch(/pre-stream stall/i);

      // DB shows failed status with the error captured.
      const rows = await (db as any)
        .select()
        .from(stageRuns)
        .where(eq(stageRuns.pipelineRunId, "run-bec249-fixed"));

      expect(rows.length).toBe(1);
      expect(rows[0].status).toBe("failed");
      expect(rows[0].errorMessage).toMatch(/pre-stream stall/i);
    },
    10_000,
  );
});

// ---------------------------------------------------------------------------
// Section 2: Static ordering proof — the structural gap in executor.ts
// ---------------------------------------------------------------------------

describe("BEC-249 structural fix: stageTimeoutPromise created BEFORE resolveSessionOpts is called", () => {
  it("executor.ts creates stageTimeoutPromise on a lower line than the resolveSessionOpts call", () => {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const executorSrc = readFileSync(
      resolve(__dirname, "../executor/executor.ts"),
      "utf8",
    );
    const lines = executorSrc.split("\n");

    // Find the first line that calls resolveSessionOpts (now inside Promise.race)
    const resolveSessionOptsLine = lines.findIndex((l) =>
      l.includes("resolveSessionOpts({"),
    );

    // Find the first line that creates stageTimeoutPromise
    const stageTimeoutPromiseLine = lines.findIndex((l) =>
      l.includes("stageTimeoutPromise") && l.includes("new Promise"),
    );

    expect(resolveSessionOptsLine).toBeGreaterThan(-1);
    expect(stageTimeoutPromiseLine).toBeGreaterThan(-1);

    // THE FIX: wall-clock timer is registered BEFORE resolveSessionOpts is called.
    // If resolveSessionOpts hangs, the timer fires and the stage fails cleanly.
    expect(stageTimeoutPromiseLine).toBeLessThan(resolveSessionOptsLine);
  });

  it("session-resolver.ts calls countLines via createReadStream with no timeout — can hang on unresponsive volume", () => {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const resolverSrc = readFileSync(
      resolve(__dirname, "../executor/session-resolver.ts"),
      "utf8",
    );

    // createReadStream is present (the hang mechanism)
    expect(resolverSrc).toContain("createReadStream");

    // countLines has no AbortController or timeout
    const countLinesBody = resolverSrc.slice(
      resolverSrc.indexOf("function countLines"),
      resolverSrc.indexOf("function countLines") + 300,
    );
    expect(countLinesBody).not.toContain("AbortController");
    expect(countLinesBody).not.toContain("setTimeout");
    expect(countLinesBody).not.toContain("timeout");
  });

  it("triage stage is resumable (sonnet model) so resolveSessionOpts may call countLines on a resumed run", () => {
    // Triage profile uses DEFAULT_MODEL = 'claude-sonnet-4-6'.
    // isResumable('triage', 'claude-sonnet-4-6') returns true.
    // On a run where a prior session transcript exists, countLines IS called.
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const src = readFileSync(
      resolve(__dirname, "../executor/profiles.ts"),
      "utf8",
    );
    const triageStart = src.indexOf("triage:");
    expect(triageStart).toBeGreaterThan(-1);
    const triageBlock = src.slice(triageStart, triageStart + 200);
    // Triage uses DEFAULT_MODEL (claude-sonnet), not HAIKU_MODEL
    expect(triageBlock).toContain("DEFAULT_MODEL");
    expect(triageBlock).not.toContain("HAIKU_MODEL");
  });
});

// ---------------------------------------------------------------------------
// Section 3: AC test confirmed added — regression guard
// ---------------------------------------------------------------------------

describe("BEC-249 AC delivered: functional executeStage triage stall test exists in BEC-183 file", () => {
  it("bec-183-pre-stream-stall.test.ts now imports executeStage and tests stage:'triage'", () => {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const bec183Src = readFileSync(
      resolve(__dirname, "./bec-183-pre-stream-stall.test.ts"),
      "utf8",
    );

    // The BEC-183 file still covers consumeAgentStream and firstMessageTimeoutMs
    expect(bec183Src).toContain("consumeAgentStream");
    expect(bec183Src).toContain("firstMessageTimeoutMs");

    // The AC test has been added: executeStage is now imported and called
    expect(bec183Src).toContain("import { executeStage }");
    expect(bec183Src).toContain("executeStage(");

    // The AC test specifically targets the triage stage
    expect(bec183Src).toContain("stage: \"triage\"");
  });
});
