/**
 * Tier 1b — typecheck gate.
 *
 * Runs the project's idiomatic typecheck command inside the worktree before
 * push. On failure, the runner surfaces a `category: "typecheck"` blocking
 * `ReviewFinding` and emits a `pipeline.typecheck_failed` audit event. The
 * existing draft-PR renderer picks up the finding and surfaces the first 5
 * messages in the PR body.
 *
 * Escape hatch: `URATEAM_DISABLE_TYPECHECK_GATE=true`. Documented in CLAUDE.md.
 *
 * The gate is unit-tested via a runner DI hook (`TypecheckRunner`) so the test
 * suite doesn't need a real `pnpm` / `tsc` install. The real default uses
 * `execFile` per repo convention.
 */
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFileCb);

/**
 * DI seam: the function that actually invokes the typecheck command. Tests
 * inject a synthetic version; the runner imports and uses the real one (via
 * the default in `runTypecheck`'s opts).
 */
export type TypecheckRunner = (
  command: string[],
  cwd: string,
  timeoutMs: number,
) => Promise<{ stdout: string; stderr: string; code: number }>;

export interface TypecheckResult {
  /** True when typecheck exited 0. */
  passed: boolean;
  /** Number of lines matching a TypeScript error signature (`error TSnnnn`).
   *  Zero when the command failed for a non-typecheck reason (e.g. missing
   *  binary); the caller distinguishes by also reading `passed` and `output`. */
  errorCount: number;
  /** Up to 5 error lines, each truncated at 500 chars with a trailing `…`. */
  firstMessages: string[];
  /** Full combined stdout + stderr, capped at 50 KB with a `(truncated)`
   *  sentinel when oversize. Goes into the PR-body excerpt; the audit payload
   *  uses `firstMessages` to stay bounded. */
  output: string;
  /** True when `URATEAM_DISABLE_TYPECHECK_GATE=true` short-circuited the gate.
   *  In that case the rest of the fields are zero/empty; treat as "skip, don't
   *  block". */
  skipped: boolean;
}

const TS_ERROR_REGEX = /\berror TS\d+\b/;

function parseFirstMessages(combinedOutput: string): {
  errorCount: number;
  firstMessages: string[];
} {
  const errorLines = combinedOutput
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => TS_ERROR_REGEX.test(l));

  const firstMessages = errorLines.slice(0, 5).map((l) =>
    l.length > 500 ? l.slice(0, 500) + "…" : l,
  );

  return { errorCount: errorLines.length, firstMessages };
}

function truncateOutput(combined: string, limit = 50_000): string {
  if (combined.length <= limit) return combined;
  return combined.slice(0, limit) + "\n…(truncated)";
}

/**
 * Default runner: invokes the typecheck command via `execFile`. Captures both
 * stdout and stderr and returns the exit code (0 = pass, anything else = fail).
 */
const defaultRunner: TypecheckRunner = async (command, cwd, timeoutMs) => {
  try {
    const { stdout, stderr } = await execFileAsync(command[0]!, command.slice(1), {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 100 * 1024 * 1024, // 100 MB — typecheck output is bounded but not tiny
    });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as {
      stdout?: string;
      stderr?: string;
      code?: number | string;
      message?: string;
    };
    const code = typeof e.code === "number" ? e.code : 1;
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? e.message ?? "",
      code,
    };
  }
};

export async function runTypecheck(
  worktreePath: string,
  opts?: {
    command?: string[];
    timeoutMs?: number;
    runner?: TypecheckRunner;
  },
): Promise<TypecheckResult> {
  if (process.env.URATEAM_DISABLE_TYPECHECK_GATE === "true") {
    return {
      passed: true,
      errorCount: 0,
      firstMessages: [],
      output: "",
      skipped: true,
    };
  }

  const command = opts?.command ?? ["pnpm", "-w", "typecheck"];
  const timeoutMs = opts?.timeoutMs ?? 5 * 60 * 1000;
  const runner = opts?.runner ?? defaultRunner;

  const { stdout, stderr, code } = await runner(command, worktreePath, timeoutMs);
  const combined = `${stderr}\n${stdout}`.trim();

  if (code === 0) {
    return {
      passed: true,
      errorCount: 0,
      firstMessages: [],
      output: "",
      skipped: false,
    };
  }

  const { errorCount, firstMessages } = parseFirstMessages(combined);
  return {
    passed: false,
    errorCount,
    firstMessages,
    output: truncateOutput(combined),
    skipped: false,
  };
}
