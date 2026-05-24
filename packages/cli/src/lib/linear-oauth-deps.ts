/**
 * Default real-world implementations of the LinearOAuthDeps callbacks.
 * Split into its own module so tests can mock the entire shim without
 * pulling in node:child_process and friends.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { LinearTokenResponse } from "./linear-oauth.js";

const execFileP = promisify(execFile);

export async function defaultBrowserOpen(url: string): Promise<void> {
  // macOS: `open`, Linux: `xdg-open`. If neither resolves, print the URL.
  const cmd = process.platform === "darwin" ? "open" : "xdg-open";
  try {
    await execFileP(cmd, [url]);
  } catch {
    console.log("Open this URL in your browser:");
    console.log(`  ${url}`);
  }
}

export async function defaultFetchTokenEndpoint(body: {
  code: string;
  client_id: string;
  client_secret: string;
  redirect_uri: string;
  grant_type: "authorization_code";
}): Promise<LinearTokenResponse> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) params.set(k, v);
  const res = await fetch("https://api.linear.app/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    throw new Error(`${res.status}: ${errText.slice(0, 200)}`);
  }
  return (await res.json()) as LinearTokenResponse;
}

export async function defaultFetchViewer(
  accessToken: string,
): Promise<{ workspaceId: string; workspaceName?: string }> {
  const query = "query { organization { id name } }";
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) {
    throw new Error(
      `Failed to fetch workspace metadata: ${res.status} ${res.statusText}`,
    );
  }
  const json = (await res.json()) as {
    data?: { organization?: { id: string; name?: string } };
  };
  const org = json?.data?.organization;
  if (!org?.id) throw new Error("Linear returned no organization id");
  return { workspaceId: org.id, workspaceName: org.name };
}
