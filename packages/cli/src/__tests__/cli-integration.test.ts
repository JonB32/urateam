import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";

// ---------------------------------------------------------------------------
// Command registration — all expected commands are registered
// ---------------------------------------------------------------------------
describe("command registration", () => {
  it("registers all expected commands: run, dev, webhook, config, start, bootstrap", async () => {
    // We cannot import index.ts directly because it calls .parse() on import,
    // so we verify by importing each command and checking its name.
    const { runCommand } = await import("../commands/run.js");
    const { devCommand } = await import("../commands/dev.js");
    const { webhookCommand } = await import("../commands/webhook.js");
    const { configCommand } = await import("../commands/config.js");
    const { startCommand } = await import("../commands/start.js");
    const { bootstrapCommand } = await import("../commands/bootstrap.js");

    // Build a program the same way index.ts does
    const program = new Command();
    program.name("ura").version("0.1.0");
    program.addCommand(runCommand);
    program.addCommand(devCommand);
    program.addCommand(webhookCommand);
    program.addCommand(configCommand);
    program.addCommand(startCommand);
    program.addCommand(bootstrapCommand);

    const commandNames = program.commands.map((c) => c.name());
    expect(commandNames).toContain("run");
    expect(commandNames).toContain("dev");
    expect(commandNames).toContain("webhook");
    expect(commandNames).toContain("config");
    expect(commandNames).toContain("start");
    expect(commandNames).toContain("bootstrap");
    expect(commandNames).toHaveLength(6);
  });

  it("each command has a non-empty description", async () => {
    const { runCommand } = await import("../commands/run.js");
    const { devCommand } = await import("../commands/dev.js");
    const { webhookCommand } = await import("../commands/webhook.js");
    const { configCommand } = await import("../commands/config.js");
    const { startCommand } = await import("../commands/start.js");
    const { bootstrapCommand } = await import("../commands/bootstrap.js");

    for (const cmd of [runCommand, devCommand, webhookCommand, configCommand, startCommand, bootstrapCommand]) {
      expect(cmd.description()).toBeTruthy();
    }
  });

  it("run command declares --issue as a required option", async () => {
    const { runCommand } = await import("../commands/run.js");
    const issueOpt = runCommand.options.find((o) => o.long === "--issue");
    expect(issueOpt).toBeDefined();
    expect(issueOpt!.required).toBe(true);
  });

  it("webhook command declares --file as a required option", async () => {
    const { webhookCommand } = await import("../commands/webhook.js");
    const fileOpt = webhookCommand.options.find((o) => o.long === "--file");
    expect(fileOpt).toBeDefined();
    expect(fileOpt!.required).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Required option enforcement — commander rejects missing --issue
// ---------------------------------------------------------------------------
describe("run command — missing required --issue", () => {
  it("throws when --issue is not provided", async () => {
    const { runCommand } = await import("../commands/run.js");

    // commander exits or throws when a required option is missing
    runCommand.exitOverride(); // make it throw instead of process.exit
    await expect(
      runCommand.parseAsync(["--dry-run"], { from: "user" }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// --only flag combined with --stage in dry-run output
// ---------------------------------------------------------------------------
describe("run command — --only flag with --stage", () => {
  let consoleLog: ReturnType<typeof vi.spyOn>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let processExit: any;

  beforeEach(() => {
    consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    processExit = vi.spyOn(process, "exit").mockImplementation(((_code: unknown) => {
      throw new Error(`process.exit(${_code})`);
    }) as never);
  });

  afterEach(() => {
    consoleLog.mockRestore();
    processExit.mockRestore();
  });

  it("reports only: true when --stage and --only are both provided", async () => {
    const { runCommand } = await import("../commands/run.js");

    await runCommand.parseAsync(
      ["--issue", "LIN-42", "--dry-run", "--stage", "test", "--only"],
      { from: "user" },
    );

    expect(processExit).not.toHaveBeenCalled();

    const logs = consoleLog.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logs).toContain("only: true");
    expect(logs).toContain("test");
  });
});
