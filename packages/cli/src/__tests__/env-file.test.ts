import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { upsertEnvFile, readEnvFile } from "../lib/env-file.js";

describe("upsertEnvFile", () => {
  let tmp: string;
  let path: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ura-env-"));
    path = join(tmp, ".env");
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("creates the file when it does not exist", () => {
    upsertEnvFile(path, { LINEAR_API_KEY: "lin_oauth_abc" });
    const raw = readFileSync(path, "utf8");
    expect(raw).toContain("LINEAR_API_KEY=lin_oauth_abc");
  });

  it("merges into an existing file preserving unrelated keys", () => {
    writeFileSync(
      path,
      [
        "ANTHROPIC_API_KEY=sk-ant-xyz",
        "DASHBOARD_USER=admin",
        "LINEAR_API_KEY=lin_api_old",
        "",
      ].join("\n"),
    );
    upsertEnvFile(path, { LINEAR_API_KEY: "lin_oauth_new" });
    const raw = readFileSync(path, "utf8");
    expect(raw).toContain("ANTHROPIC_API_KEY=sk-ant-xyz");
    expect(raw).toContain("DASHBOARD_USER=admin");
    expect(raw).toContain("LINEAR_API_KEY=lin_oauth_new");
    expect(raw).not.toContain("lin_api_old");
  });

  it("preserves comments and blank lines around modified keys", () => {
    writeFileSync(
      path,
      [
        "# Linear",
        "",
        "LINEAR_API_KEY=lin_api_old",
        "# Anthropic",
        "ANTHROPIC_API_KEY=sk-ant-xyz",
        "",
      ].join("\n"),
    );
    upsertEnvFile(path, { LINEAR_API_KEY: "lin_oauth_new" });
    const raw = readFileSync(path, "utf8");
    expect(raw).toMatch(/^# Linear/m);
    expect(raw).toMatch(/^# Anthropic/m);
  });

  it("appends new keys at the end when not already present", () => {
    writeFileSync(path, "ANTHROPIC_API_KEY=sk-ant-xyz\n");
    upsertEnvFile(path, { LINEAR_API_KEY: "lin_oauth_new" });
    const lines = readFileSync(path, "utf8").split("\n");
    const idx = lines.findIndex((l) => l.startsWith("LINEAR_API_KEY="));
    const anthropicIdx = lines.findIndex((l) =>
      l.startsWith("ANTHROPIC_API_KEY="),
    );
    expect(idx).toBeGreaterThan(anthropicIdx);
  });

  it("can upsert multiple keys in one call", () => {
    upsertEnvFile(path, {
      LINEAR_API_KEY: "lin_oauth_new",
      LINEAR_WORKSPACE_ID: "ws_abc",
    });
    const raw = readFileSync(path, "utf8");
    expect(raw).toContain("LINEAR_API_KEY=lin_oauth_new");
    expect(raw).toContain("LINEAR_WORKSPACE_ID=ws_abc");
  });

  it("leaves no .env.tmp behind after a successful upsert", () => {
    upsertEnvFile(path, { LINEAR_API_KEY: "lin_oauth_new" });
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });
});

describe("readEnvFile", () => {
  let tmp: string;
  let path: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ura-env-"));
    path = join(tmp, ".env");
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns an empty object when the file is absent", () => {
    expect(readEnvFile(path)).toEqual({});
  });

  it("parses KEY=value lines, ignoring comments and blanks", () => {
    writeFileSync(
      path,
      ["# comment", "", "FOO=bar", "BAZ=qux quux"].join("\n"),
    );
    expect(readEnvFile(path)).toEqual({ FOO: "bar", BAZ: "qux quux" });
  });
});
