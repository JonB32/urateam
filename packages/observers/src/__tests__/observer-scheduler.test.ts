/**
 * Integration tests for the observer scheduler — validates the full 3-tick sequence:
 *
 *   Tick 1 (fresh store)  → 0 issues filed, 5 fingerprints seeded
 *   Tick 2 (same patterns)→ 0 issues filed (dedup)
 *   Tick 3 (new pattern)  → 1 issue filed (only the new one)
 *
 * Also verifies QUALITY_OBSERVER_FIRST_TICK_FILE=true forces filing on tick 1.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createObserverStore } from "../store.js";
import { createObserverScheduler } from "../scheduler.js";
import type { QualityFinding, ObserverStore } from "../types.js";

const BASE_FINDINGS: QualityFinding[] = [
  { fingerprint: "fp-1", title: "Finding 1", body: "body 1" },
  { fingerprint: "fp-2", title: "Finding 2", body: "body 2" },
  { fingerprint: "fp-3", title: "Finding 3", body: "body 3" },
  { fingerprint: "fp-4", title: "Finding 4", body: "body 4" },
  { fingerprint: "fp-5", title: "Finding 5", body: "body 5" },
];

const NEW_FINDING: QualityFinding = {
  fingerprint: "fp-new",
  title: "New Finding",
  body: "a brand-new pattern",
};

describe("observer 3-tick sequence (integration)", () => {
  let store: ObserverStore;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fileGithubIssue: any;
  let currentFindings: QualityFinding[];

  beforeEach(() => {
    store = createObserverStore(":memory:");
    currentFindings = [...BASE_FINDINGS];
    fileGithubIssue = vi.fn().mockResolvedValue("https://github.com/org/repo/issues/1");
  });

  afterEach(() => {
    store.close();
  });

  it("tick 1: seeds dedup with 5 findings, files 0 issues", async () => {
    const scheduler = createObserverScheduler({
      store,
      computeFindings: async () => currentFindings,
      fileGithubIssue,
      firstTickFile: false,
    });

    const result = await scheduler.tick();

    expect(result.firstTick).toBe(true);
    expect(result.seeded).toBe(5);
    expect(result.filed).toBe(0);
    expect(result.skipped).toBe(0);
    expect(fileGithubIssue).not.toHaveBeenCalled();
    expect(store.countFingerprints()).toBe(5);
  });

  it("tick 2: same patterns → 0 filed (dedup)", async () => {
    const scheduler = createObserverScheduler({
      store,
      computeFindings: async () => currentFindings,
      fileGithubIssue,
      firstTickFile: false,
    });

    // Tick 1: seed
    await scheduler.tick();
    fileGithubIssue.mockClear();

    // Tick 2: same patterns
    const result = await scheduler.tick();

    expect(result.firstTick).toBe(false);
    expect(result.filed).toBe(0);
    expect(result.skipped).toBe(5);
    expect(fileGithubIssue).not.toHaveBeenCalled();
  });

  it("tick 3: new pattern appears → files 1 issue", async () => {
    const scheduler = createObserverScheduler({
      store,
      computeFindings: async () => currentFindings,
      fileGithubIssue,
      firstTickFile: false,
    });

    // Tick 1: seed
    await scheduler.tick();
    // Tick 2: same patterns
    await scheduler.tick();
    fileGithubIssue.mockClear();

    // Tick 3: add a new pattern
    currentFindings = [...BASE_FINDINGS, NEW_FINDING];
    const result = await scheduler.tick();

    expect(result.firstTick).toBe(false);
    expect(result.filed).toBe(1);
    expect(result.skipped).toBe(5);
    expect(fileGithubIssue).toHaveBeenCalledOnce();
    expect(fileGithubIssue).toHaveBeenCalledWith(
      expect.objectContaining({ fingerprint: "fp-new" })
    );
    // New fingerprint now registered
    expect(store.countFingerprints()).toBe(6);
  });

  it("full 3-tick sequence in one test", async () => {
    const scheduler = createObserverScheduler({
      store,
      computeFindings: async () => currentFindings,
      fileGithubIssue,
      firstTickFile: false,
    });

    // --- Tick 1: fresh store → seed, file nothing ---
    const tick1 = await scheduler.tick();
    expect(tick1.firstTick).toBe(true);
    expect(tick1.seeded).toBe(5);
    expect(tick1.filed).toBe(0);
    expect(fileGithubIssue).not.toHaveBeenCalled();
    expect(store.countFingerprints()).toBe(5);

    // --- Tick 2: same patterns → dedup catches everything ---
    const tick2 = await scheduler.tick();
    expect(tick2.firstTick).toBe(false);
    expect(tick2.filed).toBe(0);
    expect(tick2.skipped).toBe(5);
    expect(fileGithubIssue).not.toHaveBeenCalled();

    // --- Tick 3: one new pattern → exactly 1 issue filed ---
    currentFindings = [...BASE_FINDINGS, NEW_FINDING];
    const tick3 = await scheduler.tick();
    expect(tick3.firstTick).toBe(false);
    expect(tick3.filed).toBe(1);
    expect(tick3.skipped).toBe(5);
    expect(fileGithubIssue).toHaveBeenCalledOnce();
    expect(fileGithubIssue).toHaveBeenCalledWith(
      expect.objectContaining({ fingerprint: "fp-new" })
    );
  });
});

describe("QUALITY_OBSERVER_FIRST_TICK_FILE override", () => {
  it("firstTickFile: true → files normally on first tick, does not seed", async () => {
    const store = createObserverStore(":memory:");
    const fileGithubIssue = vi.fn().mockResolvedValue("https://github.com/org/repo/issues/1");

    const scheduler = createObserverScheduler({
      store,
      computeFindings: async () => BASE_FINDINGS,
      fileGithubIssue,
      firstTickFile: true,
    });

    const result = await scheduler.tick();

    // Detected as first tick (store was empty) but force-filed
    expect(result.firstTick).toBe(true);
    expect(result.seeded).toBe(0);
    expect(result.filed).toBe(5);
    expect(fileGithubIssue).toHaveBeenCalledTimes(5);
    // Fingerprints are registered via processFindings
    expect(store.countFingerprints()).toBe(5);
    // isFirstTick is false after first tick with force-file
    const { isFirstTick } = await import("../engine.js");
    expect(isFirstTick(store)).toBe(false);

    store.close();
  });

  it("env QUALITY_OBSERVER_FIRST_TICK_FILE=true → first tick files normally", async () => {
    const originalEnv = process.env["QUALITY_OBSERVER_FIRST_TICK_FILE"];
    process.env["QUALITY_OBSERVER_FIRST_TICK_FILE"] = "true";

    try {
      const store = createObserverStore(":memory:");
      const fileGithubIssue = vi.fn().mockResolvedValue("https://github.com/org/repo/issues/1");

      const scheduler = createObserverScheduler({
        store,
        computeFindings: async () => BASE_FINDINGS,
        fileGithubIssue,
        // No explicit firstTickFile — relies on env var
      });

      const result = await scheduler.tick();

      expect(result.filed).toBe(5);
      expect(fileGithubIssue).toHaveBeenCalledTimes(5);

      store.close();
    } finally {
      if (originalEnv === undefined) {
        delete process.env["QUALITY_OBSERVER_FIRST_TICK_FILE"];
      } else {
        process.env["QUALITY_OBSERVER_FIRST_TICK_FILE"] = originalEnv;
      }
    }
  });
});
