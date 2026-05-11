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
// isClaudeAuthValid — session-lifetime gate for the mounted-session path
// ---------------------------------------------------------------------------

/**
 * Validates Claude auth credentials by running `claude auth status`.
 * Results are cached for 5 minutes to avoid hammering the CLI on every call.
 * Uses a single-flight pattern so concurrent callers share one subprocess.
 * Returns true if auth is valid, false otherwise.
 *
 * **Short-circuits to true when CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY
 * is present** — those paths have no session-lifetime semantics and the
 * subprocess check is unnecessary (and would be incorrect if no local
 * `claude` CLI is installed).
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
      await new Promise<void>((resolve, reject) => {
        execFile("claude", ["auth", "status"], { timeout: 10_000 }, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      lastCheckResult = true;
      log.debug("Claude auth check passed");
    } catch {
      lastCheckResult = false;
      log.error("Claude auth check failed — credentials may be expired. Run: claude login");
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
