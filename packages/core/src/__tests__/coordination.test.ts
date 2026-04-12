import { describe, it, expect, afterEach, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { unlinkSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createDb } from "../db/index.js";
import {
  upsertActiveWork,
  removeActiveWork,
  checkFileOverlap,
  getActiveWork,
  getModifiedFiles,
} from "../pm/coordination.js";

function tmpDbPath(): string {
  const id = randomBytes(8).toString("hex");
  return `/tmp/laf-coord-test-${id}.sqlite`;
}

describe("coordination", () => {
  const paths: string[] = [];

  async function makeDb() {
    const path = tmpDbPath();
    paths.push(path);
    return createDb({ driver: "sqlite", connectionString: path });
  }

  afterEach(() => {
    for (const p of paths) {
      try { unlinkSync(p); } catch { /* ignore */ }
      try { unlinkSync(p + "-wal"); } catch { /* ignore */ }
      try { unlinkSync(p + "-shm"); } catch { /* ignore */ }
    }
    paths.length = 0;
  });

  describe("upsertActiveWork", () => {
    it("inserts a new active work entry", async () => {
      const db = await makeDb() as any;

      await upsertActiveWork(db, {
        runId: "run-1",
        issueId: "BEC-10",
        stage: "implement",
        filesModified: ["src/auth/login.ts"],
      });

      const entries = await getActiveWork(db);
      expect(entries).toHaveLength(1);
      expect(entries[0].runId).toBe("run-1");
      expect(entries[0].issueId).toBe("BEC-10");
      expect(entries[0].stage).toBe("implement");
      expect(entries[0].filesModified).toEqual(["src/auth/login.ts"]);
    });

    it("updates an existing entry when called again with the same runId", async () => {
      const db = await makeDb() as any;

      await upsertActiveWork(db, {
        runId: "run-2",
        issueId: "BEC-11",
        stage: "implement",
        filesModified: ["src/auth/login.ts"],
      });

      await upsertActiveWork(db, {
        runId: "run-2",
        issueId: "BEC-11",
        stage: "test",
        filesModified: ["src/auth/login.ts", "src/auth/login.test.ts"],
      });

      const entries = await getActiveWork(db);
      expect(entries).toHaveLength(1);
      expect(entries[0].stage).toBe("test");
      expect(entries[0].filesModified).toHaveLength(2);
    });

    it("advances updatedAt on re-upsert", async () => {
      const db = await makeDb() as any;

      await upsertActiveWork(db, {
        runId: "run-ts",
        issueId: "BEC-99",
        stage: "implement",
        filesModified: ["src/a.ts"],
      });

      const before = await getActiveWork(db);
      expect(before).toHaveLength(1);
      const firstUpdatedAt = before[0].updatedAt;

      // Wait briefly so the epoch second advances
      await new Promise((r) => setTimeout(r, 1100));

      await upsertActiveWork(db, {
        runId: "run-ts",
        issueId: "BEC-99",
        stage: "test",
        filesModified: ["src/a.ts", "src/a.test.ts"],
      });

      const after = await getActiveWork(db);
      expect(after).toHaveLength(1);
      expect(after[0].stage).toBe("test");
      expect(after[0].updatedAt.getTime()).toBeGreaterThan(firstUpdatedAt.getTime());
    });

    it("handles entries with no files modified", async () => {
      const db = await makeDb() as any;

      await upsertActiveWork(db, {
        runId: "run-3",
        issueId: "BEC-12",
        stage: "triage",
      });

      const entries = await getActiveWork(db);
      expect(entries).toHaveLength(1);
      expect(entries[0].filesModified).toBeNull();
    });
  });

  describe("removeActiveWork", () => {
    it("removes an entry by runId", async () => {
      const db = await makeDb() as any;

      await upsertActiveWork(db, {
        runId: "run-4",
        issueId: "BEC-13",
        stage: "implement",
      });

      await removeActiveWork(db, "run-4");

      const entries = await getActiveWork(db);
      expect(entries).toHaveLength(0);
    });

    it("does not throw when removing a non-existent entry", async () => {
      const db = await makeDb() as any;
      await expect(removeActiveWork(db, "run-nonexistent")).resolves.not.toThrow();
    });
  });

  describe("checkFileOverlap", () => {
    it("returns no overlap when no other active runs exist", async () => {
      const db = await makeDb() as any;

      await upsertActiveWork(db, {
        runId: "run-5",
        issueId: "BEC-14",
        stage: "implement",
        filesModified: ["src/api/routes.ts"],
      });

      const result = await checkFileOverlap(db, "run-5", ["src/api/routes.ts"]);
      expect(result.hasOverlap).toBe(false);
      expect(result.overlappingFiles).toHaveLength(0);
      expect(result.conflictingRunIds).toHaveLength(0);
    });

    it("detects overlap with another run's modified files", async () => {
      const db = await makeDb() as any;

      // Run A is modifying auth files
      await upsertActiveWork(db, {
        runId: "run-a",
        issueId: "BEC-15",
        stage: "implement",
        filesModified: ["src/auth/login.ts", "src/auth/session.ts"],
      });

      // Run B wants to check if its files conflict
      const result = await checkFileOverlap(db, "run-b", ["src/auth/login.ts", "src/api/users.ts"]);

      expect(result.hasOverlap).toBe(true);
      expect(result.overlappingFiles).toContain("src/auth/login.ts");
      expect(result.overlappingFiles).not.toContain("src/api/users.ts");
      expect(result.conflictingRunIds).toContain("run-a");
    });

    it("returns no overlap when files do not intersect", async () => {
      const db = await makeDb() as any;

      await upsertActiveWork(db, {
        runId: "run-c",
        issueId: "BEC-16",
        stage: "implement",
        filesModified: ["src/auth/login.ts"],
      });

      const result = await checkFileOverlap(db, "run-d", ["src/api/payments.ts"]);
      expect(result.hasOverlap).toBe(false);
    });

    it("returns no overlap when files array is empty", async () => {
      const db = await makeDb() as any;

      await upsertActiveWork(db, {
        runId: "run-e",
        issueId: "BEC-17",
        stage: "implement",
        filesModified: ["src/auth/login.ts"],
      });

      const result = await checkFileOverlap(db, "run-f", []);
      expect(result.hasOverlap).toBe(false);
    });

    it("ignores runs with no files recorded", async () => {
      const db = await makeDb() as any;

      await upsertActiveWork(db, {
        runId: "run-g",
        issueId: "BEC-18",
        stage: "triage",
        // no filesModified
      });

      const result = await checkFileOverlap(db, "run-h", ["src/auth/login.ts"]);
      expect(result.hasOverlap).toBe(false);
    });
  });

  describe("getActiveWork", () => {
    it("returns all active work entries", async () => {
      const db = await makeDb() as any;

      await upsertActiveWork(db, { runId: "run-i", issueId: "BEC-19", stage: "implement" });
      await upsertActiveWork(db, { runId: "run-j", issueId: "BEC-20", stage: "test" });

      const entries = await getActiveWork(db);
      expect(entries).toHaveLength(2);
      const runIds = entries.map((e) => e.runId);
      expect(runIds).toContain("run-i");
      expect(runIds).toContain("run-j");
    });

    it("returns empty array when no entries exist", async () => {
      const db = await makeDb() as any;
      const entries = await getActiveWork(db);
      expect(entries).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// getModifiedFiles — requires a real git repo
// ---------------------------------------------------------------------------
describe("getModifiedFiles", () => {
  let repoDir: string;

  function initRepo(dir: string) {
    mkdirSync(dir, { recursive: true });
    execFileSync("git", ["init"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
    // Initial commit so HEAD exists
    writeFileSync(join(dir, "README.md"), "hello");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
  }

  afterAll(() => {
    if (repoDir) {
      try { rmSync(repoDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it("returns empty array when worktree has no changes", async () => {
    repoDir = join(tmpdir(), `laf-getmod-test-${randomBytes(6).toString("hex")}`);
    initRepo(repoDir);

    const files = await getModifiedFiles(repoDir);
    expect(files).toEqual([]);
  });

  it("detects a newly added untracked file in the repo root", async () => {
    repoDir = join(tmpdir(), `laf-getmod-test-${randomBytes(6).toString("hex")}`);
    initRepo(repoDir);

    // Place file at root so git status --porcelain shows the full filename
    writeFileSync(join(repoDir, "new-feature.ts"), "export const x = 1;");

    const files = await getModifiedFiles(repoDir);
    expect(files).toContain("new-feature.ts");
  });

  it("detects a staged file", async () => {
    repoDir = join(tmpdir(), `laf-getmod-test-${randomBytes(6).toString("hex")}`);
    initRepo(repoDir);

    writeFileSync(join(repoDir, "staged.ts"), "staged content");
    execFileSync("git", ["add", "staged.ts"], { cwd: repoDir });

    const files = await getModifiedFiles(repoDir);
    expect(files).toContain("staged.ts");
  });

  it("returns empty array on invalid path (non-throwing)", async () => {
    const files = await getModifiedFiles("/nonexistent/path/xyz");
    expect(files).toEqual([]);
  });
});
