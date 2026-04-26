import { describe, it, expect, afterEach } from "vitest";
import { createApp, type ServerConfig } from "../server.js";
import { defaultConfigs } from "../pipeline/config.js";
import { installTestProLicense, restoreLicense } from "./helpers/license.js";

const PM_SLACK_CONFIG = {
  signingSecret: "slack_signing_test",
  botToken: "xoxb-test",
  channelId: "C_TEST",
  teamIds: ["T_TEST"],
};

async function buildApp(overrides: Partial<ServerConfig> = {}) {
  return createApp({
    webhookSecret: "whsec_test_secret",
    linearApiKey: "lin_api_test",
    pipelineConfigs: defaultConfigs,
    repoConfigs: {
      "team-frontend": {
        url: "https://github.com/org/repo",
        defaultBranch: "main",
        testCommand: "npm test",
        buildCommand: "npm run build",
      },
    },
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------
describe("GET /health", () => {
  it("returns 200 with status, timestamp, pipeline count, and repo count", async () => {
    const { app } = await buildApp();
    const res = await app.request("/health");

    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.timestamp).toBeDefined();
    expect(() => new Date(body.timestamp)).not.toThrow();
    expect(body.pipelines).toBe(Object.keys(defaultConfigs).length);
    expect(body.repos).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Webhook mount verification
// ---------------------------------------------------------------------------
describe("POST /webhooks/linear", () => {
  it("returns 401 without valid signature", async () => {
    const { app } = await buildApp();
    const res = await app.request("/webhooks/linear", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "Issue", action: "update" }),
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Invalid signature");
  });
});

// ---------------------------------------------------------------------------
// Unknown routes
// ---------------------------------------------------------------------------
describe("Unknown routes", () => {
  it("returns 404 for unregistered paths", async () => {
    const { app } = await buildApp();
    const res = await app.request("/does-not-exist");

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// PM Slack interface license gating
// ---------------------------------------------------------------------------
describe("PM Slack interface mount is license-gated", () => {
  afterEach(async () => {
    await restoreLicense();
  });

  it("does NOT mount /slack/* routes in OSS mode even when pmSlack is configured", async () => {
    // No license installed → tier is OSS → slack-interface feature unlicensed.
    const { app } = await buildApp({ pmSlack: PM_SLACK_CONFIG });
    const res = await app.request("/slack/events", { method: "POST" });
    // If the route had mounted, it'd return some Slack-handler status (200 / 401 sig
    // verification fail / 400 bad body). 404 confirms the route isn't mounted.
    expect(res.status).toBe(404);
  });

  it("DOES mount /slack/* routes when a Pro license is installed", async () => {
    await installTestProLicense();
    const { app } = await buildApp({ pmSlack: PM_SLACK_CONFIG });
    const res = await app.request("/slack/events", { method: "POST" });
    // Route is mounted — status must NOT be 404. Slack handler will reject the
    // empty unsigned body via its own validation, so any non-404 status confirms
    // the mount.
    expect(res.status).not.toBe(404);
  });
});
