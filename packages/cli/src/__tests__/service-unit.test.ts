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
