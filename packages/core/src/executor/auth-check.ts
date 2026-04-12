import { execFile } from "node:child_process";
import { createLogger } from "../logger.js";

const log = createLogger({ component: "AuthCheck" });

let lastCheckTime = 0;
let lastCheckResult = false;
let inflightCheck: Promise<boolean> | null = null;
const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Validates Claude auth credentials by running `claude auth status`.
 * Results are cached for 5 minutes to avoid hammering the CLI on every call.
 * Uses a single-flight pattern so concurrent callers share one subprocess.
 * Returns true if auth is valid, false otherwise.
 */
export async function isClaudeAuthValid(): Promise<boolean> {
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
