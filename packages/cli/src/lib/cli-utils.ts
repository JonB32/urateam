/**
 * Shared helpers for CLI commands that communicate with the dashboard's
 * /cli/* endpoints via HTTP. Extracted here so control.ts, tick.ts, and
 * any future CLI commands don't repeat the same boilerplate.
 */
import * as os from "node:os";

export function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

export function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export function resolveDashboardUrl(override?: string): string {
  const raw =
    override ??
    process.env.URATEAM_DASHBOARD_URL ??
    "http://localhost:3001";
  return stripTrailingSlash(raw);
}

export function resolveToken(): string {
  const token = process.env.URATEAM_CLI_TOKEN;
  if (!token) {
    fail(
      "URATEAM_CLI_TOKEN is not set. Set it in the same environment as the " +
        "urateam container (matches `URATEAM_CLI_TOKEN` in .env) and re-run.",
    );
  }
  return token;
}

export function actor(): string {
  try {
    return os.userInfo().username;
  } catch {
    return "unknown";
  }
}
