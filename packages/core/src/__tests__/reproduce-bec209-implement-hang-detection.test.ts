/**
 * Reproduction test for BEC-209: implement-stage hang detection feature gap.
 *
 * Run FyGPSITBTB49blnEdTMlX got stuck on the `implement` stage with no
 * progress for 30+ minutes. The Quality Observer filed this as a feature gap:
 * there is no proactive `detectStageHang()` function, no 5-minute polling
 * loop during implement stage execution, and no manual termination CLI command.
 *
 * This test file:
 *  1. Confirms the `detectStageHang` function does NOT exist anywhere in the
 *     executor or PM modules (the feature is absent).
 *  2. Confirms `stage_runs` schema has no `last_progress_at` column needed
 *     for external hang detection without in-process timeouts.
 *  3. Confirms no CLI `terminate` / `abort-run` command exists for manual
 *     termination of a stuck run.
 *  4. Documents the gap: existing timeouts (StageStalledError /
 *     StagePreStreamStalledError / WALL_CLOCK_STAGE_TIMEOUT_MS) are in-process
 *     passive guards — they cannot be queried externally at 5-minute intervals,
 *     and there is no API / CLI to force-terminate before the 60-minute wall
 *     clock fires.
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
// Gap 1 — no detectStageHang() function exists
// ---------------------------------------------------------------------------
describe("BEC-209 gap 1 — detectStageHang() function is absent", () => {
  it("executor/agent-stream.ts does NOT export detectStageHang", () => {
    const src = readSrc("packages/core/src/executor/agent-stream.ts");
    expect(src).not.toContain("detectStageHang");
  });

  it("executor/executor.ts does NOT contain detectStageHang", () => {
    const src = readSrc("packages/core/src/executor/executor.ts");
    expect(src).not.toContain("detectStageHang");
  });

  it("pm/actions/recover-stuck.ts does NOT contain detectStageHang", () => {
    const src = readSrc("packages/core/src/pm/actions/recover-stuck.ts");
    expect(src).not.toContain("detectStageHang");
  });

  it("no hang-detection module file exists", () => {
    // Expected location for the new feature
    expect(fileExists("packages/core/src/executor/hang-detection.ts")).toBe(false);
    expect(fileExists("packages/core/src/pipeline/hang-detection.ts")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Gap 2 — stage_runs schema has no last_progress_at column
// ---------------------------------------------------------------------------
describe("BEC-209 gap 2 — stage_runs has no last_progress_at column", () => {
  it("db/schema.ts stageRuns definition lacks last_progress_at", () => {
    const src = readSrc("packages/core/src/db/schema.ts");
    // Confirm stageRuns table exists
    expect(src).toContain("stage_runs");
    // Confirm the tracking column is absent — needed for external hang polling
    expect(src).not.toContain("last_progress_at");
    expect(src).not.toContain("lastProgressAt");
  });

  it("db/client.ts MIGRATION_COLUMNS does NOT include last_progress_at", () => {
    const src = readSrc("packages/core/src/db/client.ts");
    expect(src).not.toContain("last_progress_at");
  });
});

// ---------------------------------------------------------------------------
// Gap 3 — no manual termination CLI command exists
// ---------------------------------------------------------------------------
describe("BEC-209 gap 3 — no manual run termination CLI command", () => {
  it("cli/commands/admin.ts has no terminate or abort-run command", () => {
    const src = readSrc("packages/cli/src/commands/admin.ts");
    expect(src).not.toMatch(/terminate|abort[-_]run|kill[-_]run|stop[-_]run/i);
  });

  it("cli/commands/run.ts has no terminate or abort-run command", () => {
    const src = readSrc("packages/cli/src/commands/run.ts");
    expect(src).not.toMatch(/terminate|abort[-_]run|kill[-_]run/i);
  });

  it("no cli/commands/terminate.ts file exists", () => {
    expect(fileExists("packages/cli/src/commands/terminate.ts")).toBe(false);
    expect(fileExists("packages/cli/src/commands/abort.ts")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Gap 4 — the 5-minute polling loop for implement stage is absent
// ---------------------------------------------------------------------------
describe("BEC-209 gap 4 — no 5-minute implement-stage polling loop", () => {
  it("pm/scheduler.ts has no implement-stage-specific hang polling", () => {
    const src = readSrc("packages/core/src/pm/scheduler.ts");
    // The scheduler tick does not contain periodic hang-detection for implement
    expect(src).not.toContain("detectStageHang");
    expect(src).not.toContain("hang-detection");
  });

  it("executor/executor.ts 5-minute interval is for onProgress logging only, not external hang detection", () => {
    const src = readSrc("packages/core/src/executor/executor.ts");
    // onProgress callback exists (30-second logging interval) but it is an
    // in-process observer — it does NOT write lastProgressAt to DB or call
    // any detectStageHang function.
    expect(src).toContain("onProgress");
    expect(src).not.toContain("detectStageHang");
    expect(src).not.toContain("last_progress_at");
  });
});

// ---------------------------------------------------------------------------
// Positive baseline — existing defences that ARE present
//   (Documents what already exists so the implementer knows what NOT to redo)
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
    expect(src).toContain("60 * 60_000");  // implement
    expect(src).toContain("30 * 60_000");  // default
  });

  it("BEC-184 zombie run recovery exists in recover-stuck.ts", () => {
    const src = readSrc("packages/core/src/pm/actions/recover-stuck.ts");
    expect(src).toContain("recovered: running > ");
    expect(src).toContain("pm.recovered_long_running");
  });

  it("existing defences are passive/in-process — NOT externally queryable", () => {
    // The key gap: all existing mechanisms require the process to still be alive
    // and running. An external monitor calling detectStageHang(runId, stage, lastUpdateTime)
    // every 5 minutes to check DB state does not exist.
    //
    // Evidence: stage_runs has no lastProgressAt column, so a PM Agent tick
    // cannot determine how long since a running implement stage last made progress.
    const schemaSrc = readSrc("packages/core/src/db/schema.ts");
    const stageRunsMatch = schemaSrc.match(/stageRuns = sqliteTable\("stage_runs"[\s\S]*?\}\)/);
    expect(stageRunsMatch).not.toBeNull();
    const stageRunsDef = stageRunsMatch![0];
    expect(stageRunsDef).not.toContain("last_progress_at");
    expect(stageRunsDef).not.toContain("lastProgressAt");
  });
});
