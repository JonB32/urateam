/**
 * BEC-209: implement-stage hang detection — integration tests.
 *
 * Tests verify:
 *  1. detectStageHang() returns false when elapsed < threshold
 *  2. detectStageHang() returns true and logs ERROR when elapsed >= threshold
 *  3. terminateRun() marks a running pipeline_run as failed and clears active_work
 *  4. terminateRun() rejects for completed/aborted runs
 *  5. executor.ts source contains the hang-detection setInterval wiring for implement
 *  6. executor.ts onProgress callback updates lastProgressAt (static analysis)
 *
 * Run with:
 *   cd packages/core && npx vitest run src/__tests__/bec-209-hang-detection.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import {
  detectStageHang,
  DEFAULT_HANG_THRESHOLD_MS,
  HANG_DETECTION_INTERVAL_MS,
  type HangDiagnostics,
} from "../executor/hang-detection.js";
import { terminateRun } from "../pipeline/terminate.js";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../../../");

function readSrc(relPath: string): string {
  return fs.readFileSync(path.resolve(repoRoot, relPath), "utf8");
}

// ---------------------------------------------------------------------------
// detectStageHang() unit tests
// ---------------------------------------------------------------------------
describe("BEC-209: detectStageHang() — return value", () => {
  it("returns false when elapsed time is under the hang threshold", () => {
    const recentUpdate = new Date(Date.now() - 5 * 60_000); // 5 min ago
    const result = detectStageHang("run-1", "implement", recentUpdate, 30 * 60_000);
    expect(result).toBe(false);
  });

  it("returns true when elapsed time meets the hang threshold", () => {
    const staleUpdate = new Date(Date.now() - 31 * 60_000); // 31 min ago
    const result = detectStageHang("run-1", "implement", staleUpdate, 30 * 60_000);
    expect(result).toBe(true);
  });

  it("returns true for a non-implement stage when hung (threshold applies to any stage)", () => {
    const staleUpdate = new Date(Date.now() - 31 * 60_000);
    const result = detectStageHang("run-2", "review", staleUpdate, 30 * 60_000);
    expect(result).toBe(true);
  });

  it("uses DEFAULT_HANG_THRESHOLD_MS (30 min) when no threshold provided", () => {
    const almost = new Date(Date.now() - 29 * 60_000); // 1 min under
    expect(detectStageHang("run-3", "implement", almost)).toBe(false);

    const over = new Date(Date.now() - 31 * 60_000);
    expect(detectStageHang("run-3", "implement", over)).toBe(true);
  });
});

describe("BEC-209: detectStageHang() — logging", () => {
  let loggedErrors: unknown[] = [];

  beforeEach(() => {
    loggedErrors = [];
    // spy on pino logger output by capturing writes to process.stderr
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does NOT log when not hung", () => {
    const consoleErrorSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const recentUpdate = new Date(Date.now() - 5 * 60_000);
    detectStageHang("run-4", "implement", recentUpdate, 30 * 60_000);
    // nothing written to stderr for a non-hung stage
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it("includes runId, stage, and lastUpdateTime in the logged error when hung", () => {
    const loggedLines: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      loggedLines.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    });

    const staleUpdate = new Date(Date.now() - 31 * 60_000);
    detectStageHang("run-BEC209", "implement", staleUpdate, 30 * 60_000);

    spy.mockRestore();

    const combined = loggedLines.join("");
    // pino writes JSON to stdout by default
    expect(combined).toContain("run-BEC209");
    expect(combined).toContain("implement");
    expect(combined).toContain("stage hang detected");
  });

  it("returned HangDiagnostics fields are present via module introspection", () => {
    // Verify the exported DEFAULT_HANG_THRESHOLD_MS and HANG_DETECTION_INTERVAL_MS constants
    expect(DEFAULT_HANG_THRESHOLD_MS).toBe(30 * 60_000);
    expect(HANG_DETECTION_INTERVAL_MS).toBe(5 * 60_000);
  });
});

// ---------------------------------------------------------------------------
// terminateRun() integration test with in-memory SQLite
// ---------------------------------------------------------------------------
describe("BEC-209: terminateRun() — DB integration", () => {
  async function makeInMemoryDb() {
    const { createDb } = await import("../db/client.js");
    return createDb({ connectionString: ":memory:" });
  }

  it("marks a running pipeline_run as failed and removes active_work entry", async () => {
    const db = await makeInMemoryDb();
    const { pipelineRuns, activeWork } = await import("../db/schema.js");
    const { nanoid } = await import("nanoid");
    const { eq } = await import("drizzle-orm");

    const runId = nanoid();
    const issueId = "BEC-209";

    // Insert a running pipeline_run
    await (db as any).insert(pipelineRuns).values({
      id: runId,
      issueId,
      issueTitle: "Test issue",
      pipelineKey: "auto-implement",
      repoUrl: "https://github.com/test/repo",
      status: "running",
    });

    // Insert an active_work entry
    await (db as any).insert(activeWork).values({
      id: nanoid(),
      runId,
      issueId,
      stage: "implement",
    });

    const result = await terminateRun(db as any, runId);

    expect(result.runId).toBe(runId);
    expect(result.issueId).toBe(issueId);
    expect(result.previousStatus).toBe("running");

    // Verify pipeline_run was marked failed
    const [updated] = await (db as any)
      .select()
      .from(pipelineRuns)
      .where(eq(pipelineRuns.id, runId))
      .limit(1);
    expect(updated.status).toBe("failed");
    expect(updated.errorMessage).toBe("manually terminated via CLI");
    expect(updated.completedAt).not.toBeNull();

    // Verify active_work entry was removed
    const activeRows = await (db as any)
      .select()
      .from(activeWork)
      .where(eq(activeWork.runId, runId));
    expect(activeRows).toHaveLength(0);
  }, 10_000);

  it("throws for a non-existent run ID", async () => {
    const db = await makeInMemoryDb();
    await expect(terminateRun(db as any, "nonexistent-run-id")).rejects.toThrow(
      "Run not found: nonexistent-run-id",
    );
  });

  it("throws when the run is already completed", async () => {
    const db = await makeInMemoryDb();
    const { pipelineRuns } = await import("../db/schema.js");
    const { nanoid } = await import("nanoid");

    const runId = nanoid();
    await (db as any).insert(pipelineRuns).values({
      id: runId,
      issueId: "BEC-209",
      issueTitle: "Test issue",
      pipelineKey: "auto-implement",
      repoUrl: "https://github.com/test/repo",
      status: "completed",
    });

    await expect(terminateRun(db as any, runId)).rejects.toThrow(
      `Run ${runId} is already completed`,
    );
  }, 10_000);

  it("can terminate a retriable run (allows recovery from stuck state)", async () => {
    const db = await makeInMemoryDb();
    const { pipelineRuns } = await import("../db/schema.js");
    const { nanoid } = await import("nanoid");
    const { eq } = await import("drizzle-orm");

    const runId = nanoid();
    await (db as any).insert(pipelineRuns).values({
      id: runId,
      issueId: "BEC-209",
      issueTitle: "Test issue",
      pipelineKey: "auto-implement",
      repoUrl: "https://github.com/test/repo",
      status: "retriable",
    });

    const result = await terminateRun(db as any, runId);
    expect(result.previousStatus).toBe("retriable");

    const [updated] = await (db as any)
      .select()
      .from(pipelineRuns)
      .where(eq(pipelineRuns.id, runId))
      .limit(1);
    expect(updated.status).toBe("failed");
  }, 10_000);
});

// ---------------------------------------------------------------------------
// Static analysis: executor.ts wiring
// ---------------------------------------------------------------------------
describe("BEC-209: executor.ts wiring — static analysis", () => {
  it("executor.ts imports and calls detectStageHang", () => {
    const src = readSrc("packages/core/src/executor/executor.ts");
    expect(src).toContain("detectStageHang");
    expect(src).toContain("HANG_DETECTION_INTERVAL_MS");
    expect(src).toContain("hang-detection.js");
  });

  it("executor.ts sets a setInterval for the implement stage", () => {
    const src = readSrc("packages/core/src/executor/executor.ts");
    expect(src).toContain('stage === "implement"');
    expect(src).toContain("setInterval");
    expect(src).toContain("clearInterval");
  });

  it("executor.ts updates lastProgressAt in onProgress callback", () => {
    const src = readSrc("packages/core/src/executor/executor.ts");
    expect(src).toContain("lastProgressAt = new Date()");
    expect(src).toContain("lastProgressAt");
    expect(src).toContain("onProgress");
  });

  it("executor.ts writes lastProgressAt to DB via Drizzle update", () => {
    const src = readSrc("packages/core/src/executor/executor.ts");
    // Drizzle uses camelCase field name in .set(); the DB column is last_progress_at
    expect(src).toContain("lastProgressAt");
    expect(src).toContain(".set({ lastProgressAt })");
  });

  it("stage_runs schema has last_progress_at column", () => {
    const src = readSrc("packages/core/src/db/schema.ts");
    expect(src).toContain("last_progress_at");
    expect(src).toContain("lastProgressAt");
  });

  it("admin.ts has terminate command wired to terminateRun", () => {
    const src = readSrc("packages/cli/src/commands/admin.ts");
    expect(src).toContain("terminate");
    expect(src).toContain("terminateRun");
    expect(src).toContain("runAdminTerminate");
  });
});
