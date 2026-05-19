import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { transcriptPath, transcriptExists } from "../executor/session-store.js";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "urateam-session-store-test-"));
});
afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("session-store (BEC-227)", () => {
  it("transcriptPath builds the expected per-cwd / per-session path", () => {
    const p = transcriptPath({
      projectsRoot: tmpRoot,
      cwd: "/home/ura/data/runs/abc/worktree",
      sessionId: "uuid-1",
    });
    // Per SDK convention: projectsRoot / <encoded-cwd> / <sessionId>.jsonl
    expect(p).toMatch(/uuid-1\.jsonl$/);
    expect(p).toContain(tmpRoot);
  });

  it("transcriptExists returns true when the JSONL file is present", () => {
    const dir = join(tmpRoot, "encoded-cwd");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "uuid-1.jsonl"), '{"message":"hi"}\n');
    const exists = transcriptExists({
      projectsRoot: tmpRoot,
      cwd: "/encoded-cwd",
      sessionId: "uuid-1",
    });
    expect(exists).toBe(true);
  });

  it("transcriptExists returns false when missing", () => {
    const exists = transcriptExists({
      projectsRoot: tmpRoot,
      cwd: "/nonexistent",
      sessionId: "uuid-missing",
    });
    expect(exists).toBe(false);
  });
});
