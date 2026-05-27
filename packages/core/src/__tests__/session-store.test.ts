import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
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

describe("session-store (BEC-227 + BEC-232)", () => {
  it("transcriptPath builds the SDK's leading-dash encoding for absolute cwds (BEC-232)", () => {
    const p = transcriptPath({
      projectsRoot: tmpRoot,
      cwd: "/home/ura/data/runs/abc/worktree",
      sessionId: "uuid-1",
    });
    // BEC-232: leading "/" is replaced with "-", not stripped. Matches the
    // SDK's actual on-disk path: <projectsRoot>/-home-ura-...-worktree/<id>.jsonl
    expect(p).toBe(
      join(tmpRoot, "-home-ura-data-runs-abc-worktree", "uuid-1.jsonl"),
    );
  });

  it("transcriptExists returns true when the JSONL file is at the SDK-encoded path", () => {
    // Place the file where the SDK would actually write it (leading-dash dir).
    const dir = join(tmpRoot, "-home-ura-data-runs-abc-worktree");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "uuid-1.jsonl"), '{"message":"hi"}\n');
    const exists = transcriptExists({
      projectsRoot: tmpRoot,
      cwd: "/home/ura/data/runs/abc/worktree",
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

  it("regression (BEC-232): the OLD no-leading-dash path is NOT what we look up", () => {
    // If anyone places a JSONL at the pre-BEC-232 (incorrect) location,
    // transcriptExists() should NOT find it — the fix is unconditional, not
    // a fallback-to-old-path behavior.
    const wrongDir = join(tmpRoot, "home-ura-data-runs-abc-worktree");
    mkdirSync(wrongDir, { recursive: true });
    writeFileSync(join(wrongDir, "uuid-1.jsonl"), '{"message":"hi"}\n');
    const exists = transcriptExists({
      projectsRoot: tmpRoot,
      cwd: "/home/ura/data/runs/abc/worktree",
      sessionId: "uuid-1",
    });
    expect(exists).toBe(false);
  });
});
