import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("retryCommand", () => {
  let processExit: ReturnType<typeof vi.spyOn>;
  let consoleLog: ReturnType<typeof vi.spyOn>;
  let consoleError: ReturnType<typeof vi.spyOn>;
  let origToken: string | undefined;
  let origDashboardUrl: string | undefined;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    origToken = process.env.URATEAM_CLI_TOKEN;
    origDashboardUrl = process.env.URATEAM_DASHBOARD_URL;
    process.env.URATEAM_CLI_TOKEN = "test-token-secret";
    delete process.env.URATEAM_DASHBOARD_URL;

    processExit = vi
      .spyOn(process, "exit")
      .mockImplementation((_code?: any) => {
        throw new Error(`process.exit(${_code})`);
      });
    consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    if (origToken !== undefined) {
      process.env.URATEAM_CLI_TOKEN = origToken;
    } else {
      delete process.env.URATEAM_CLI_TOKEN;
    }
    if (origDashboardUrl !== undefined) {
      process.env.URATEAM_DASHBOARD_URL = origDashboardUrl;
    } else {
      delete process.env.URATEAM_DASHBOARD_URL;
    }
    processExit.mockRestore();
    consoleLog.mockRestore();
    consoleError.mockRestore();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("success: 2xx response prints confirmation and exits 0", async () => {
    const runId = "run-uuid-1234";
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ runId, mode: "retry", issueId: "LIN-42" }),
    });

    const { retryCommand } = await import("../commands/retry.js");
    retryCommand.exitOverride();
    await retryCommand.parseAsync([runId], { from: "user" });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [calledUrl, calledOpts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe(`http://localhost:3001/cli/runs/${encodeURIComponent(runId)}/retry`);
    expect((calledOpts.headers as Record<string, string>)["x-ura-cli-token"]).toBe("test-token-secret");

    expect(processExit).not.toHaveBeenCalled();
    const logs = consoleLog.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logs).toContain(`Retry queued for run ${runId}.`);
  });

  it("failure: non-2xx response prints HTTP status to stderr and exits 1", async () => {
    const runId = "run-uuid-5678";
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      text: async () => "Cannot retry a run in status running",
    });

    const { retryCommand } = await import("../commands/retry.js");
    retryCommand.exitOverride();
    await expect(
      retryCommand.parseAsync([runId], { from: "user" }),
    ).rejects.toThrow("process.exit(1)");

    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("HTTP 409"),
    );
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("Cannot retry a run in status running"),
    );
  });

  it("missing URATEAM_CLI_TOKEN: prints clear error and does not call fetch", async () => {
    delete process.env.URATEAM_CLI_TOKEN;

    const { retryCommand } = await import("../commands/retry.js");
    retryCommand.exitOverride();
    await expect(
      retryCommand.parseAsync(["some-run-id"], { from: "user" }),
    ).rejects.toThrow("process.exit(1)");

    expect(fetchMock).not.toHaveBeenCalled();
    const errors = consoleError.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(errors).toContain("URATEAM_CLI_TOKEN");
  });

  it("--url override: POSTs to the provided URL instead of default", async () => {
    const runId = "run-abc";
    const customUrl = "http://my-dashboard:4000";
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ runId, mode: "retry", issueId: "LIN-1" }),
    });

    const { retryCommand } = await import("../commands/retry.js");
    retryCommand.exitOverride();
    await retryCommand.parseAsync([runId, "--url", customUrl], { from: "user" });

    const [calledUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe(
      `${customUrl}/cli/runs/${encodeURIComponent(runId)}/retry`,
    );
  });
});
