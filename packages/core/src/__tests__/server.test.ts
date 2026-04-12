import { describe, it, expect } from "vitest";
import { createApp } from "../server.js";
import { defaultConfigs } from "../pipeline/config.js";

async function buildApp() {
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
