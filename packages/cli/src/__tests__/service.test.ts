import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const execFileMock = vi.fn(
  async (
    _cmd: string,
    _args: ReadonlyArray<string>,
  ): Promise<{ stdout: string; stderr: string }> => ({
    stdout: "",
    stderr: "",
  }),
);

vi.mock("node:child_process", async () => {
  const actual: any = await vi.importActual("node:child_process");
  return {
    ...actual,
    execFile: (cmd: string, args: string[], cb: any) => {
      execFileMock(cmd, args)
        .then((r) => cb(null, r.stdout, r.stderr))
        .catch((e) => cb(e));
    },
  };
});

let fakeHome: string;
vi.mock("node:os", async () => {
  const actual: any = await vi.importActual("node:os");
  return {
    ...actual,
    homedir: () => fakeHome,
    userInfo: () => ({ username: "tester" }),
  };
});

const { serviceCommand } = await import("../commands/service.js");

describe("ura service install (darwin)", () => {
  let tmp: string;
  let originalPlatform: PropertyDescriptor;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ura-service-"));
    fakeHome = tmp;
    mkdirSync(join(tmp, "Library", "LaunchAgents"), { recursive: true });
    mkdirSync(join(tmp, ".urateam", "data"), { recursive: true });
    process.env.URATEAM_HOME = join(tmp, ".urateam");
    originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "darwin" });
    execFileMock.mockClear();
  });
  afterEach(() => {
    delete process.env.URATEAM_HOME;
    Object.defineProperty(process, "platform", originalPlatform);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("writes the plist and loads it via launchctl", async () => {
    await serviceCommand.parseAsync(["install"], { from: "user" });
    const plist = join(
      tmp,
      "Library",
      "LaunchAgents",
      "com.urateam.daemon.plist",
    );
    expect(existsSync(plist)).toBe(true);
    const content = readFileSync(plist, "utf8");
    expect(content).toContain("<key>Label</key>");
    expect(content).toContain("com.urateam.daemon");
    const launchctlCalls = execFileMock.mock.calls.filter(
      ([cmd]) => cmd === "launchctl",
    );
    expect(launchctlCalls.length).toBeGreaterThanOrEqual(1);
    expect(launchctlCalls.some(([, args]) => args.includes("load"))).toBe(true);
  });

  it("--dry-run prints the plist and writes nothing", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await serviceCommand.parseAsync(["install", "--dry-run"], { from: "user" });
    const plist = join(
      tmp,
      "Library",
      "LaunchAgents",
      "com.urateam.daemon.plist",
    );
    expect(existsSync(plist)).toBe(false);
    const out = spy.mock.calls.flat().join("\n");
    expect(out).toContain("<?xml");
    expect(out).toContain("com.urateam.daemon");
    expect(execFileMock).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("is idempotent: skips when the plist already exists", async () => {
    const plist = join(
      tmp,
      "Library",
      "LaunchAgents",
      "com.urateam.daemon.plist",
    );
    writeFileSync(plist, "<!-- existing -->");
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await serviceCommand.parseAsync(["install"], { from: "user" });
    expect(readFileSync(plist, "utf8")).toBe("<!-- existing -->");
    expect(spy.mock.calls.flat().join("\n")).toMatch(/already exists/i);
    expect(execFileMock).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("ura service install (linux)", () => {
  let tmp: string;
  let originalPlatform: PropertyDescriptor;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ura-service-"));
    fakeHome = tmp;
    mkdirSync(join(tmp, ".config", "systemd", "user"), { recursive: true });
    mkdirSync(join(tmp, ".urateam", "data"), { recursive: true });
    process.env.URATEAM_HOME = join(tmp, ".urateam");
    originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "linux" });
    execFileMock.mockClear();
  });
  afterEach(() => {
    delete process.env.URATEAM_HOME;
    Object.defineProperty(process, "platform", originalPlatform);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("writes the systemd unit and runs daemon-reload + enable --now", async () => {
    await serviceCommand.parseAsync(["install"], { from: "user" });
    const unit = join(tmp, ".config", "systemd", "user", "urateam.service");
    expect(existsSync(unit)).toBe(true);
    expect(readFileSync(unit, "utf8")).toContain("ExecStart=");
    const systemctlCalls = execFileMock.mock.calls.filter(
      ([cmd]) => cmd === "systemctl",
    );
    expect(
      systemctlCalls.some(([, args]) => args.includes("daemon-reload")),
    ).toBe(true);
    expect(
      systemctlCalls.some(
        ([, args]) =>
          args.includes("enable") && args.includes("urateam.service"),
      ),
    ).toBe(true);
  });
});

describe("ura service install (unsupported platform)", () => {
  let originalPlatform: PropertyDescriptor;
  beforeEach(() => {
    originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32" });
  });
  afterEach(() => {
    Object.defineProperty(process, "platform", originalPlatform);
  });
  it("fails with a clear message", async () => {
    await expect(
      serviceCommand.parseAsync(["install"], { from: "user" }),
    ).rejects.toThrow(/unsupported platform/i);
  });
});

describe("ura service uninstall (darwin)", () => {
  let tmp: string;
  let originalPlatform: PropertyDescriptor;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ura-service-"));
    fakeHome = tmp;
    mkdirSync(join(tmp, "Library", "LaunchAgents"), { recursive: true });
    originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "darwin" });
    execFileMock.mockClear();
  });
  afterEach(() => {
    Object.defineProperty(process, "platform", originalPlatform);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("unloads and deletes the plist when present", async () => {
    const plist = join(
      tmp,
      "Library",
      "LaunchAgents",
      "com.urateam.daemon.plist",
    );
    writeFileSync(plist, "<!-- existing -->");
    await serviceCommand.parseAsync(["uninstall"], { from: "user" });
    expect(existsSync(plist)).toBe(false);
    expect(
      execFileMock.mock.calls.some(
        ([cmd, args]) => cmd === "launchctl" && args.includes("unload"),
      ),
    ).toBe(true);
  });

  it("is a no-op when the plist is already absent", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await serviceCommand.parseAsync(["uninstall"], { from: "user" });
    expect(spy.mock.calls.flat().join("\n")).toMatch(/not installed/i);
    expect(execFileMock).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
