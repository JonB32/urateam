/**
 * Pure unit-file generators for `ura service install`.
 *
 * Both generators are I/O-free string functions so they can be unit-tested
 * without touching the filesystem and so `--dry-run` can print the would-be
 * unit content without mutating anything. The shape mirrors what
 * `deploy/USER_LEVEL_INSTALL.md` previously documented as copy-paste blocks.
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

export const SERVICE_LABEL = LAUNCHD_LABEL;
export const SYSTEMD_UNIT_BASENAME = "urateam.service";
