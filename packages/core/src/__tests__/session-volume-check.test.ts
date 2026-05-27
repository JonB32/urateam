import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkSessionVolume } from "../pipeline/session-volume-check.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vol-check-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("checkSessionVolume (BEC-227)", () => {
  it("writeable persistent dir → returns ok", () => {
    const result = checkSessionVolume({ projectsDir: dir });
    expect(result.ok).toBe(true);
  });

  it("nonexistent dir → returns not-found", () => {
    const result = checkSessionVolume({
      projectsDir: "/totally/not/a/real/path/asdf",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("not-found");
    }
  });
});
