import { execFile } from "node:child_process";
import { createLogger } from "../logger.js";

const log = createLogger({ component: "AuthCheck" });

let lastCheckTime = 0;
let lastCheckResult = false;
let inflightCheck: Promise<boolean> | null = null;
const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// resolveClaudeAuth — auth-method resolution (BEC-207)
// ---------------------------------------------------------------------------

/**
 * The resolved Claude authentication method.
 * Precedence: CLAUDE_CODE_OAUTH_TOKEN → ANTHROPIC_API_KEY → mounted session.
 *
 * Deliberately does NOT surface the raw token value: the Agent SDK reads
 * CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY from `process.env` directly,
 * so callers never need it. Returning the credential value here would make
 * it easy for a future caller to accidentally serialise the whole struct
 * into a log line and leak the token (pino, console, audit payloads, etc.).
 */
export interface ClaudeAuthCredentials {
  /**
   * Which auth path was selected:
   *  - "oauth-token" — CLAUDE_CODE_OAUTH_TOKEN env var is present (long-lived
   *    programmatic token produced by `claude setup-token`, bills against
   *    Pro/Max subscription, no weekly expiry)
   *  - "api-key"     — ANTHROPIC_API_KEY env var is present (pay-per-token,
   *    no expiry)
   *  - "session"     — neither env var is set; falls back to the locally
   *    mounted `claude login` session (~/.config/claude/), which expires ~weekly
   */
  method: "oauth-token" | "api-key" | "session";
}

/**
 * Resolve which Claude auth method is active based on environment variables.
 * Implements the precedence order documented in deploy/CLAUDE_AUTH.md:
 *   1. CLAUDE_CODE_OAUTH_TOKEN (long-lived, subscription-billed)
 *   2. ANTHROPIC_API_KEY       (long-lived, pay-per-token)
 *   3. Local CLI session       (mounted credentials, ~weekly expiry)
 *
 * Call this once per executeStage invocation so the auth method is logged
 * alongside the stage, run-id, and issue-id fields for observability.
 */
export function resolveClaudeAuth(): ClaudeAuthCredentials {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    return { method: "oauth-token" };
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return { method: "api-key" };
  }
  return { method: "session" };
}

// ---------------------------------------------------------------------------
// probeClaudeAuth — real API-call probe (BEC-244)
// ---------------------------------------------------------------------------

export type ProbeResult = { valid: true } | { valid: false; reason: "auth" };

/** Auth-related patterns in claude CLI stderr that indicate a 401 from the Anthropic API. */
const AUTH_ERROR_PATTERNS = [
  "401",
  "authentication",
  "unauthorized",
  "invalid api key",
  "invalid x-api-key",
  "credentials",
] as const;

/**
 * Probes Claude API validity by running `claude -p "ok"` — a minimal headless
 * prompt that exercises the credential against the Anthropic API.
 *
 * - Success (exit 0) → `{ valid: true }`
 * - 401 / auth error (stderr contains auth patterns) → `{ valid: false, reason: "auth" }`
 * - Network error, timeout, or command-not-found → `{ valid: true }` (fail-open;
 *   do not page operators on transient noise)
 *
 * Probe stdout and stderr are never logged — only the pass/fail classification
 * is recorded to avoid leaking token values.
 */
export async function probeClaudeAuth(timeoutMs: number): Promise<ProbeResult> {
  return new Promise<ProbeResult>((resolve) => {
    execFile("claude", ["-p", "ok"], { timeout: timeoutMs }, (err, _stdout, stderr) => {
      if (!err) {
        resolve({ valid: true });
        return;
      }
      // Killed by timeout or any non-subprocess error (ENOENT, ECONNREFUSED, etc.) → fail-open.
      if (err.killed || (err as NodeJS.ErrnoException).code === "ENOENT") {
        resolve({ valid: true });
        return;
      }
      // Classify by stderr content — auth errors contain recognisable patterns.
      const stderrLower = (stderr ?? "").toLowerCase();
      const isAuthError = AUTH_ERROR_PATTERNS.some((p) => stderrLower.includes(p));
      resolve(isAuthError ? { valid: false, reason: "auth" } : { valid: true });
    });
  });
}

// ---------------------------------------------------------------------------
// isClaudeAuthValid — session-lifetime gate for the mounted-session path
// ---------------------------------------------------------------------------

/**
 * Validates Claude auth credentials by running a real API probe (`claude -p "ok"`).
 * Results are cached for 5 minutes to avoid hammering the API on every call.
 * Uses a single-flight pattern so concurrent callers share one subprocess.
 * Returns true if auth is valid, false otherwise.
 *
 * **Short-circuits to true when CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY
 * is present** — those paths have no session-lifetime semantics and the
 * subprocess check is unnecessary (and would be incorrect if no local
 * `claude` CLI is installed). The AuthMonitor (`auth-monitor.ts`) handles
 * periodic validation for those paths separately.
 *
 * Network errors and timeouts return true (fail-open) — only a confirmed
 * 401 / auth error returns false.
 */
export async function isClaudeAuthValid(): Promise<boolean> {
  // Long-lived token paths — no session-lifetime semantics, always valid.
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY) {
    return true;
  }

  const now = Date.now();
  if (now - lastCheckTime < CHECK_INTERVAL_MS) {
    return lastCheckResult;
  }

  // Single-flight: if a check is already in progress, share its result.
  if (inflightCheck) return inflightCheck;

  inflightCheck = (async () => {
    try {
      const result = await probeClaudeAuth(10_000);
      lastCheckResult = result.valid;
      if (result.valid) {
        log.debug("Claude auth check passed");
      } else {
        log.error("Claude auth check failed — credentials may be expired. Run: claude login");
      }
    } catch {
      // probeClaudeAuth should not throw, but fail-open if it does
      lastCheckResult = true;
    } finally {
      lastCheckTime = Date.now();
      inflightCheck = null;
    }
    return lastCheckResult;
  })();

  return inflightCheck;
}

/** Reset the cached auth check (e.g., after a refresh attempt). */
export function resetAuthCheckCache(): void {
  lastCheckTime = 0;
  lastCheckResult = false;
}
