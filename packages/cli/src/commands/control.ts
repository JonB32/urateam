/**
 * `ura stop` / `ura halt` — operator emergency controls that talk to a
 * running urateam container via its /cli/* HTTP endpoints.
 *
 * Why HTTP rather than direct DB writes: the stop/halt signal lives in the
 * runner's in-memory map (single-process, BEC-170-style). A separate CLI
 * process can't reach it via DB without a polling layer; HTTP to the live
 * server is simpler and immediate.
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

async function controlPost(
  url: string,
  token: string,
): Promise<{ ok: boolean; status: number; body: string }> {
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
  return { ok: resp.ok, status: resp.status, body };
}

export const stopCommand = new Command("stop")
  .description(
    "Stop a single in-flight pipeline run. Defaults to immediate cancel; pass --graceful to let the current stage finish.",
  )
  .argument("<run-id>", "Pipeline run id (UUID) to stop")
  .option(
    "--graceful",
    "Let the current stage finish, then skip remaining stages. Slower but leaves the worktree consistent.",
    false,
  )
  .option(
    "--url <url>",
    "Dashboard URL (default: $URATEAM_DASHBOARD_URL or http://localhost:3001)",
  )
  .action(
    async (
      runId: string,
      opts: { graceful?: boolean; url?: string },
    ) => {
      const base = resolveDashboardUrl(opts.url);
      const token = resolveToken();
      const path = opts.graceful ? "stop" : "cancel";
      const url = `${base}/cli/runs/${encodeURIComponent(runId)}/${path}`;
      const { ok, status, body } = await controlPost(url, token);
      if (!ok) fail(`HTTP ${status}: ${body}`);
      console.log(
        opts.graceful
          ? `Graceful stop requested for run ${runId}.`
          : `Cancel signal sent to run ${runId}. The active stage will abort within a few seconds.`,
      );
    },
  );

export const haltCommand = new Command("halt")
  .description(
    "Halt the entire container: pause the PM Agent (no new runs) AND cancel every in-flight pipeline. Reversible via Slack `/pm resume`.",
  )
  .option(
    "--url <url>",
    "Dashboard URL (default: $URATEAM_DASHBOARD_URL or http://localhost:3001)",
  )
  .action(async (opts: { url?: string }) => {
    const base = resolveDashboardUrl(opts.url);
    const token = resolveToken();
    const { ok, status, body } = await controlPost(
      `${base}/cli/halt-all`,
      token,
    );
    if (!ok) fail(`HTTP ${status}: ${body}`);
    try {
      const parsed = JSON.parse(body) as { cancelledRunIds: string[] };
      console.log(
        `Halted. PM Agent paused; cancelled ${parsed.cancelledRunIds.length} active run(s).`,
      );
      for (const id of parsed.cancelledRunIds) console.log(`  - ${id}`);
    } catch {
      console.log(body);
    }
    console.log(`\nUnpause the PM Agent with Slack \`/pm resume\` when ready.`);
  });
