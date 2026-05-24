/**
 * BEC-249 Reproduction: stall guards don't fire for the triage stage.
 *
 * ## Root cause (confirmed by this file)
 *
 * In `executor.ts`, the sequence inside the `try` block is:
 *
 *   line 264:  const sessionOpts = await resolveSessionOpts({...});  // can hang
 *   line 327:  const stageTimeoutPromise = new Promise<never>(...    // wall-clock timer
 *   line 333:  await Promise.race([consumeAgentStream(...), stageTimeoutPromise]);
 *
 * `resolveSessionOpts` (session-resolver.ts) calls `countLines()` — a
 * `createReadStream`-backed line counter — when a session transcript file
 * exists.  `createReadStream` hangs indefinitely on an unresponsive Docker
 * volume (e.g. `urateam-dogfood-agent-sessions` under I/O pressure during
 * the BEC-236 container restart soak).
 *
 * Because `stageTimeoutPromise` is NOT registered until `resolveSessionOpts`
 * returns, neither the 5-min `firstMessageTimeoutMs` guard nor the 30-min
 * `WALL_CLOCK_STAGE_TIMEOUT_MS` guard ever fires.  The stage stays in
 * `status='running'` indefinitely.
 *
 * ## Evidence
 *
 * Section 1 ("gap confirmed"): mocks `resolveSessionOpts` to never resolve,
 * advances fake time 35 min past the wall-clock threshold, verifies the
 * `stagePromise` is still pending and `stage_runs.status` is still "running".
 *
 * Section 2 ("static ordering proof"): reads executor.ts source and asserts
 * the `resolveSessionOpts` await appears BEFORE the `stageTimeoutPromise`
 * assignment — the structural cause of the gap.  This test is independent of
 * fake-timer mechanics and will detect any regression.
 *
 * Section 3 ("AC gap — missing test"): documents that no test currently
 * invokes `executeStage` for the triage stage and asserts a timeout fires
 * (the AC asks for exactly this test to be added as part of the fix).
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

describe("BEC-249 gap confirmed: pre-flight hang leaves stage stuck indefinitely", () => {
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
    "stage_runs.status stays 'running' after advancing 35 min past WALL_CLOCK_STAGE_TIMEOUT_MS when pre-flight hangs",
    async () => {
      // Simulate unresponsive Docker volume: resolveSessionOpts never returns.
      const { resolveSessionOpts } = await import("../executor/session-resolver.js");
      (resolveSessionOpts as ReturnType<typeof vi.fn>).mockImplementation(
        () => new Promise<never>(() => {}),
      );

      const { query } = await import("@anthropic-ai/claude-agent-sdk");
      (query as ReturnType<typeof vi.fn>).mockImplementation(
        () => (async function* () { await new Promise<never>(() => {}); })(),
      );

      await seedPipelineRun(db, "run-bec249-gap");

      // Start the stage — it will reach `await resolveSessionOpts()` and park.
      const stagePromise = executeStage({
        runId: "run-bec249-gap",
        issueId: testIssue.id,
        stage: "triage",
        sanitizedIssue: testIssue,
        repoConfig: testRepoConfig,
        workdir: "/tmp/repro",
        db,
        agentSessionId: null,
      });

      // Advance fake time well past WALL_CLOCK_STAGE_TIMEOUT_MS (30 min).
      // If the stageTimeoutPromise were set up BEFORE resolveSessionOpts,
      // it would have fired and stagePromise would resolve.
      await vi.advanceTimersByTimeAsync(35 * 60_000);

      // stagePromise is still pending — wall-clock timer was never registered.
      let settled = false;
      void stagePromise.then(() => { settled = true; }).catch(() => { settled = true; });
      // One microtask flush to catch any already-resolved promise.
      await Promise.resolve();

      expect(settled).toBe(false); // BUG: stage hangs indefinitely

      // DB still shows the running status — no failure was recorded.
      const rows = await (db as any)
        .select()
        .from(stageRuns)
        .where(eq(stageRuns.pipelineRunId, "run-bec249-gap"));

      // stage_runs row exists with status='running' (should be 'failed' if
      // the wall-clock guard had fired as intended).
      expect(rows.length).toBe(1);
      expect(rows[0].status).toBe("running");
      expect(rows[0].errorMessage).toBeNull();
    },
    5_000,
  );
});

// ---------------------------------------------------------------------------
// Section 2: Static ordering proof — the structural gap in executor.ts
// ---------------------------------------------------------------------------

describe("BEC-249 structural gap: resolveSessionOpts awaited BEFORE stageTimeoutPromise is created", () => {
  it("executor.ts awaits resolveSessionOpts on a lower line than stageTimeoutPromise setup", () => {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const executorSrc = readFileSync(
      resolve(__dirname, "../executor/executor.ts"),
      "utf8",
    );
    const lines = executorSrc.split("\n");

    // Find the first line that awaits resolveSessionOpts
    const resolveSessionOptsLine = lines.findIndex((l) =>
      l.includes("await resolveSessionOpts("),
    );

    // Find the first line that creates stageTimeoutPromise
    const stageTimeoutPromiseLine = lines.findIndex((l) =>
      l.includes("stageTimeoutPromise") && l.includes("new Promise"),
    );

    expect(resolveSessionOptsLine).toBeGreaterThan(-1);
    expect(stageTimeoutPromiseLine).toBeGreaterThan(-1);

    // THE GAP: resolveSessionOpts is awaited BEFORE the wall-clock timer
    // is registered.  If it hangs, neither stall guard fires.
    expect(resolveSessionOptsLine).toBeLessThan(stageTimeoutPromiseLine);
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
// Section 3: Missing test gap — the AC test does not yet exist
// ---------------------------------------------------------------------------

describe("BEC-249 AC gap: no functional test exists for triage stage stall via executeStage", () => {
  it("the existing BEC-183 stall tests only cover consumeAgentStream directly + static analysis, not executeStage triage path", () => {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const bec183Src = readFileSync(
      resolve(__dirname, "./bec-183-pre-stream-stall.test.ts"),
      "utf8",
    );

    // Confirm: the existing BEC-183 test file imports consumeAgentStream directly
    expect(bec183Src).toContain("consumeAgentStream");
    expect(bec183Src).toContain("firstMessageTimeoutMs");

    // Confirm: the existing file does NOT import or call executeStage
    expect(bec183Src).not.toContain("import { executeStage }");
    expect(bec183Src).not.toContain("executeStage(");

    // Confirm: the existing file does NOT test stage:'triage' specifically
    expect(bec183Src).not.toContain("stage: \"triage\"");
    expect(bec183Src).not.toContain("stage:'triage'");

    // The AC requires adding: executeStage({ stage:'triage', ... }) +
    // neverYields SDK mock + assert StagePreStreamStalledError within
    // firstMessageTimeoutMs.  That test does not yet exist.
  });
});
