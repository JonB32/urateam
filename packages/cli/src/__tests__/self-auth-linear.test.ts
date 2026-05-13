import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Drive the OAuth flow by hijacking `defaultBrowserOpen` to post the simulated
// provider callback at the server the real `runLinearOAuth` opens; mock the
// token + viewer fetches so no network is touched.
vi.mock("../lib/linear-oauth-deps.js", async () => {
  return {
    defaultBrowserOpen: async (url: string) => {
      const parsed = new URL(url);
      const state = parsed.searchParams.get("state")!;
      const redirectUri = parsed.searchParams.get("redirect_uri")!;
      const port = Number(new URL(redirectUri).port);
      const qs = new URLSearchParams({ code: "fake-code", state }).toString();
      await fetch(`http://127.0.0.1:${port}/callback?${qs}`);
    },
    defaultFetchTokenEndpoint: async () => ({
      access_token: "lin_oauth_TOKEN",
      token_type: "Bearer",
      expires_in: 31536000,
      scope: "read,write",
    }),
    defaultFetchViewer: async () => ({
      workspaceId: "ws_test",
      workspaceName: "Test Workspace",
    }),
  };
});

const { selfAuthLinearCommand } = await import(
  "../commands/self-auth-linear.js"
);

describe("ura self-auth-linear", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ura-oauth-"));
    process.env.URATEAM_HOME = tmp;
    mkdirSync(tmp, { recursive: true });
    process.env.LINEAR_CLIENT_ID = "client-abc";
    process.env.LINEAR_CLIENT_SECRET = "secret-xyz";
  });
  afterEach(() => {
    delete process.env.URATEAM_HOME;
    delete process.env.LINEAR_CLIENT_ID;
    delete process.env.LINEAR_CLIENT_SECRET;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("writes LINEAR_API_KEY to ~/.urateam/.env on success", async () => {
    await selfAuthLinearCommand.parseAsync([], { from: "user" });
    const raw = readFileSync(join(tmp, ".env"), "utf8");
    expect(raw).toContain("LINEAR_API_KEY=lin_oauth_TOKEN");
  });

  it("preserves unrelated keys in an existing .env", async () => {
    writeFileSync(
      join(tmp, ".env"),
      "ANTHROPIC_API_KEY=sk-ant-xyz\nLINEAR_API_KEY=lin_api_old\n",
    );
    await selfAuthLinearCommand.parseAsync([], { from: "user" });
    const raw = readFileSync(join(tmp, ".env"), "utf8");
    expect(raw).toContain("ANTHROPIC_API_KEY=sk-ant-xyz");
    expect(raw).toContain("LINEAR_API_KEY=lin_oauth_TOKEN");
    expect(raw).not.toContain("lin_api_old");
  });

  it("never logs the token to console", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await selfAuthLinearCommand.parseAsync([], { from: "user" });
    const out = spy.mock.calls.flat().join("\n");
    expect(out).not.toContain("lin_oauth_TOKEN");
    spy.mockRestore();
  });

  it("logs the workspace name on success (operator-friendly confirmation)", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await selfAuthLinearCommand.parseAsync([], { from: "user" });
    const out = spy.mock.calls.flat().join("\n");
    expect(out).toMatch(/Test Workspace/);
    spy.mockRestore();
  });

  it("fails when LINEAR_CLIENT_ID is missing", async () => {
    delete process.env.LINEAR_CLIENT_ID;
    await expect(
      selfAuthLinearCommand.parseAsync([], { from: "user" }),
    ).rejects.toThrow(/LINEAR_CLIENT_ID/);
  });

  it("fails when LINEAR_CLIENT_SECRET is missing", async () => {
    delete process.env.LINEAR_CLIENT_SECRET;
    await expect(
      selfAuthLinearCommand.parseAsync([], { from: "user" }),
    ).rejects.toThrow(/LINEAR_CLIENT_SECRET/);
  });

  it("fails when URATEAM_HOME does not exist (operator forgot 'ura init')", async () => {
    rmSync(tmp, { recursive: true, force: true });
    await expect(
      selfAuthLinearCommand.parseAsync([], { from: "user" }),
    ).rejects.toThrow(/ura init/i);
  });
});
