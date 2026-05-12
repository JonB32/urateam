/**
 * Tier 1b — typecheck gate.
 *
 * `runTypecheck` runs the project's idiomatic typecheck command inside the
 * worktree and reports pass/fail with a structured payload (errorCount, first
 * 5 messages, raw output). The runner consumes the result, surfaces a
 * `category: "typecheck"` blocking review finding on failure, and emits a
 * `pipeline.typecheck_failed` audit event.
 *
 * The function takes a `runner` DI hook so the unit tests don't require a
 * real `pnpm` / `tsc` install; the real default uses `execFile` per repo
 * convention (CLAUDE.md: "Use `execFile` (never `exec`) for shell commands").
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runTypecheck, type TypecheckRunner } from "../pipeline/typecheck-gate.js";

const ENV_KEY = "URATEAM_DISABLE_TYPECHECK_GATE";

describe("runTypecheck — fires on type errors", () => {
  beforeEach(() => {
    delete process.env[ENV_KEY];
  });
  afterEach(() => {
    delete process.env[ENV_KEY];
  });

  it("parses TS errors from stdout when the command exits non-zero", async () => {
    const tscOutput = [
      "src/foo.ts:42:5 - error TS2322: Type 'number' is not assignable to type 'string'.",
      "",
      "src/bar.ts:7:1 - error TS2304: Cannot find name 'undefinedVar'.",
      "",
      "Found 2 errors in 2 files.",
    ].join("\n");
    const runner: TypecheckRunner = async () => ({
      stdout: tscOutput,
      stderr: "",
      code: 1,
    });

    const result = await runTypecheck("/fake/worktree", { runner });

    expect(result.passed).toBe(false);
    expect(result.skipped).toBe(false);
    expect(result.errorCount).toBe(2);
    expect(result.firstMessages).toHaveLength(2);
    expect(result.firstMessages[0]).toContain("TS2322");
    expect(result.firstMessages[1]).toContain("TS2304");
  });

  it("parses TS errors from stderr too (tsc emits to both)", async () => {
    const runner: TypecheckRunner = async () => ({
      stdout: "",
      stderr: "src/x.ts:1:1 - error TS2304: Cannot find name 'foo'.",
      code: 1,
    });

    const result = await runTypecheck("/fake/worktree", { runner });

    expect(result.passed).toBe(false);
    expect(result.errorCount).toBe(1);
    expect(result.firstMessages[0]).toContain("TS2304");
  });

  it("caps firstMessages at 5 even when there are more errors", async () => {
    const tscOutput = Array.from({ length: 10 }, (_, i) =>
      `src/f${i}.ts:1:1 - error TS2322: synthetic error ${i}.`,
    ).join("\n");
    const runner: TypecheckRunner = async () => ({
      stdout: tscOutput,
      stderr: "",
      code: 1,
    });

    const result = await runTypecheck("/fake/worktree", { runner });

    expect(result.errorCount).toBe(10);
    expect(result.firstMessages).toHaveLength(5);
  });

  it("truncates individual messages over 500 chars", async () => {
    const longMessage =
      "src/long.ts:1:1 - error TS2322: " + "x".repeat(1000);
    const runner: TypecheckRunner = async () => ({
      stdout: longMessage,
      stderr: "",
      code: 1,
    });

    const result = await runTypecheck("/fake/worktree", { runner });

    expect(result.firstMessages[0]!.length).toBeLessThanOrEqual(501);
    expect(result.firstMessages[0]).toMatch(/…$/);
  });

  it("truncates the full output above 50KB and marks it (so audit payload is bounded)", async () => {
    const oversized = "src/x.ts:1:1 - error TS2322: a\n".repeat(2500); // ~80KB
    const runner: TypecheckRunner = async () => ({
      stdout: oversized,
      stderr: "",
      code: 1,
    });

    const result = await runTypecheck("/fake/worktree", { runner });

    expect(result.passed).toBe(false);
    expect(result.output.length).toBeLessThanOrEqual(50_100); // sentinel + small margin
    expect(result.output).toContain("(truncated)");
  });

  it("treats non-zero exit with no parseable TS errors as failed with errorCount=0", async () => {
    // Edge case: typecheck command itself crashed (e.g., tsc missing) — fail
    // closed so the operator sees something, but with a clear "not typecheck"
    // signal in errorCount=0.
    const runner: TypecheckRunner = async () => ({
      stdout: "",
      stderr: "Cannot find module 'typescript'",
      code: 127,
    });

    const result = await runTypecheck("/fake/worktree", { runner });

    expect(result.passed).toBe(false);
    expect(result.errorCount).toBe(0);
    expect(result.output).toContain("Cannot find module");
  });
});

describe("runTypecheck — does NOT fire on a clean repo", () => {
  beforeEach(() => {
    delete process.env[ENV_KEY];
  });
  afterEach(() => {
    delete process.env[ENV_KEY];
  });

  it("returns passed=true when the runner exits 0", async () => {
    const runner: TypecheckRunner = async () => ({
      stdout: "",
      stderr: "",
      code: 0,
    });

    const result = await runTypecheck("/fake/worktree", { runner });

    expect(result).toEqual({
      passed: true,
      errorCount: 0,
      firstMessages: [],
      output: "",
      skipped: false,
    });
  });

  it("passes the default command (`pnpm -w typecheck`) to the runner", async () => {
    let observedCommand: string[] | undefined;
    const runner: TypecheckRunner = async (cmd) => {
      observedCommand = cmd;
      return { stdout: "", stderr: "", code: 0 };
    };

    await runTypecheck("/fake/worktree", { runner });

    expect(observedCommand).toEqual(["pnpm", "-w", "typecheck"]);
  });

  it("respects a custom command via opts.command", async () => {
    let observedCommand: string[] | undefined;
    const runner: TypecheckRunner = async (cmd) => {
      observedCommand = cmd;
      return { stdout: "", stderr: "", code: 0 };
    };

    await runTypecheck("/fake/worktree", {
      runner,
      command: ["yarn", "typecheck"],
    });

    expect(observedCommand).toEqual(["yarn", "typecheck"]);
  });
});

describe("runTypecheck — escape hatch", () => {
  beforeEach(() => {
    delete process.env[ENV_KEY];
  });
  afterEach(() => {
    delete process.env[ENV_KEY];
  });

  it("when URATEAM_DISABLE_TYPECHECK_GATE=true, returns skipped=true and does NOT invoke the runner", async () => {
    process.env[ENV_KEY] = "true";
    let runnerInvoked = false;
    const runner: TypecheckRunner = async () => {
      runnerInvoked = true;
      return { stdout: "", stderr: "", code: 0 };
    };

    const result = await runTypecheck("/fake/worktree", { runner });

    expect(runnerInvoked).toBe(false);
    expect(result).toEqual({
      passed: true,
      errorCount: 0,
      firstMessages: [],
      output: "",
      skipped: true,
    });
  });

  it("when URATEAM_DISABLE_TYPECHECK_GATE is unset, runner IS invoked", async () => {
    let runnerInvoked = false;
    const runner: TypecheckRunner = async () => {
      runnerInvoked = true;
      return { stdout: "", stderr: "", code: 0 };
    };

    await runTypecheck("/fake/worktree", { runner });

    expect(runnerInvoked).toBe(true);
  });

  it("env-var values other than 'true' do NOT disable the gate (false, 0, '', undefined)", async () => {
    for (const value of ["false", "0", "", "1", "yes"]) {
      process.env[ENV_KEY] = value;
      let runnerInvoked = false;
      const runner: TypecheckRunner = async () => {
        runnerInvoked = true;
        return { stdout: "", stderr: "", code: 0 };
      };
      const result = await runTypecheck("/fake/worktree", { runner });
      expect(runnerInvoked, `env=${value}`).toBe(true);
      expect(result.skipped, `env=${value}`).toBe(false);
    }
  });
});
