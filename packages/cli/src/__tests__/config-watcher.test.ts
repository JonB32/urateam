import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  diffRepos,
  hashConfig,
  ConfigWatcher,
  SAFE_REPO_FIELDS,
  UNSAFE_REPO_FIELDS,
} from "../lib/config-watcher.js";
import type {
  UserLevelConfig,
  UserLevelRepo,
} from "../lib/user-level-config.js";

function repo(over: Partial<UserLevelRepo>): UserLevelRepo {
  return {
    url: "https://github.com/a/x.git",
    path: "/p/x",
    defaultBranch: "main",
    testCommand: "pnpm test",
    buildCommand: "pnpm build",
    ...over,
  };
}
function cfg(repos: UserLevelRepo[]): UserLevelConfig {
  return { version: 1, repos };
}

describe("diffRepos", () => {
  it("detects added repos", () => {
    const prev = cfg([]);
    const next = cfg([repo({ url: "https://github.com/a/x.git" })]);
    const d = diffRepos(prev, next);
    expect(d.added).toHaveLength(1);
    expect(d.added[0]!.url).toBe("https://github.com/a/x.git");
    expect(d.removed).toEqual([]);
    expect(d.modifiedSafe).toEqual([]);
    expect(d.modifiedUnsafe).toEqual([]);
  });

  it("detects removed repos", () => {
    const prev = cfg([repo({ url: "https://github.com/a/x.git" })]);
    const next = cfg([]);
    const d = diffRepos(prev, next);
    expect(d.removed).toHaveLength(1);
    expect(d.removed[0]!.url).toBe("https://github.com/a/x.git");
    expect(d.added).toEqual([]);
  });

  it("detects safe-field modifications", () => {
    const prev = cfg([repo({ testCommand: "pnpm test" })]);
    const next = cfg([repo({ testCommand: "pnpm test --changed" })]);
    const d = diffRepos(prev, next);
    expect(d.modifiedSafe).toHaveLength(1);
    expect(d.modifiedSafe[0]!.fields).toContain("testCommand");
    expect(d.modifiedUnsafe).toEqual([]);
  });

  it("detects unsafe-field modifications (defaultBranch)", () => {
    const prev = cfg([repo({ defaultBranch: "main" })]);
    const next = cfg([repo({ defaultBranch: "master" })]);
    const d = diffRepos(prev, next);
    expect(d.modifiedUnsafe).toHaveLength(1);
    expect(d.modifiedUnsafe[0]!.fields).toContain("defaultBranch");
    expect(d.modifiedSafe).toEqual([]);
  });

  it("splits safe + unsafe modifications on the same repo", () => {
    const prev = cfg([repo({ defaultBranch: "main", testCommand: "a" })]);
    const next = cfg([repo({ defaultBranch: "develop", testCommand: "b" })]);
    const d = diffRepos(prev, next);
    expect(d.modifiedSafe).toHaveLength(1);
    expect(d.modifiedUnsafe).toHaveLength(1);
  });

  it("returns empty diff when configs are identical", () => {
    const same = cfg([repo({})]);
    const d = diffRepos(same, same);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(d.modifiedSafe).toEqual([]);
    expect(d.modifiedUnsafe).toEqual([]);
  });

  it("classifies SAFE_REPO_FIELDS and UNSAFE_REPO_FIELDS disjointly", () => {
    for (const f of SAFE_REPO_FIELDS) {
      expect(UNSAFE_REPO_FIELDS).not.toContain(f as any);
    }
  });
});

describe("hashConfig", () => {
  it("returns a 64-char hex string", () => {
    expect(hashConfig(cfg([]))).toMatch(/^[0-9a-f]{64}$/);
  });
  it("is deterministic for the same input", () => {
    expect(hashConfig(cfg([repo({})]))).toBe(hashConfig(cfg([repo({})])));
  });
  it("changes when content changes", () => {
    expect(hashConfig(cfg([]))).not.toBe(hashConfig(cfg([repo({})])));
  });
});

describe("ConfigWatcher", () => {
  let tmp: string;
  let configPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ura-watch-"));
    configPath = join(tmp, "config.json");
    writeFileSync(configPath, JSON.stringify(cfg([])));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("emits 'applied' with a diff when the reader returns a new config", async () => {
    const initial = cfg([]);
    const after = cfg([repo({ url: "https://github.com/a/x.git" })]);
    // Reader returns the post-change config on every call; the watcher's
    // diff is against its in-memory `initial`, so the first reload emits.
    const reader = vi.fn(() => after);
    const w = new ConfigWatcher(initial, {
      path: configPath,
      debounceMs: 5,
      reader,
      log: () => {},
    });
    const applied = new Promise<any>((resolve) => w.once("applied", resolve));
    w.reloadNow();
    const diff = await applied;
    expect(diff.added).toHaveLength(1);
    expect(diff.added[0].url).toBe("https://github.com/a/x.git");
    // After applying, subsequent same-content reloads should be no-ops.
    const handler = vi.fn();
    w.on("applied", handler);
    w.reloadNow();
    expect(handler).not.toHaveBeenCalled();
  });

  it("emits no 'applied' for a no-op reload", () => {
    const initial = cfg([]);
    const w = new ConfigWatcher(initial, {
      path: configPath,
      reader: () => initial,
      log: () => {},
    });
    const handler = vi.fn();
    w.on("applied", handler);
    w.reloadNow();
    expect(handler).not.toHaveBeenCalled();
  });

  it("emits 'error' and keeps the previous config when the reader throws", () => {
    const initial = cfg([]);
    const reader = vi.fn(() => {
      throw new Error("zod: invalid schema");
    });
    const w = new ConfigWatcher(initial, {
      path: configPath,
      reader,
      log: () => {},
    });
    const handler = vi.fn();
    w.on("error", handler);
    w.reloadNow();
    expect(handler).toHaveBeenCalled();
    expect(w.getCurrent()).toBe(initial);
  });

  it("keeps the previous config when the config file disappears", () => {
    const initial = cfg([]);
    const w = new ConfigWatcher(initial, {
      path: configPath,
      reader: () => null,
      log: () => {},
    });
    w.reloadNow();
    expect(w.getCurrent()).toBe(initial);
  });

  it("debounces rapid fs.watch firings into a single reload", async () => {
    vi.useFakeTimers();
    try {
      const initial = cfg([]);
      const next = cfg([repo({})]);
      let calls = 0;
      const reader = vi.fn(() => {
        calls += 1;
        return calls === 1 ? initial : next;
      });
      const w = new ConfigWatcher(initial, {
        path: configPath,
        debounceMs: 100,
        reader,
        log: () => {},
      });
      w.start();
      // Simulate 5 fs.watch firings in quick succession.
      for (let i = 0; i < 5; i++) writeFileSync(configPath, "{}");
      await vi.advanceTimersByTimeAsync(200);
      expect(reader.mock.calls.length).toBeLessThanOrEqual(1);
      w.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stop() unwatches and cancels pending debounce timer", () => {
    const initial = cfg([]);
    const w = new ConfigWatcher(initial, {
      path: configPath,
      reader: () => initial,
      log: () => {},
    });
    w.start();
    w.stop();
    // No exceptions; subsequent stop is a no-op.
    expect(() => w.stop()).not.toThrow();
  });
});
