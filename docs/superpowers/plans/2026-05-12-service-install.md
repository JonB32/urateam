# `ura service install` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `ura service install` and `ura service uninstall` commands that generate and install a launchd plist (macOS) or systemd-user unit (Linux) so the user-level daemon auto-starts on login. Replaces the copy-paste blocks in `deploy/USER_LEVEL_INSTALL.md`.

**Architecture:** Pure unit-file generators (`renderLaunchdPlist`, `renderSystemdUserUnit`) live in `packages/cli/src/lib/service-unit.ts` with no I/O — fully unit-testable. The `service.ts` command resolves the absolute `ura` binary path, picks the right generator by `process.platform`, writes the unit file to the platform-specific location, and invokes `launchctl` / `systemctl` via `execFile`. Idempotent (refuses to overwrite an existing install) with `--dry-run` for inspection.

**Tech Stack:** Node 22, commander, vitest. Spawns `launchctl` (macOS) or `systemctl --user` (Linux) via `execFile`. Two new audit-event types (`service.installed`, `service.uninstalled`) emitted opportunistically when the daemon DB already exists.

---

## File structure

**Create:**
- `packages/cli/src/lib/service-unit.ts` — pure unit-file generators + platform helpers
- `packages/cli/src/commands/service.ts` — `ura service install/uninstall` command
- `packages/cli/src/__tests__/service-unit.test.ts` — generator tests (deterministic strings + snapshots)
- `packages/cli/src/__tests__/service.test.ts` — command tests with mocked `execFile`

**Modify:**
- `packages/cli/src/index.ts` — register `serviceCommand`
- `packages/core/src/types.ts` — add two entries to `AuditEventTypeSchema`
- `packages/core/src/audit/events.ts` — add `serviceInstalledEvent` + `serviceUninstalledEvent` builders
- `packages/core/src/audit/index.ts` — re-export the new builders (if it has a barrel)
- `packages/core/src/index.ts` — verify the new builders are exported from `@urateam/core`
- `deploy/USER_LEVEL_INSTALL.md` — rewrite "Running as a service" to lead with `ura service install`
- `CLAUDE.md` — bump `45 event types` → `47 event types`; add the two new types to the canonical list; document the new command + escape-hatch behavior under the user-level install section
- `.claude/CLAUDE.md` — one-line note about `ura service install`

---

## Task 1: Audit-event types + builders

**Files:**
- Modify: `packages/core/src/types.ts` (AuditEventTypeSchema at line 486)
- Modify: `packages/core/src/audit/events.ts` (append at end)
- Test: `packages/core/src/__tests__/audit-events-service.test.ts`

- [ ] **Step 1: Add the two event types to `AuditEventTypeSchema`**

Append before the closing `]);` in `packages/core/src/types.ts`:

```typescript
  /** `ura service install` succeeded — a launchd plist (macOS) or systemd-user
   *  unit (Linux) was written and the service was started. Operational signal
   *  so operators can audit unattended provisioning. */
  "service.installed",
  /** `ura service uninstall` succeeded — the unit file was removed and the
   *  service stopped. */
  "service.uninstalled",
```

- [ ] **Step 2: Write the failing builder test**

Create `packages/core/src/__tests__/audit-events-service.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  serviceInstalledEvent,
  serviceUninstalledEvent,
} from "../audit/events.js";

describe("serviceInstalledEvent", () => {
  it("emits eventType 'service.installed' with platform + unitPath in payload", () => {
    const evt = serviceInstalledEvent({
      platform: "darwin",
      unitPath: "/Users/x/Library/LaunchAgents/com.urateam.daemon.plist",
      actor: "cli:jonb",
    });
    expect(evt.eventType).toBe("service.installed");
    expect(evt.actor).toBe("cli:jonb");
    expect(evt.actorType).toBe("cli");
    expect(evt.payload.platform).toBe("darwin");
    expect(evt.payload.unitPath).toBe(
      "/Users/x/Library/LaunchAgents/com.urateam.daemon.plist",
    );
    expect(evt.id).toMatch(/^evt_/);
  });
});

describe("serviceUninstalledEvent", () => {
  it("emits eventType 'service.uninstalled' with platform + unitPath in payload", () => {
    const evt = serviceUninstalledEvent({
      platform: "linux",
      unitPath: "/home/x/.config/systemd/user/urateam.service",
      actor: "cli:x",
    });
    expect(evt.eventType).toBe("service.uninstalled");
    expect(evt.actor).toBe("cli:x");
    expect(evt.actorType).toBe("cli");
    expect(evt.payload.platform).toBe("linux");
    expect(evt.payload.unitPath).toBe(
      "/home/x/.config/systemd/user/urateam.service",
    );
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```
cd packages/core && npx vitest run src/__tests__/audit-events-service.test.ts
```
Expected: FAIL — `serviceInstalledEvent`/`serviceUninstalledEvent` are not exported yet.

- [ ] **Step 4: Implement the builders**

Append to `packages/core/src/audit/events.ts`:

```typescript
/**
 * `ura service install` succeeded — a platform service unit (launchd plist
 * or systemd-user .service) was written and loaded. Emitted opportunistically
 * from the CLI when the daemon DB already exists; never blocks the install.
 */
export function serviceInstalledEvent(args: {
  platform: "darwin" | "linux";
  unitPath: string;
  actor: string;
}): AuditEvent {
  return base({
    eventType: "service.installed",
    actor: args.actor,
    actorType: "cli",
    payload: { platform: args.platform, unitPath: args.unitPath },
  });
}

/**
 * `ura service uninstall` succeeded — the unit file was removed and the
 * service stopped. Counterpart to `serviceInstalledEvent`.
 */
export function serviceUninstalledEvent(args: {
  platform: "darwin" | "linux";
  unitPath: string;
  actor: string;
}): AuditEvent {
  return base({
    eventType: "service.uninstalled",
    actor: args.actor,
    actorType: "cli",
    payload: { platform: args.platform, unitPath: args.unitPath },
  });
}
```

- [ ] **Step 5: Run the test to verify it passes**

```
cd packages/core && npx vitest run src/__tests__/audit-events-service.test.ts
```
Expected: PASS (2 tests).

- [ ] **Step 6: Verify the builders are re-exported**

Check that `@urateam/core`'s barrel exports the new functions. Look at `packages/core/src/audit/index.ts` and `packages/core/src/index.ts`. If the existing event builders (e.g. `configLoadedEvent`) are exported from `@urateam/core`, the new ones will be too once added in the same file. If not, add explicit `export { serviceInstalledEvent, serviceUninstalledEvent } from "./audit/events.js";` to wherever the existing builders are re-exported.

Run:
```
cd packages/core && grep -n "configLoadedEvent\|serviceInstalledEvent" src/audit/index.ts src/index.ts 2>&1
```
Expected: paths where `configLoadedEvent` is exported also export the new functions (transitively via `* from "./audit/events.js"`), or you've added them by hand.

- [ ] **Step 7: Verify the CLAUDE.md audit-count guard fails (proves the test is wired)**

```
cd packages/core && npx vitest run src/__tests__/audit-immutability.test.ts -t "audit-event count"
```
Expected: FAIL — `AuditEventTypeSchema has 47` but `CLAUDE.md says "45 event types"`. (We'll fix this in Task 6.)

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/audit/events.ts \
  packages/core/src/__tests__/audit-events-service.test.ts
git commit -m "feat(audit): add service.installed/uninstalled event types and builders"
```

---

## Task 2: Pure unit-file generators

**Files:**
- Create: `packages/cli/src/lib/service-unit.ts`
- Test: `packages/cli/src/__tests__/service-unit.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/cli/src/__tests__/service-unit.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  renderLaunchdPlist,
  renderSystemdUserUnit,
  type ServiceUnitInput,
} from "../lib/service-unit.js";

const FIXTURE: ServiceUnitInput = {
  binaryPath: "/usr/local/bin/ura",
  urateamHome: "/Users/x/.urateam",
  envFilePath: "/Users/x/.urateam/.env",
  stdoutPath: "/Users/x/.urateam/data/daemon.log",
  stderrPath: "/Users/x/.urateam/data/daemon.err.log",
};

describe("renderLaunchdPlist", () => {
  it("includes the binary path under ProgramArguments", () => {
    const out = renderLaunchdPlist(FIXTURE);
    expect(out).toContain("<string>/usr/local/bin/ura</string>");
    expect(out).toContain("<string>start</string>");
  });

  it("propagates URATEAM_HOME via EnvironmentVariables", () => {
    const out = renderLaunchdPlist(FIXTURE);
    expect(out).toContain("<key>URATEAM_HOME</key>");
    expect(out).toContain("<string>/Users/x/.urateam</string>");
  });

  it("sets RunAtLoad and KeepAlive", () => {
    const out = renderLaunchdPlist(FIXTURE);
    expect(out).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(out).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
  });

  it("emits stdout and stderr log paths", () => {
    const out = renderLaunchdPlist(FIXTURE);
    expect(out).toContain("/Users/x/.urateam/data/daemon.log");
    expect(out).toContain("/Users/x/.urateam/data/daemon.err.log");
  });

  it("starts with the XML declaration", () => {
    expect(renderLaunchdPlist(FIXTURE).startsWith('<?xml version="1.0"')).toBe(
      true,
    );
  });

  it("is deterministic — same input produces byte-for-byte same output", () => {
    expect(renderLaunchdPlist(FIXTURE)).toBe(renderLaunchdPlist(FIXTURE));
  });

  it("matches the canonical snapshot", () => {
    expect(renderLaunchdPlist(FIXTURE)).toMatchSnapshot();
  });
});

describe("renderSystemdUserUnit", () => {
  it("uses simple service type", () => {
    expect(renderSystemdUserUnit(FIXTURE)).toContain("Type=simple");
  });

  it("sets ExecStart to the binary + 'start'", () => {
    expect(renderSystemdUserUnit(FIXTURE)).toContain(
      "ExecStart=/usr/local/bin/ura start",
    );
  });

  it("propagates URATEAM_HOME via Environment", () => {
    const out = renderSystemdUserUnit(FIXTURE);
    expect(out).toContain("Environment=URATEAM_HOME=/Users/x/.urateam");
  });

  it("sets EnvironmentFile to the resolved .env path", () => {
    expect(renderSystemdUserUnit(FIXTURE)).toContain(
      "EnvironmentFile=/Users/x/.urateam/.env",
    );
  });

  it("uses WantedBy=default.target so user-mode systemd picks it up", () => {
    expect(renderSystemdUserUnit(FIXTURE)).toContain("WantedBy=default.target");
  });

  it("sets Restart=always", () => {
    expect(renderSystemdUserUnit(FIXTURE)).toContain("Restart=always");
  });

  it("matches the canonical snapshot", () => {
    expect(renderSystemdUserUnit(FIXTURE)).toMatchSnapshot();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```
cd packages/cli && npx vitest run src/__tests__/service-unit.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the generators**

Create `packages/cli/src/lib/service-unit.ts`:

```typescript
/**
 * Pure unit-file generators for `ura service install`.
 *
 * Both generators are I/O-free string functions so they can be unit-tested
 * without touching the filesystem and so `--dry-run` can print the would-be
 * unit content without mutating anything.
 *
 * The shape mirrors what `deploy/USER_LEVEL_INSTALL.md` previously documented
 * as copy-paste blocks. Anything we want to vary per host (binary path,
 * URATEAM_HOME, log destinations) is parameterized; everything else is
 * baked in.
 */

export interface ServiceUnitInput {
  /** Absolute path to the `ura` binary (e.g. `/usr/local/bin/ura`). */
  binaryPath: string;
  /** Resolved `$URATEAM_HOME` — propagated into the service environment. */
  urateamHome: string;
  /** Path to the `.env` file the daemon should read at startup. */
  envFilePath: string;
  /** Stdout log path (launchd `StandardOutPath` / systemd `StandardOutput`). */
  stdoutPath: string;
  /** Stderr log path (launchd `StandardErrorPath` / systemd `StandardError`). */
  stderrPath: string;
}

const LAUNCHD_LABEL = "com.urateam.daemon";

export function renderLaunchdPlist(opts: ServiceUnitInput): string {
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key>`,
    `  <string>${LAUNCHD_LABEL}</string>`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    `    <string>${opts.binaryPath}</string>`,
    `    <string>start</string>`,
    `  </array>`,
    `  <key>WorkingDirectory</key>`,
    `  <string>${opts.urateamHome}</string>`,
    `  <key>EnvironmentVariables</key>`,
    `  <dict>`,
    `    <key>URATEAM_HOME</key>`,
    `    <string>${opts.urateamHome}</string>`,
    `  </dict>`,
    `  <key>RunAtLoad</key>`,
    `  <true/>`,
    `  <key>KeepAlive</key>`,
    `  <true/>`,
    `  <key>StandardOutPath</key>`,
    `  <string>${opts.stdoutPath}</string>`,
    `  <key>StandardErrorPath</key>`,
    `  <string>${opts.stderrPath}</string>`,
    `</dict>`,
    `</plist>`,
    ``,
  ].join("\n");
}

export function renderSystemdUserUnit(opts: ServiceUnitInput): string {
  return [
    `[Unit]`,
    `Description=urateam user-level daemon`,
    `After=network.target`,
    ``,
    `[Service]`,
    `Type=simple`,
    `WorkingDirectory=${opts.urateamHome}`,
    `EnvironmentFile=${opts.envFilePath}`,
    `Environment=URATEAM_HOME=${opts.urateamHome}`,
    `ExecStart=${opts.binaryPath} start`,
    `StandardOutput=append:${opts.stdoutPath}`,
    `StandardError=append:${opts.stderrPath}`,
    `Restart=always`,
    `RestartSec=5`,
    ``,
    `[Install]`,
    `WantedBy=default.target`,
    ``,
  ].join("\n");
}

/**
 * The launchd Label / systemd unit basename. Exported so the command layer
 * and the tests reference one source of truth.
 */
export const SERVICE_LABEL = LAUNCHD_LABEL;
export const SYSTEMD_UNIT_BASENAME = "urateam.service";
```

- [ ] **Step 4: Run the test to verify it passes (snapshot writes on first run)**

```
cd packages/cli && npx vitest run src/__tests__/service-unit.test.ts
```
Expected: PASS. First run creates the snapshot file; review it manually to confirm the output matches the spec.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/lib/service-unit.ts \
  packages/cli/src/__tests__/service-unit.test.ts \
  packages/cli/src/__tests__/__snapshots__/service-unit.test.ts.snap
git commit -m "feat(cli): pure service-unit generators (launchd + systemd-user)"
```

---

## Task 3: `ura service install` / `ura service uninstall` command (write side)

**Files:**
- Create: `packages/cli/src/commands/service.ts`
- Test: `packages/cli/src/__tests__/service.test.ts`

- [ ] **Step 1: Write the failing test (happy path, dry-run, idempotency, unsupported platform)**

Create `packages/cli/src/__tests__/service.test.ts`:

```typescript
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

// Stub homedir BEFORE importing the command so the command sees our temp path.
let fakeHome: string;
vi.mock("node:os", async () => {
  const actual: any = await vi.importActual("node:os");
  return {
    ...actual,
    homedir: () => fakeHome,
    userInfo: () => ({ username: "tester" }),
  };
});

// Imported AFTER the mocks so the command picks them up.
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
    const plist = join(tmp, "Library", "LaunchAgents", "com.urateam.daemon.plist");
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
    const plist = join(tmp, "Library", "LaunchAgents", "com.urateam.daemon.plist");
    expect(existsSync(plist)).toBe(false);
    const out = spy.mock.calls.flat().join("\n");
    expect(out).toContain("<?xml");
    expect(out).toContain("com.urateam.daemon");
    expect(execFileMock).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("is idempotent: skips when the plist already exists", async () => {
    const plist = join(tmp, "Library", "LaunchAgents", "com.urateam.daemon.plist");
    writeFileSync(plist, "<!-- existing -->");
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await serviceCommand.parseAsync(["install"], { from: "user" });
    expect(readFileSync(plist, "utf8")).toBe("<!-- existing -->");
    expect(spy.mock.calls.flat().join("\n")).toMatch(/already installed/i);
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
    expect(systemctlCalls.some(([, args]) => args.includes("daemon-reload"))).toBe(true);
    expect(
      systemctlCalls.some(
        ([, args]) => args.includes("enable") && args.includes("urateam.service"),
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
    const plist = join(tmp, "Library", "LaunchAgents", "com.urateam.daemon.plist");
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
```

- [ ] **Step 2: Run the test to verify it fails**

```
cd packages/cli && npx vitest run src/__tests__/service.test.ts
```
Expected: FAIL — `service.js` not found.

- [ ] **Step 3: Implement the command**

Create `packages/cli/src/commands/service.ts`:

```typescript
/**
 * `ura service install` / `ura service uninstall`
 *
 * Generates a platform-appropriate service unit (launchd plist on macOS,
 * systemd-user unit on Linux) so the user-level daemon auto-starts on login.
 * Mirrors what `deploy/USER_LEVEL_INSTALL.md` previously documented as
 * copy-paste blocks.
 *
 * Idempotent: refuses to overwrite an existing unit. Operators reinstall by
 * running `ura service uninstall` first. `--dry-run` prints the unit content
 * without touching the filesystem.
 */
import { Command } from "commander";
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  renderLaunchdPlist,
  renderSystemdUserUnit,
  SERVICE_LABEL,
  SYSTEMD_UNIT_BASENAME,
  type ServiceUnitInput,
} from "../lib/service-unit.js";
import {
  resolveUserLevelHome,
  userLevelDataDir,
} from "../lib/user-level-config.js";

const execFileP = promisify(execFile);

type Platform = "darwin" | "linux";

function detectPlatform(): Platform {
  if (process.platform === "darwin") return "darwin";
  if (process.platform === "linux") return "linux";
  throw new Error(
    `ura service: unsupported platform '${process.platform}'. ` +
      `Only macOS (launchd) and Linux (systemd-user) are supported. ` +
      `For other platforms, see the manual service-setup snippets in ` +
      `deploy/USER_LEVEL_INSTALL.md.`,
  );
}

function unitPath(platform: Platform): string {
  if (platform === "darwin") {
    return join(
      homedir(),
      "Library",
      "LaunchAgents",
      `${SERVICE_LABEL}.plist`,
    );
  }
  return join(homedir(), ".config", "systemd", "user", SYSTEMD_UNIT_BASENAME);
}

function buildInput(): ServiceUnitInput {
  // Resolve the binary the operator invoked us as — this is what the service
  // unit should re-launch. process.execPath is `node`; process.argv[1] is the
  // `ura` script. We prefer argv[1] when it's an absolute path; otherwise we
  // fall back to the common npm-global location.
  let binaryPath = process.argv[1] ?? "/usr/local/bin/ura";
  if (!binaryPath.startsWith("/")) binaryPath = "/usr/local/bin/ura";
  const home = resolveUserLevelHome();
  return {
    binaryPath,
    urateamHome: home,
    envFilePath: join(home, ".env"),
    stdoutPath: join(userLevelDataDir(), "daemon.log"),
    stderrPath: join(userLevelDataDir(), "daemon.err.log"),
  };
}

async function tryEmitAuditEvent(args: {
  eventType: "installed" | "uninstalled";
  platform: Platform;
  unitPath: string;
}): Promise<void> {
  // Opportunistic: only write when the daemon DB already exists. CLI commands
  // run before the daemon has ever started, so the DB may not exist yet.
  // Never throw — audit failure must not break the install.
  try {
    const dbPath = join(userLevelDataDir(), "urateam.db");
    if (!existsSync(dbPath)) return;
    const {
      createDb,
      logAuditEventUnchecked,
      serviceInstalledEvent,
      serviceUninstalledEvent,
    } = await import("@urateam/core");
    const db = await createDb(`file:${dbPath}`);
    const actor = `cli:${userInfo().username ?? "unknown"}`;
    const evt =
      args.eventType === "installed"
        ? serviceInstalledEvent({
            platform: args.platform,
            unitPath: args.unitPath,
            actor,
          })
        : serviceUninstalledEvent({
            platform: args.platform,
            unitPath: args.unitPath,
            actor,
          });
    await logAuditEventUnchecked(db, evt);
  } catch {
    // Audit must never crash the install — swallow.
  }
}

export const serviceCommand = new Command("service").description(
  "Manage the urateam launchd/systemd service unit",
);

serviceCommand
  .command("install")
  .description(
    "Install the platform service unit (launchd on macOS, systemd-user on Linux)",
  )
  .option("--dry-run", "Print the unit content; do not write or load it")
  .action(async (opts: { dryRun?: boolean }) => {
    const platform = detectPlatform();
    const input = buildInput();
    const dest = unitPath(platform);
    const content =
      platform === "darwin"
        ? renderLaunchdPlist(input)
        : renderSystemdUserUnit(input);

    if (opts.dryRun) {
      console.log(`# Would write: ${dest}`);
      console.log(content);
      return;
    }

    if (existsSync(dest)) {
      console.log(
        `ura service install: ${dest} already exists. ` +
          `Run 'ura service uninstall' first if you want to reinstall.`,
      );
      return;
    }

    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content);

    if (platform === "darwin") {
      await execFileP("launchctl", ["load", "-w", dest]);
      await execFileP("launchctl", ["start", SERVICE_LABEL]);
    } else {
      await execFileP("systemctl", ["--user", "daemon-reload"]);
      await execFileP("systemctl", [
        "--user",
        "enable",
        "--now",
        SYSTEMD_UNIT_BASENAME,
      ]);
    }

    console.log(`ura service install: wrote ${dest} and started the service.`);
    await tryEmitAuditEvent({
      eventType: "installed",
      platform,
      unitPath: dest,
    });
  });

serviceCommand
  .command("uninstall")
  .description("Remove the platform service unit and stop the service")
  .action(async () => {
    const platform = detectPlatform();
    const dest = unitPath(platform);

    if (!existsSync(dest)) {
      console.log(`ura service uninstall: ${dest} not installed — nothing to remove.`);
      return;
    }

    if (platform === "darwin") {
      // Best-effort stop; tolerate "not loaded" errors.
      try {
        await execFileP("launchctl", ["unload", "-w", dest]);
      } catch {
        /* unit may have been unloaded already */
      }
    } else {
      try {
        await execFileP("systemctl", [
          "--user",
          "disable",
          "--now",
          SYSTEMD_UNIT_BASENAME,
        ]);
      } catch {
        /* unit may have been disabled already */
      }
    }

    rmSync(dest, { force: true });
    console.log(`ura service uninstall: removed ${dest}.`);
    await tryEmitAuditEvent({
      eventType: "uninstalled",
      platform,
      unitPath: dest,
    });
  });
```

- [ ] **Step 4: Run the test to verify it passes**

```
cd packages/cli && npx vitest run src/__tests__/service.test.ts
```
Expected: PASS (all describes — darwin install x3, linux install, unsupported, darwin uninstall x2).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/service.ts \
  packages/cli/src/__tests__/service.test.ts
git commit -m "feat(cli): ura service install/uninstall for launchd + systemd-user"
```

---

## Task 4: Register command in CLI entry

**Files:**
- Modify: `packages/cli/src/index.ts`

- [ ] **Step 1: Wire the command into the program**

Open `packages/cli/src/index.ts`. Add the import alongside the other command imports:

```typescript
import { serviceCommand } from "./commands/service.js";
```

Add the registration alongside the other `program.addCommand(...)` lines:

```typescript
program.addCommand(serviceCommand);
```

- [ ] **Step 2: Smoke-test the binding via `--help`**

```
cd packages/cli && pnpm build
node dist/index.js service --help
```
Expected: prints subcommand listing (`install`, `uninstall`).

```
node dist/index.js service install --help
```
Expected: prints `--dry-run` and usage line.

- [ ] **Step 3: Commit**

```bash
git add packages/cli/src/index.ts
git commit -m "feat(cli): register 'ura service' command"
```

---

## Task 5: Update CLAUDE.md (audit count + new command)

**Files:**
- Modify: `CLAUDE.md` (line 223 — the event-types sentence)
- Modify: `.claude/CLAUDE.md` (short line under PM Agent / Key Patterns area)

- [ ] **Step 1: Bump the audit-event count and append the two new types**

In `CLAUDE.md`, find the line beginning with `- 45 event types (canonical list in ...`. Change `45 event types` to `47 event types`, and append the two new entries to the canonical list. The Tier 1d test (`audit-immutability.test.ts`) enforces the count exactly.

Use Edit to change just the relevant clause. Before:
```
…`pipeline.{scratch_files_blocked,typecheck_failed,spec_vs_impl_failed,auto_deep_review_bumped}` (Tiers 1a, 1b, 1c, 3). Tier 1d adds a unit test…
```
After:
```
…`pipeline.{scratch_files_blocked,typecheck_failed,spec_vs_impl_failed,auto_deep_review_bumped}` (Tiers 1a, 1b, 1c, 3), `service.{installed,uninstalled}`. Tier 1d adds a unit test…
```

And change `45 event types` → `47 event types` on the same line.

- [ ] **Step 2: Add a `ura service install` section to CLAUDE.md**

Insert under the existing user-level install description (search for `Project-level (sidecar) install stays env-var-driven`). Add a paragraph:

```markdown
- `ura service install` / `ura service uninstall` (`packages/cli/src/commands/service.ts`): generates a launchd plist (macOS) or systemd-user unit (Linux) so the user-level daemon auto-starts on login. Pure unit-file generators in `packages/cli/src/lib/service-unit.ts` (`renderLaunchdPlist`, `renderSystemdUserUnit`) are I/O-free; the command writes them to `~/Library/LaunchAgents/com.urateam.daemon.plist` or `~/.config/systemd/user/urateam.service` and invokes `launchctl load -w` / `systemctl --user daemon-reload + enable --now`. Idempotent (refuses to overwrite an existing unit; uninstall first). `--dry-run` prints the unit content without touching the filesystem. Audit events `service.installed` / `service.uninstalled` are emitted opportunistically from the CLI (only when the daemon DB already exists; CLI runs that pre-date `ura start` skip the write). Unsupported platforms (Windows, BSD) fail with a clear message pointing at the manual snippets.
```

- [ ] **Step 3: One-liner in `.claude/CLAUDE.md`**

Search for the existing `ura init` / `ura repo add` mentions in `.claude/CLAUDE.md`. Add the `ura service install` line alongside it (one bullet, terse).

- [ ] **Step 4: Verify the Tier 1d guard passes**

```
cd packages/core && npx vitest run src/__tests__/audit-immutability.test.ts -t "audit-event count"
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md .claude/CLAUDE.md
git commit -m "docs(claude-md): bump audit-event count to 47 and document ura service install"
```

---

## Task 6: Update `deploy/USER_LEVEL_INSTALL.md`

**Files:**
- Modify: `deploy/USER_LEVEL_INSTALL.md`

- [ ] **Step 1: Rewrite the "Running as a service" section**

Replace the macOS + Linux + pm2 subsections with a single section that leads with `ura service install`. Demote the manual unit-file snippets to a collapsed "If you want to write the unit by hand" subsection so operators can still see the raw shape if needed.

Replace section content (search for `## Running as a service`) with:

```markdown
## Running as a service

`ura start` runs in the foreground. For an always-on install, use `ura service install`:

```bash
# macOS (launchd) or Linux (systemd-user) — auto-detected
ura service install
```

This writes a platform service unit and starts the daemon:

- **macOS:** `~/Library/LaunchAgents/com.urateam.daemon.plist` + `launchctl load -w`
- **Linux:** `~/.config/systemd/user/urateam.service` + `systemctl --user enable --now`

It's idempotent: re-running on an existing install prints "already installed" and exits 0. `--dry-run` prints the unit content without writing or loading.

Reverse with:

```bash
ura service uninstall
```

Audit events `service.installed` and `service.uninstalled` are recorded when the daemon DB exists.

### Manual setup (other platforms or custom paths)

If you need to write the unit by hand (Windows, BSD, custom log destinations) — see the snippets below; copy and adjust as needed.

<details>
<summary>macOS — launchd (manual)</summary>

[existing plist snippet, unchanged]

</details>

<details>
<summary>Linux — systemd user service (manual)</summary>

[existing unit snippet, unchanged]

</details>

<details>
<summary>pm2 (any platform)</summary>

```bash
pm2 start ura --name urateam -- start
pm2 save
pm2 startup
```

</details>
```

Preserve the existing plist/unit/pm2 snippets verbatim inside `<details>` blocks so operators don't lose them.

- [ ] **Step 2: Update the "What's deferred" section**

Remove the bullet `Service-unit generators (\`ura service install\`) for launchd / systemd.` — that's now shipped.

- [ ] **Step 3: Verify with a markdown linter or eye-check**

```
cd /private/tmp/urateam-work && head -250 deploy/USER_LEVEL_INSTALL.md
```
Eye-check: the new section is well-formed, snippets are intact, the deferred list no longer mentions service generators.

- [ ] **Step 4: Commit**

```bash
git add deploy/USER_LEVEL_INSTALL.md
git commit -m "docs(deploy): lead service section with 'ura service install'"
```

---

## Task 7: Full test sweep + typecheck

- [ ] **Step 1: Run the full CLI test suite**

```
pnpm --filter @urateam/cli test
```
Expected: PASS — including the new service / service-unit tests, with no regressions in init/repo/uninstall/start.

- [ ] **Step 2: Run the core test suite**

```
pnpm --filter @urateam/core test
```
Expected: PASS — including the audit-immutability count check and the new builder tests.

- [ ] **Step 3: Run the workspace-wide typecheck**

```
pnpm -w typecheck
```
Expected: clean.

- [ ] **Step 4: Build everything**

```
pnpm build
```
Expected: clean (turborepo will re-emit cli, core, dashboard, observers).

- [ ] **Step 5: Smoke-test the dry-run end-to-end (local environment)**

```
URATEAM_HOME=/tmp/ura-smoke-svc node packages/cli/dist/index.js service install --dry-run
```
Expected: prints a plist (on macOS) or a systemd unit (on Linux) referencing `/tmp/ura-smoke-svc`. No filesystem mutation outside `/tmp/ura-smoke-svc`.

```
URATEAM_HOME=/tmp/ura-smoke-svc node packages/cli/dist/index.js service install --help
```
Expected: prints `--dry-run` option help.

---

## Task 8: Open PR + Sonnet review

- [ ] **Step 1: Push the branch**

```bash
git push -u origin feat/service-install
```

- [ ] **Step 2: Open the PR with the convention self-review checklist**

```bash
gh pr create --title "feat(cli): ura service install/uninstall for launchd + systemd-user" \
  --body "$(cat <<'EOF'
## Summary

Adds `ura service install` and `ura service uninstall` so operators no longer have to copy-paste plist/unit files from the docs. Auto-detects platform (macOS → launchd, Linux → systemd-user), other platforms fail with a clear message.

## How it works

- Pure unit-file generators in `packages/cli/src/lib/service-unit.ts` (`renderLaunchdPlist`, `renderSystemdUserUnit`) are I/O-free and snapshot-tested.
- `packages/cli/src/commands/service.ts` resolves the binary path, writes the unit to the platform-specific location (`~/Library/LaunchAgents/com.urateam.daemon.plist` or `~/.config/systemd/user/urateam.service`), and runs `launchctl load -w` or `systemctl --user daemon-reload + enable --now`.
- Idempotent: refuses to overwrite an existing unit, prints "already installed".
- `--dry-run` prints the unit content without touching the filesystem.
- Audit events `service.installed` / `service.uninstalled` are emitted opportunistically (only when the daemon DB already exists).

## Tests

- Pure generator tests with deterministic + snapshot assertions (`service-unit.test.ts`).
- Command tests with mocked `execFile` covering: darwin happy path, dry-run, idempotent skip, linux happy path, unsupported platform, uninstall happy path, uninstall no-op (`service.test.ts`).
- New audit-event-builder tests (`audit-events-service.test.ts`).
- Updated CLAUDE.md count from 45 → 47 (Tier 1d guard enforces this).

## Convention self-review

- [x] **scratch-files** — no `.bak`/`TEST_*.md`/etc. added.
- [x] **db-ddl-drift** — no schema changes.
- [x] **audit-bypass-undocumented** — uses `logAuditEventUnchecked` (CLI is a base-tier surface that must record installs regardless of audit-log licensing). Documented in the function-level JSDoc and in the writer's existing allow-list comment.
- [x] **credential-in-interface** — no credentials anywhere.
- [x] **spec-vs-impl** — every JSDoc reference is to a real field; new generators are self-documenting.
- [x] **convention-execfile** — uses `execFile` (never `exec`).
- [x] **convention-console** — CLI surface uses `console.log` (matches existing init/repo/uninstall pattern); no daemon logging is touched.
- [x] **convention-throw** — uses Commander's standard error-throw flow for unsupported platforms.
- [x] **convention-as-any** — no new `as any` casts.

Closes the deferred bullet in `deploy/USER_LEVEL_INSTALL.md` ("Service-unit generators").

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Dispatch a Sonnet code-reviewer agent on the branch**

Use the `Agent` tool with `subagent_type: "feature-dev:code-reviewer"`, `model: "sonnet"`, and the following brief:

> You are reviewing PR feat/service-install in `/private/tmp/urateam-work`. The change adds `ura service install` and `ura service uninstall` plus two audit-event types. Spec: `docs/superpowers/plans/2026-05-12-service-install.md`.
>
> Files changed: `packages/cli/src/{commands/service.ts,lib/service-unit.ts,index.ts}`, `packages/cli/src/__tests__/{service,service-unit,audit-events-service}.test.ts`, `packages/core/src/{types.ts,audit/events.ts}`, `CLAUDE.md`, `.claude/CLAUDE.md`, `deploy/USER_LEVEL_INSTALL.md`.
>
> Check, with severities BLOCKING / WARNING / SUGGESTION:
> 1. Idempotency claims hold — install on an already-installed system MUST NOT mutate state.
> 2. `execFile` is used (never `exec`).
> 3. No credentials, no tokens, no PII in the audit-event payload.
> 4. The audit-event count in CLAUDE.md (`47 event types`) matches `AuditEventTypeSchema.options.length` (47).
> 5. Unit-file generator output looks correct for launchd + systemd-user (parse the snapshots).
> 6. The unsupported-platform error is informative enough for an operator to know what to do.
> 7. `--dry-run` does not invoke `execFile`.
> 8. No `as any` introduced.
> 9. The opportunistic audit-write path NEVER throws — it must be a no-op when the DB doesn't exist.
> 10. Tests are deterministic (no timing, no real network, no real subprocess).
>
> Finish with `VERDICT: READY TO MERGE` or `VERDICT: REQUIRES CHANGES` and a list of BLOCKING / WARNING / SUGGESTION findings.

Address every BLOCKING finding before pushing the PR out of draft (initially open as Ready For Review since this is a small change; if BLOCKING findings appear, switch to draft via `gh pr ready --undo`, fix, then `gh pr ready`).

- [ ] **Step 4: Watch CI**

```
gh pr checks <pr-number> --watch
```
Expected: all green.

- [ ] **Step 5: Merge**

```
gh pr merge <pr-number> --squash --admin --delete-branch
```

---

## Task 9: Release v0.1.53 + npm publish + GitHub release

- [ ] **Step 1: Pull main**

```
git checkout main && git pull --ff-only origin main
```

- [ ] **Step 2: Cut the patch release**

```
pnpm cut-release patch
```
This will create `release/v0.1.53` branch with version bumps + a CHANGELOG `<!-- TODO -->` placeholder.

- [ ] **Step 3: Fill in the CHANGELOG entry**

Edit `CHANGELOG.md` — replace the `<!-- TODO -->` block with:

```markdown
## 0.1.53 — 2026-05-12

### Added
- `ura service install` and `ura service uninstall` — generate and install a launchd plist (macOS) or systemd-user unit (Linux) so the user-level daemon auto-starts on login. `--dry-run` prints the unit content without touching the filesystem. Idempotent: refuses to overwrite an existing install. Two new audit-event types (`service.installed`, `service.uninstalled`).
```

Amend the cut-release commit:

```
git add CHANGELOG.md && git commit --amend --no-edit
```

- [ ] **Step 4: Push and open the release PR**

```
git push -u origin release/v0.1.53
gh pr create --title "chore(release): v0.1.53" --body "Release v0.1.53. See CHANGELOG.md."
```

- [ ] **Step 5: Wait for CI and merge**

```
gh pr checks <pr-number> --watch
gh pr merge <pr-number> --squash --admin --delete-branch
```

- [ ] **Step 6: Tag and push (triggers npm-publish workflow)**

```
git checkout main && git pull --ff-only origin main
git tag v0.1.53
git push origin v0.1.53
```

- [ ] **Step 7: Watch the publish workflow**

```
gh run watch
```
Expected: the npm-publish workflow completes successfully.

- [ ] **Step 8: Create the GitHub Release**

```
gh release create v0.1.53 --title "0.1.53 — ura service install" --notes "$(cat <<'EOF'
## Highlights

- `ura service install` and `ura service uninstall` — generate and install a launchd plist (macOS) or systemd-user unit (Linux) so the user-level daemon auto-starts on login.
- Auto-detects platform (macOS / Linux). Other platforms fail with a clear pointer to the manual snippets in `deploy/USER_LEVEL_INSTALL.md`.
- `--dry-run` prints the unit content without writing.
- Idempotent — re-running on an existing install is a no-op.

## Quick start

```bash
npm install -g @urateam/cli@0.1.53
ura init
ura service install            # macOS or Linux — auto-detected
ura service install --dry-run  # inspect first
```

## Audit events

Two new event types — `service.installed`, `service.uninstalled` (CLAUDE.md bumped to 47).
EOF
)"
```

---

## Task 10: Local smoke test

- [ ] **Step 1: Fresh install + smoke test on local machine**

```
npm uninstall -g @urateam/cli && npm install -g @urateam/cli@0.1.53
rm -rf /tmp/ura-smoke-svc && URATEAM_HOME=/tmp/ura-smoke-svc ura init
URATEAM_HOME=/tmp/ura-smoke-svc ura service install --dry-run
```
Expected: a plist printed (macOS) or systemd unit printed (Linux), referencing `/tmp/ura-smoke-svc`. No filesystem mutation outside that directory.

- [ ] **Step 2: Document the smoke-test result in the PR description**

```
gh pr comment <pr-number> --body "Smoke test on macOS: \`ura service install --dry-run\` printed the plist correctly; no filesystem mutation."
```

---

## Self-review checklist (run before pushing)

- **Spec coverage:** Every requirement in the operator brief's Feature 1 spec — `ura service install` + `ura service uninstall`, platform auto-detection (darwin / linux / unsupported-error), idempotency, `--dry-run`, audit events, CLAUDE.md count bump, doc rewrite — is covered by a task above.
- **Placeholder scan:** no TODOs in the plan; every code snippet is concrete.
- **Type consistency:** `ServiceUnitInput` shape used in Task 2 matches the parameters consumed by Task 3's `buildInput()` / `renderLaunchdPlist` / `renderSystemdUserUnit`. Audit event builder shapes from Task 1 (`{platform, unitPath, actor}`) match Task 3's `tryEmitAuditEvent` invocation.
