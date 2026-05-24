/**
 * Linear OAuth 2.0 authorization-code flow, runnable headlessly with
 * dependency-injected browser-open and HTTP transport for tests.
 *
 * High-level:
 *   1. Bind an ephemeral 127.0.0.1 server (random free port).
 *   2. Redirect the operator's browser to Linear with the loopback callback.
 *   3. Verify the HMAC-signed state on the callback.
 *   4. Exchange the code for an access token.
 *   5. Look up workspace metadata (for the audit event).
 *   6. Shut the server down.
 *
 * Token handling: the access token never crosses console.log, never lands
 * in the success-page HTML, and never appears in the audit event payload.
 */
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { newNonce, signState, verifyState } from "./oauth-state.js";

export interface LinearOAuthDeps {
  clientId: string;
  clientSecret: string;
  scope: string;
  /** Total time to wait for the operator to authorize, in milliseconds. */
  timeoutMs: number;
  /**
   * Port to bind the local callback server to. Fixed because Linear requires
   * the redirect URI registered in the OAuth app settings to match the URI
   * sent in the authorize request EXACTLY (host + port + path), so a
   * random port would force the operator to re-register every time.
   * Pass `0` to bind a random free port (test-only — production code must
   * pass a stable value).
   */
  port: number;
  /** Opens the authorize URL in the operator's browser. Pure-test override. */
  openBrowser: (url: string) => Promise<void>;
  /** Exchanges the code for an access token. */
  fetchTokenEndpoint: (body: {
    code: string;
    client_id: string;
    client_secret: string;
    redirect_uri: string;
    grant_type: "authorization_code";
  }) => Promise<LinearTokenResponse>;
  /** Fetches workspace metadata for the audit event. */
  fetchViewer: (
    accessToken: string,
  ) => Promise<{ workspaceId: string; workspaceName?: string }>;
}

export interface LinearTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
}

export interface LinearOAuthResult {
  accessToken: string;
  workspaceId: string;
  workspaceName?: string;
  scope: string;
  expiresInSeconds: number;
}

const SUCCESS_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>urateam OAuth</title></head>
<body style="font-family: -apple-system, sans-serif; max-width: 520px; margin: 80px auto; line-height: 1.5;">
<h1>Authorized</h1>
<p>You can close this tab. Return to your terminal to continue.</p>
</body></html>`;

const ERROR_HTML = (msg: string) => `<!doctype html>
<html><head><meta charset="utf-8"><title>urateam OAuth</title></head>
<body style="font-family: -apple-system, sans-serif; max-width: 520px; margin: 80px auto; line-height: 1.5;">
<h1>Authorization failed</h1>
<p>${msg}</p>
</body></html>`;

const AUTHORIZE_URL = "https://linear.app/oauth/authorize";

export async function runLinearOAuth(
  deps: LinearOAuthDeps,
): Promise<LinearOAuthResult> {
  const stateSecret = randomBytes(32).toString("hex");
  const nonce = newNonce();
  const state = signState(stateSecret, nonce);

  return await new Promise<LinearOAuthResult>((resolve, reject) => {
    let resolved = false;
    let server: Server | null = null;
    const timeout = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      server?.close();
      reject(
        new Error(
          `ura self-auth-linear: timed out waiting for the OAuth callback (${deps.timeoutMs}ms)`,
        ),
      );
    }, deps.timeoutMs);

    const finalize = (
      ok: () => void,
      err?: (e: Error) => void,
      e?: Error,
    ): void => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      server?.close();
      if (e && err) err(e);
      else ok();
    };

    server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url ?? "/", `http://127.0.0.1`);
        if (url.pathname !== "/callback") {
          res.writeHead(404).end();
          return;
        }
        const code = url.searchParams.get("code");
        const incomingState = url.searchParams.get("state") ?? "";
        const verified = verifyState(stateSecret, incomingState);
        if (!verified || verified !== nonce) {
          res.writeHead(400, { "content-type": "text/html" });
          res.end(ERROR_HTML("State mismatch — possible CSRF; abort."));
          finalize(
            () => {},
            (e) => reject(e),
            new Error("ura self-auth-linear: state mismatch — aborting"),
          );
          return;
        }
        if (!code) {
          res.writeHead(400, { "content-type": "text/html" });
          res.end(ERROR_HTML("Missing 'code' parameter from Linear."));
          finalize(
            () => {},
            (e) => reject(e),
            new Error("ura self-auth-linear: missing code in callback"),
          );
          return;
        }

        const port = (server!.address() as { port: number }).port;
        const redirectUri = `http://127.0.0.1:${port}/callback`;

        const token = await deps.fetchTokenEndpoint({
          code,
          client_id: deps.clientId,
          client_secret: deps.clientSecret,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        });

        // Render the success page IMMEDIATELY after token exchange succeeds.
        // The operator's view of "Authorized" must not depend on the
        // subsequent viewer fetch, which is only used for the audit event's
        // display name. If `fetchViewer` fails (Linear GraphQL hiccup), we
        // still resolve with the token — falling back to an "unknown"
        // workspace placeholder.
        res.writeHead(200, { "content-type": "text/html" });
        res.end(SUCCESS_HTML);

        let viewer: { workspaceId: string; workspaceName?: string };
        try {
          viewer = await deps.fetchViewer(token.access_token);
        } catch {
          viewer = { workspaceId: "unknown", workspaceName: undefined };
        }

        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          server?.close();
          resolve({
            accessToken: token.access_token,
            workspaceId: viewer.workspaceId,
            workspaceName: viewer.workspaceName,
            scope: token.scope,
            expiresInSeconds: token.expires_in,
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        try {
          res.writeHead(500, { "content-type": "text/html" });
          res.end(ERROR_HTML("Token exchange failed; check the terminal."));
        } catch {
          // response may already be sent
        }
        finalize(
          () => {},
          (e) => reject(e),
          new Error(`ura self-auth-linear: ${message}`),
        );
      }
    });

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        finalize(
          () => {},
          (e) => reject(e),
          new Error(
            `ura self-auth-linear: port ${deps.port} is already in use. ` +
              `Pass --port <other-port> and register the matching redirect URI in your Linear OAuth app.`,
          ),
        );
        return;
      }
      finalize(
        () => {},
        (e) => reject(e),
        err instanceof Error ? err : new Error(String(err)),
      );
    });

    server.listen(deps.port, "127.0.0.1", async () => {
      try {
        const port = (server!.address() as { port: number }).port;
        const redirectUri = `http://127.0.0.1:${port}/callback`;
        const authUrl = new URL(AUTHORIZE_URL);
        authUrl.searchParams.set("client_id", deps.clientId);
        authUrl.searchParams.set("redirect_uri", redirectUri);
        authUrl.searchParams.set("response_type", "code");
        authUrl.searchParams.set("scope", deps.scope);
        authUrl.searchParams.set("state", state);
        await deps.openBrowser(authUrl.toString());
      } catch (err) {
        finalize(
          () => {},
          (e) => reject(e),
          err instanceof Error ? err : new Error(String(err)),
        );
      }
    });
  });
}
