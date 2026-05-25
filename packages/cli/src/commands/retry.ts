/**
 * `ura retry` — re-queue a failed or retriable pipeline run via the
 * running urateam container's /cli/* HTTP endpoint.
 *
 * Auth: the CLI passes `X-Ura-Cli-Token: $URATEAM_CLI_TOKEN`; the server's
 * `/cli/*` routes 404 when the env var is unset and 403 on token mismatch.
 * Audit events record the OS user from `os.userInfo().username` as the
 * actor.
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

export const retryCommand = new Command("retry")
  .description(
    "Re-queue a failed or retriable pipeline run. Talks to the running urateam container via its /cli/runs/:id/retry endpoint.",
  )
  .argument("<run-id>", "Pipeline run id (UUID) to retry")
  .option(
    "--url <url>",
    "Dashboard URL (default: $URATEAM_DASHBOARD_URL or http://localhost:3001)",
  )
  .action(async (runId: string, opts: { url?: string }) => {
    const base = resolveDashboardUrl(opts.url);
    const token = resolveToken();
    const url = `${base}/cli/runs/${encodeURIComponent(runId)}/retry`;

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
    console.log(`Retry queued for run ${runId}.`);
  });
