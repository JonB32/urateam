/**
 * `ura tick` — invoke a PM tick on demand without restarting the container.
 *
 * Useful when an operator wants to force a PM Agent cycle (e.g., after a fix
 * or config change) without waiting for the 30-min cron interval and without
 * the destructive `docker restart` that would cancel in-flight runs.
 *
 * Auth: same X-Ura-Cli-Token + X-Ura-Actor pattern as `ura stop` / `ura halt`.
 * The server awaits the full tick before responding; the CLI prints the
 * elapsed time and any errors that surfaced during the tick.
 */
import { Command } from "commander";
import * as os from "node:os";

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function resolveDashboardUrl(override?: string): string {
  const raw =
    override ??
    process.env.URATEAM_DASHBOARD_URL ??
    "http://localhost:3001";
  return raw.replace(/\/+$/, "");
}

function resolveToken(): string {
  const token = process.env.URATEAM_CLI_TOKEN;
  if (!token) {
    fail(
      "URATEAM_CLI_TOKEN is not set. Set it in the same environment as the " +
        "urateam container (matches `URATEAM_CLI_TOKEN` in .env) and re-run.",
    );
  }
  return token;
}

function actor(): string {
  try {
    return os.userInfo().username;
  } catch {
    return "unknown";
  }
}

export const tickCommand = new Command("tick")
  .description(
    "Invoke a PM Agent tick on demand. The command blocks until the tick completes and prints elapsed time + any errors.",
  )
  .option(
    "--url <url>",
    "Dashboard URL (default: $URATEAM_DASHBOARD_URL or http://localhost:3001)",
  )
  .action(async (opts: { url?: string }) => {
    const base = resolveDashboardUrl(opts.url);
    const token = resolveToken();
    const url = `${base}/cli/pm/tick`;

    let resp: Response;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: {
          "x-ura-cli-token": token,
          "x-ura-actor": actor(),
        },
      });
    } catch (err) {
      fail(
        `Failed to reach ${url}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    const body = await resp.text();
    if (!resp.ok) fail(`HTTP ${resp.status}: ${body}`);

    try {
      const parsed = JSON.parse(body) as {
        triggeredAt: string;
        completedAt: string;
        errors: string[];
      };
      const triggeredMs = new Date(parsed.triggeredAt).getTime();
      const completedMs = new Date(parsed.completedAt).getTime();
      const waitMs = completedMs - triggeredMs;
      console.log(`tick triggered (waitMs=${waitMs}, completedAt=${parsed.completedAt})`);
      if (parsed.errors.length > 0) {
        console.error(`tick completed with ${parsed.errors.length} error(s):`);
        for (const e of parsed.errors) console.error(`  - ${e}`);
      }
    } catch {
      console.log(body);
    }
  });
