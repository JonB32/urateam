import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createHmac } from "crypto";

import { webhookCommand } from "../commands/webhook.js";

const SAMPLE_PAYLOAD = {
  action: "update",
  type: "Issue",
  data: {
    id: "issue-uuid-123",
    identifier: "LIN-42",
    title: "Add user search",
    state: { id: "state-uuid", name: "Todo" },
    teamId: "team-frontend",
    labels: [{ name: "auto-implement" }],
  },
};

describe("lag webhook", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let exitSpy: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let logSpy: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let errorSpy: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchMock: any;
  let tmpFile: string;
  let payloadStr: string;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Write a temp fixture file — no live network access needed
    payloadStr = JSON.stringify(SAMPLE_PAYLOAD);
    tmpFile = join(tmpdir(), `webhook-cli-test-${Date.now()}.json`);
    writeFileSync(tmpFile, payloadStr);

    // Mock global fetch so no real HTTP request is made
    fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      json: vi.fn().mockResolvedValue({ ok: true }),
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    try {
      unlinkSync(tmpFile);
    } catch {
      // ignore cleanup errors
    }
  });

  it("sends a POST request to the local webhook endpoint", async () => {
    await webhookCommand.parseAsync([
      "node",
      "ura",
      "--file",
      tmpFile,
      "--port",
      "3000",
      "--secret",
      "dev-secret",
    ]);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe("http://localhost:3000/webhooks/linear");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.body).toBe(payloadStr);
  });

  it("signs the payload with HMAC-SHA256 using the provided secret", async () => {
    const secret = "my-test-secret";
    const expectedSignature = createHmac("sha256", secret)
      .update(payloadStr)
      .digest("hex");

    await webhookCommand.parseAsync([
      "node",
      "ura",
      "--file",
      tmpFile,
      "--port",
      "3000",
      "--secret",
      secret,
    ]);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(init.headers["Linear-Signature"]).toBe(expectedSignature);
    // SHA-256 hex digest is always 64 characters
    expect(init.headers["Linear-Signature"]).toHaveLength(64);
  });

  it("logs the server response on success", async () => {
    await webhookCommand.parseAsync([
      "node",
      "ura",
      "--file",
      tmpFile,
    ]);

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("Response (200)"),
      expect.any(String),
    );
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("uses the default dev-secret when no secret is provided", async () => {
    const expectedSignature = createHmac("sha256", "dev-secret")
      .update(payloadStr)
      .digest("hex");

    await webhookCommand.parseAsync([
      "node",
      "ura",
      "--file",
      tmpFile,
    ]);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(init.headers["Linear-Signature"]).toBe(expectedSignature);
  });

  it("logs a helpful error and lag dev hint when the server is unreachable", async () => {
    fetchMock.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:3000"));

    await webhookCommand.parseAsync([
      "node",
      "ura",
      "--file",
      tmpFile,
    ]);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to send webhook"),
      expect.any(Error),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("lag dev"),
    );
    // Should NOT call process.exit — webhook failure is non-fatal
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("sends to custom port when --port is specified", async () => {
    await webhookCommand.parseAsync([
      "node",
      "ura",
      "--file",
      tmpFile,
      "--port",
      "9000",
    ]);

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("http://localhost:9000/webhooks/linear");
  });
});
