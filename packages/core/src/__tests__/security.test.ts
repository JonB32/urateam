import { describe, it, expect } from "vitest";
import {
  SECURITY_REVIEW_CHECKLIST,
  REVIEW_OUTPUT_FORMAT,
} from "../security/review-checklist.js";
import { createSandboxConfig } from "../security/sandbox.js";

describe("SECURITY_REVIEW_CHECKLIST", () => {
  it("contains INJECTION VULNERABILITIES category", () => {
    expect(SECURITY_REVIEW_CHECKLIST).toContain("INJECTION VULNERABILITIES");
  });

  it("contains AUTHENTICATION & AUTHORIZATION category", () => {
    expect(SECURITY_REVIEW_CHECKLIST).toContain(
      "AUTHENTICATION & AUTHORIZATION",
    );
  });

  it("contains DATA EXPOSURE category", () => {
    expect(SECURITY_REVIEW_CHECKLIST).toContain("DATA EXPOSURE");
  });

  it("contains DEPENDENCY SAFETY category", () => {
    expect(SECURITY_REVIEW_CHECKLIST).toContain("DEPENDENCY SAFETY");
  });

  it("REVIEW_OUTPUT_FORMAT describes JSON output", () => {
    expect(REVIEW_OUTPUT_FORMAT).toContain("JSON");
    expect(REVIEW_OUTPUT_FORMAT).toContain("severity");
  });
});

describe("createSandboxConfig", () => {
  it("creates config with run-specific workdir", () => {
    const config = createSandboxConfig("run-abc123");
    expect(config.workdir).toBe("/var/agent-runs/run-abc123/worktree");
  });

  it("includes all allowlisted domains", () => {
    const config = createSandboxConfig("run-1");
    expect(config.allowedDomains).toContain("github.com");
    expect(config.allowedDomains).toContain("api.linear.app");
    expect(config.allowedDomains).toContain("mcp.linear.app");
    expect(config.allowedDomains).toContain("registry.npmjs.org");
    expect(config.allowedDomains).toContain("pypi.org");
  });

  it("includes deny paths for read", () => {
    const config = createSandboxConfig("run-1");
    expect(config.denyRead).toContain("~/.ssh/*");
    expect(config.denyRead).toContain("~/.aws/*");
    expect(config.denyRead).toContain("/etc/shadow");
    expect(config.denyRead).toContain("~/.claude/*");
  });

  it("includes deny paths for write", () => {
    const config = createSandboxConfig("run-1");
    expect(config.denyWrite).toContain("/etc/*");
    expect(config.denyWrite).toContain("~/.claude/*");
  });

  it("supports custom baseDir", () => {
    const config = createSandboxConfig("run-xyz", "/tmp/sandbox");
    expect(config.workdir).toBe("/tmp/sandbox/run-xyz/worktree");
  });
});
