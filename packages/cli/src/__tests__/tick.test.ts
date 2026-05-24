import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("tickCommand", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let processExit: any;
  let consoleLog: ReturnType<typeof vi.spyOn>;
  let consoleError: ReturnType<typeof vi.spyOn>;
  let fetchMock: ReturnType<typeof vi.fn>;
  let origToken: string | undefined;
  let origDashboardUrl: string | undefined;

  beforeEach(() => {
    origToken = process.env.URATEAM_CLI_TOKEN;
    origDashboardUrl = process.env.URATEAM_DASHBOARD_URL;
    process.env.URATEAM_CLI_TOKEN = "test-token-secret";
    delete process.env.URATEAM_DASHBOARD_URL;

    processExit = vi
      .spyOn(process, "exit")
      .mockImplementation(((_code?: unknown) => {
        throw new Error(`process.exit(${_code})`);
      }) as never);
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

  it("POSTs to /cli/pm/tick with correct method, headers, and URL", async () => {
    const triggeredAt = new Date().toISOString();
    const completedAt = new Date().toISOString();
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ triggeredAt, completedAt, errors: [] }),
    });

    const { tickCommand } = await import("../commands/tick.js");
    tickCommand.exitOverride();
    await tickCommand.parseAsync([], { from: "user" });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [calledUrl, calledOpts] = fetchMock.mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(calledUrl).toBe("http://localhost:3001/cli/pm/tick");
    expect(calledOpts.method).toBe("POST");
    const headers = calledOpts.headers as Record<string, string>;
    expect(headers["x-ura-cli-token"]).toBe("test-token-secret");
    expect(headers["x-ura-actor"]).toBeTypeOf("string");

    expect(processExit).not.toHaveBeenCalled();
    const logs = consoleLog.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logs).toContain("tick triggered");
    expect(logs).toContain("completedAt=");
    expect(logs).toContain("waitMs=");
  });

  it("--url override: POSTs to the provided URL", async () => {
    const customUrl = "http://my-dashboard:4000";
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          triggeredAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          errors: [],
        }),
    });

    const { tickCommand } = await import("../commands/tick.js");
    tickCommand.exitOverride();
    await tickCommand.parseAsync(["--url", customUrl], { from: "user" });

    const [calledUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe(`${customUrl}/cli/pm/tick`);
  });

  it("failure: non-2xx response prints HTTP status to stderr and exits 1", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => "PM scheduler not configured",
    });

    const { tickCommand } = await import("../commands/tick.js");
    tickCommand.exitOverride();
    await expect(
      tickCommand.parseAsync([], { from: "user" }),
    ).rejects.toThrow("process.exit(1)");

    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("HTTP 503"),
    );
  });

  it("missing URATEAM_CLI_TOKEN: prints clear error and does not call fetch", async () => {
    delete process.env.URATEAM_CLI_TOKEN;

    const { tickCommand } = await import("../commands/tick.js");
    tickCommand.exitOverride();
    await expect(
      tickCommand.parseAsync([], { from: "user" }),
    ).rejects.toThrow("process.exit(1)");

    expect(fetchMock).not.toHaveBeenCalled();
    const errors = consoleError.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(errors).toContain("URATEAM_CLI_TOKEN");
  });

  it("prints errors when server response includes errors array", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          triggeredAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          errors: ["something blew up"],
        }),
    });

    const { tickCommand } = await import("../commands/tick.js");
    tickCommand.exitOverride();
    await tickCommand.parseAsync([], { from: "user" });

    const errors = consoleError.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(errors).toContain("something blew up");
    expect(errors).toContain("1 error");
  });
});
