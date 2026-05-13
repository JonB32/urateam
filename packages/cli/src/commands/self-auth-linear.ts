/**
 * `ura self-auth-linear` — browser-based Linear OAuth flow.
 *
 * Preconditions:
 *   1. `ura init` has been run (`$URATEAM_HOME` exists).
 *   2. `LINEAR_CLIENT_ID` and `LINEAR_CLIENT_SECRET` are set (operator created
 *      an OAuth app in Linear's settings — see deploy/USER_LEVEL_INSTALL.md).
 *
 * Behavior:
 *   - Starts an ephemeral 127.0.0.1 HTTP server, opens the authorize URL in
 *     the operator's browser, verifies the HMAC-signed state on callback,
 *     exchanges the code for an access token, fetches workspace metadata.
 *   - Writes LINEAR_API_KEY=<access_token> to $URATEAM_HOME/.env, preserving
 *     unrelated keys.
 *   - Emits a `linear.oauth_completed` audit event opportunistically.
 *
 * The access token is never logged. The success-page HTML returned to the
 * browser contains no token.
 */
import { Command } from "commander";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { userInfo } from "node:os";
import {
  createDb,
  logAuditEvent,
  linearOauthCompletedEvent,
} from "@urateam/core";
import {
  resolveUserLevelHome,
  userLevelDataDir,
} from "../lib/user-level-config.js";
import { runLinearOAuth } from "../lib/linear-oauth.js";
import {
  defaultBrowserOpen,
  defaultFetchTokenEndpoint,
  defaultFetchViewer,
} from "../lib/linear-oauth-deps.js";
import { upsertEnvFile } from "../lib/env-file.js";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_SCOPE = "read,write";

async function tryEmitAuditEvent(args: {
  workspaceId: string;
  workspaceName?: string;
}): Promise<void> {
  try {
    const dbPath = join(userLevelDataDir(), "urateam.db");
    if (!existsSync(dbPath)) return;
    const db = await createDb({ connectionString: dbPath });
    const actor = `cli:${userInfo().username ?? "unknown"}`;
    await logAuditEvent(
      db,
      linearOauthCompletedEvent({
        workspaceId: args.workspaceId,
        workspaceName: args.workspaceName,
        actor,
      }),
    );
  } catch {
    // Audit failure must not break the OAuth flow.
  }
}

export const selfAuthLinearCommand = new Command("self-auth-linear")
  .description(
    "Browser-based Linear OAuth flow; stores the token as LINEAR_API_KEY in ~/.urateam/.env",
  )
  .option(
    "--timeout-ms <ms>",
    "How long to wait for the operator to authorize (default 5 minutes)",
    String(DEFAULT_TIMEOUT_MS),
  )
  .option(
    "--scope <scope>",
    "OAuth scopes to request (comma-separated)",
    DEFAULT_SCOPE,
  )
  .action(async (opts: { timeoutMs: string; scope: string }) => {
    const home = resolveUserLevelHome();
    if (!existsSync(home)) {
      throw new Error(
        `ura self-auth-linear: ${home} does not exist. Run 'ura init' first.`,
      );
    }
    const clientId = process.env.LINEAR_CLIENT_ID;
    const clientSecret = process.env.LINEAR_CLIENT_SECRET;
    if (!clientId) {
      throw new Error(
        "ura self-auth-linear: LINEAR_CLIENT_ID is not set. Create a Linear OAuth app at https://linear.app/settings/api/applications/new and set LINEAR_CLIENT_ID + LINEAR_CLIENT_SECRET in ~/.urateam/.env before running this command.",
      );
    }
    if (!clientSecret) {
      throw new Error(
        "ura self-auth-linear: LINEAR_CLIENT_SECRET is not set. See https://linear.app/settings/api/applications and copy the client secret into ~/.urateam/.env.",
      );
    }

    console.log("ura self-auth-linear: opening Linear in your browser…");
    const result = await runLinearOAuth({
      clientId,
      clientSecret,
      scope: opts.scope,
      timeoutMs: Number(opts.timeoutMs),
      openBrowser: defaultBrowserOpen,
      fetchTokenEndpoint: defaultFetchTokenEndpoint,
      fetchViewer: defaultFetchViewer,
    });

    upsertEnvFile(join(home, ".env"), {
      LINEAR_API_KEY: result.accessToken,
    });

    console.log(
      `ura self-auth-linear: authorized for workspace ${
        result.workspaceName ?? result.workspaceId
      }; token written to ${join(home, ".env")}.`,
    );
    await tryEmitAuditEvent({
      workspaceId: result.workspaceId,
      workspaceName: result.workspaceName,
    });
  });
