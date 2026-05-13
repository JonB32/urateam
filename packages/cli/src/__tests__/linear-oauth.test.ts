import { describe, it, expect, vi } from "vitest";
import { runLinearOAuth, type LinearOAuthDeps } from "../lib/linear-oauth.js";

function makeDeps(overrides: Partial<LinearOAuthDeps> = {}): LinearOAuthDeps {
  return {
    clientId: "linear-client-id",
    clientSecret: "linear-client-secret",
    scope: "read,write",
    timeoutMs: 1000,
    openBrowser: vi.fn(async (_url: string) => {}),
    fetchTokenEndpoint: vi.fn(async (_body) => ({
      access_token: "lin_oauth_token_123",
      token_type: "Bearer",
      expires_in: 31536000,
      scope: "read,write",
    })),
    fetchViewer: vi.fn(async (_token) => ({
      workspaceId: "ws_abc",
      workspaceName: "Acme",
    })),
    ...overrides,
  };
}

async function postCallback(port: number, params: Record<string, string>) {
  const qs = new URLSearchParams(params).toString();
  return fetch(`http://127.0.0.1:${port}/callback?${qs}`);
}

describe("runLinearOAuth", () => {
  it("happy path: returns token + workspace metadata after a valid callback", async () => {
    const deps = makeDeps();
    let capturedPort = 0;
    let capturedState = "";
    deps.openBrowser = vi.fn(async (url: string) => {
      const parsed = new URL(url);
      capturedState = parsed.searchParams.get("state")!;
      const redirectUri = parsed.searchParams.get("redirect_uri")!;
      capturedPort = Number(new URL(redirectUri).port);
      await postCallback(capturedPort, {
        code: "test-code",
        state: capturedState,
      });
    });
    const result = await runLinearOAuth(deps);
    expect(result.accessToken).toBe("lin_oauth_token_123");
    expect(result.workspaceId).toBe("ws_abc");
    expect(result.workspaceName).toBe("Acme");
    expect(deps.fetchTokenEndpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "test-code",
        client_id: "linear-client-id",
        client_secret: "linear-client-secret",
        grant_type: "authorization_code",
      }),
    );
  });

  it("rejects state mismatch", async () => {
    const deps = makeDeps();
    deps.openBrowser = vi.fn(async (url: string) => {
      const parsed = new URL(url);
      const redirectUri = parsed.searchParams.get("redirect_uri")!;
      const port = Number(new URL(redirectUri).port);
      await postCallback(port, {
        code: "test-code",
        state: "ATTACKER-STATE",
      });
    });
    await expect(runLinearOAuth(deps)).rejects.toThrow(/state mismatch/i);
  });

  it("times out when the callback never arrives", async () => {
    const deps = makeDeps({
      timeoutMs: 100,
      openBrowser: vi.fn(async () => {}),
    });
    await expect(runLinearOAuth(deps)).rejects.toThrow(/timed out/i);
  });

  it("surfaces Linear API errors during token exchange", async () => {
    const deps = makeDeps({
      fetchTokenEndpoint: vi.fn(async () => {
        throw new Error("400: invalid_grant");
      }),
    });
    deps.openBrowser = vi.fn(async (url: string) => {
      const parsed = new URL(url);
      const state = parsed.searchParams.get("state")!;
      const redirectUri = parsed.searchParams.get("redirect_uri")!;
      const port = Number(new URL(redirectUri).port);
      await postCallback(port, { code: "bad-code", state });
    });
    await expect(runLinearOAuth(deps)).rejects.toThrow(/invalid_grant/);
  });

  it("never returns the token via the openBrowser URL or the callback response body", async () => {
    const deps = makeDeps();
    let urlPassedToBrowser = "";
    let callbackBody = "";
    deps.openBrowser = vi.fn(async (url: string) => {
      urlPassedToBrowser = url;
      const parsed = new URL(url);
      const state = parsed.searchParams.get("state")!;
      const redirectUri = parsed.searchParams.get("redirect_uri")!;
      const port = Number(new URL(redirectUri).port);
      const res = await postCallback(port, { code: "test-code", state });
      callbackBody = await res.text();
    });
    await runLinearOAuth(deps);
    expect(urlPassedToBrowser).not.toContain("lin_oauth_token_123");
    expect(callbackBody).not.toContain("lin_oauth_token_123");
  });

  it("rejects callback without a code", async () => {
    const deps = makeDeps();
    deps.openBrowser = vi.fn(async (url: string) => {
      const parsed = new URL(url);
      const state = parsed.searchParams.get("state")!;
      const redirectUri = parsed.searchParams.get("redirect_uri")!;
      const port = Number(new URL(redirectUri).port);
      await postCallback(port, { state });
    });
    await expect(runLinearOAuth(deps)).rejects.toThrow(/missing code/i);
  });
});
