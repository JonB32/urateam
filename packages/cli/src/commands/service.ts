/**
 * `ura service install` / `ura service uninstall`
 *
 * Generates a platform-appropriate service unit (launchd plist on macOS,
 * systemd-user unit on Linux) so the user-level daemon auto-starts on login.
 * Mirrors what `deploy/USER_LEVEL_INSTALL.md` previously documented as
 * copy-paste blocks. Idempotent: refuses to overwrite an existing unit
 * (operator must uninstall first). `--dry-run` prints the unit content
 * without touching the filesystem.
 */
import { Command } from "commander";
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
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
  createDb,
  logAuditEvent,
  serviceInstalledEvent,
  serviceUninstalledEvent,
} from "@urateam/core";
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
  // Resolve the binary the operator invoked us as — that's what the service
  // unit should re-launch. `process.argv[1]` is the `ura` script (commander's
  // entry point); it's already absolute when invoked via the npm-installed
  // shim. Fall back to the common npm-global location if anything looks off.
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
  // Opportunistic: only writes when the daemon DB already exists. CLI commands
  // can run before the daemon has ever started, so the DB may not be there
  // yet. Never throws — audit failure must not break the install.
  try {
    const dbPath = join(userLevelDataDir(), "urateam.db");
    if (!existsSync(dbPath)) return;
    const db = await createDb({ connectionString: dbPath });
    const actor = `cli:${userInfo().username ?? "unknown"}`;
    const builder =
      args.eventType === "installed"
        ? serviceInstalledEvent
        : serviceUninstalledEvent;
    const evt = builder({
      platform: args.platform,
      unitPath: args.unitPath,
      actor,
    });
    // License-gated path — `logAuditEvent` is a no-op when `audit-log` is
    // unlicensed. Service-install events are an Enterprise-tier operational
    // signal; OSS / Pro deployments simply drop them.
    await logAuditEvent(db, evt);
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
      console.log(
        `ura service uninstall: ${dest} not installed — nothing to remove.`,
      );
      return;
    }

    if (platform === "darwin") {
      try {
        await execFileP("launchctl", ["unload", "-w", dest]);
      } catch {
        // unit may have been unloaded already — best-effort stop
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
        // unit may have been disabled already — best-effort stop
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
