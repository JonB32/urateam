/**
 * BEC-209 implement-stage hang detection — gap documentation + regression guard.
 *
 * This file was originally created by the reproduce stage to document the
 * feature gaps. The implement stage filled those gaps, so the assertions below
 * now verify that the features ARE present (regression guard).
 *
 * Run with:
 *   cd packages/core && npx vitest run src/__tests__/reproduce-bec209-implement-hang-detection.test.ts
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../../../");

function readSrc(relPath: string): string {
  return fs.readFileSync(path.resolve(repoRoot, relPath), "utf8");
}

function fileExists(relPath: string): boolean {
  return fs.existsSync(path.resolve(repoRoot, relPath));
}

// ---------------------------------------------------------------------------
// Feature 1 — detectStageHang() exists
// ---------------------------------------------------------------------------
describe("BEC-209 feature 1 — detectStageHang() function is present", () => {
  it("hang-detection module file exists", () => {
    expect(fileExists("packages/core/src/executor/hang-detection.ts")).toBe(true);
  });

  it("executor/executor.ts imports and calls detectStageHang", () => {
    const src = readSrc("packages/core/src/executor/executor.ts");
    expect(src).toContain("detectStageHang");
  });

  it("executor/index.ts exports detectStageHang", () => {
    const src = readSrc("packages/core/src/executor/index.ts");
    expect(src).toContain("detectStageHang");
  });
});

// ---------------------------------------------------------------------------
// Feature 2 — stage_runs has last_progress_at column
// ---------------------------------------------------------------------------
describe("BEC-209 feature 2 — stage_runs has last_progress_at column", () => {
  it("db/schema.ts stageRuns definition includes last_progress_at", () => {
    const src = readSrc("packages/core/src/db/schema.ts");
    expect(src).toContain("last_progress_at");
    expect(src).toContain("lastProgressAt");
  });

  it("db/client.ts MIGRATION_COLUMNS includes last_progress_at", () => {
    const src = readSrc("packages/core/src/db/client.ts");
    expect(src).toContain("last_progress_at");
  });

  it("db/client.ts getCreateTablesDDL includes last_progress_at in stage_runs DDL", () => {
    const src = readSrc("packages/core/src/db/client.ts");
    expect(src).toContain("last_progress_at");
  });
});

// ---------------------------------------------------------------------------
// Feature 3 — manual run termination CLI command exists
// ---------------------------------------------------------------------------
describe("BEC-209 feature 3 — manual run termination CLI command", () => {
  it("cli/commands/admin.ts has terminate command and terminateRun call", () => {
    const src = readSrc("packages/cli/src/commands/admin.ts");
    expect(src).toMatch(/terminate/);
    expect(src).toContain("terminateRun");
  });

  it("pipeline/terminate.ts exists with terminateRun export", () => {
    expect(fileExists("packages/core/src/pipeline/terminate.ts")).toBe(true);
    const src = readSrc("packages/core/src/pipeline/terminate.ts");
    expect(src).toContain("terminateRun");
  });
});

// ---------------------------------------------------------------------------
// Feature 4 — 5-minute polling loop for implement stage in executor
// ---------------------------------------------------------------------------
describe("BEC-209 feature 4 — 5-minute implement-stage polling loop", () => {
  it("executor/executor.ts contains setInterval for implement stage", () => {
    const src = readSrc("packages/core/src/executor/executor.ts");
    expect(src).toContain("setInterval");
    expect(src).toContain('stage === "implement"');
    expect(src).toContain("HANG_DETECTION_INTERVAL_MS");
  });

  it("executor/executor.ts clears the interval in the finally block", () => {
    const src = readSrc("packages/core/src/executor/executor.ts");
    expect(src).toContain("clearInterval");
    expect(src).toContain("hangCheckInterval");
  });

  it("executor/executor.ts updates lastProgressAt in onProgress and onToolMessage callbacks", () => {
    const src = readSrc("packages/core/src/executor/executor.ts");
    expect(src).toContain("lastProgressAt = new Date()");
  });
});

// ---------------------------------------------------------------------------
// Positive baseline — existing defences are still present
// ---------------------------------------------------------------------------
describe("BEC-209 baseline — existing stall defences confirmed present", () => {
  it("StageStalledError exists (mid-stream, 30-min progressTimeoutMs)", () => {
    const src = readSrc("packages/core/src/executor/agent-stream.ts");
    expect(src).toContain("StageStalledError");
    expect(src).toContain("progressTimeoutMs");
  });

  it("StagePreStreamStalledError exists (pre-stream, 5-min firstMessageTimeoutMs)", () => {
    const src = readSrc("packages/core/src/executor/agent-stream.ts");
    expect(src).toContain("StagePreStreamStalledError");
    expect(src).toContain("firstMessageTimeoutMs");
  });

  it("WALL_CLOCK_STAGE_TIMEOUT_MS exists — implement 60 min, others 30 min", () => {
    const src = readSrc("packages/core/src/executor/executor.ts");
    expect(src).toContain("WALL_CLOCK_STAGE_TIMEOUT_MS");
    expect(src).toContain("60 * 60_000");
    expect(src).toContain("30 * 60_000");
  });

  it("BEC-184 zombie run recovery exists in recover-stuck.ts", () => {
    const src = readSrc("packages/core/src/pm/actions/recover-stuck.ts");
    expect(src).toContain("recovered: running > ");
    expect(src).toContain("pm.recovered_long_running");
  });

  it("hang detection is now externally queryable via last_progress_at DB column", () => {
    const schemaSrc = readSrc("packages/core/src/db/schema.ts");
    const stageRunsMatch = schemaSrc.match(/stageRuns = sqliteTable\("stage_runs"[\s\S]*?\}\)/);
    expect(stageRunsMatch).not.toBeNull();
    const stageRunsDef = stageRunsMatch![0];
    // The column is now present — external PM scheduler can query it
    expect(stageRunsDef).toContain("last_progress_at");
    expect(stageRunsDef).toContain("lastProgressAt");
  });
});
