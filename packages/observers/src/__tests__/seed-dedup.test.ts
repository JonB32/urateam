/**
 * Unit tests for seedDedupOnFirstTick.
 *
 * AC: Unit test in packages/observers/src/__tests__: seedDedupOnFirstTick() with 5 findings
 *     → verifies 0 GitHub issues created, 5 fingerprints registered in observer_findings
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createObserverStore } from "../store.js";
import { isFirstTick, seedDedupOnFirstTick, processFindings } from "../engine.js";
import type { QualityFinding, ObserverStore } from "../types.js";

const FIVE_FINDINGS: QualityFinding[] = [
  {
    fingerprint: "fp-implement-failure-rate",
    title: "High failure rate on implement stage",
    body: "The implement stage has a >20% failure rate over the last 24h.",
  },
  {
    fingerprint: "fp-slow-test-p95",
    title: "Slow test stage: P95 > 5 min",
    body: "Test stage P95 latency exceeded 5 minutes.",
  },
  {
    fingerprint: "fp-auto-commit-rate",
    title: "Auto-commit rate > 30%",
    body: "More than 30% of runs required auto-commit fallback.",
  },
  {
    fingerprint: "fp-ralph-satisfaction-drop",
    title: "RALPH satisfaction rate dropped below 70%",
    body: "RALPH is marking more than 30% of implement outputs as unsatisfied.",
  },
  {
    fingerprint: "fp-draft-pr-rate-high",
    title: "Draft PR rate elevated (>40%)",
    body: "More than 40% of PRs are being opened as drafts.",
  },
];

function makeInMemoryStore(): ObserverStore {
  return createObserverStore(":memory:");
}

describe("isFirstTick", () => {
  it("returns true for a fresh empty store", () => {
    const store = makeInMemoryStore();
    expect(isFirstTick(store)).toBe(true);
    store.close();
  });

  it("returns false after seeding", async () => {
    const store = makeInMemoryStore();
    await seedDedupOnFirstTick(store, async () => FIVE_FINDINGS);
    expect(isFirstTick(store)).toBe(false);
    store.close();
  });
});

describe("seedDedupOnFirstTick", () => {
  let store: ObserverStore;
  // fileIssueMock is re-created in beforeEach so each test gets a fresh mock
  let fileIssueMock = vi.fn().mockResolvedValue("https://github.com/org/repo/issues/1");

  beforeEach(() => {
    store = makeInMemoryStore();
    fileIssueMock = vi.fn().mockResolvedValue("https://github.com/org/repo/issues/1");
  });

  it("registers 5 fingerprints without calling fileIssue at all", async () => {
    const computeFindings = vi.fn().mockResolvedValue(FIVE_FINDINGS);

    expect(isFirstTick(store)).toBe(true);

    const { seeded } = await seedDedupOnFirstTick(store, computeFindings);

    // No GitHub issues created
    expect(fileIssueMock).not.toHaveBeenCalled();

    // All 5 fingerprints registered
    expect(seeded).toBe(5);
    expect(store.countFingerprints()).toBe(5);

    // Verify individual fingerprints
    for (const finding of FIVE_FINDINGS) {
      expect(store.hasFingerprint(finding.fingerprint)).toBe(true);
    }
  });

  it("transitions isFirstTick from true to false after seeding", async () => {
    expect(isFirstTick(store)).toBe(true);
    await seedDedupOnFirstTick(store, async () => FIVE_FINDINGS);
    expect(isFirstTick(store)).toBe(false);
  });

  it("returns seeded=0 and files nothing when findings list is empty", async () => {
    const { seeded } = await seedDedupOnFirstTick(store, async () => []);
    expect(seeded).toBe(0);
    expect(store.countFingerprints()).toBe(0);
    // firstTickAt is still set even with 0 findings
    expect(isFirstTick(store)).toBe(false);
  });
});

describe("processFindings (dedup logic)", () => {
  it("skips all findings when every fingerprint is already registered", async () => {
    const store = makeInMemoryStore();
    // Pre-register all fingerprints (simulates a previous tick)
    for (const f of FIVE_FINDINGS) {
      store.registerFingerprint(f.fingerprint);
    }
    store.setFirstTickAt();

    const fileIssueMock = vi.fn().mockResolvedValue("https://github.com/org/repo/issues/1");

    const { filed, skipped } = await processFindings(
      store,
      async () => FIVE_FINDINGS,
      fileIssueMock
    );

    expect(filed).toBe(0);
    expect(skipped).toBe(5);
    expect(fileIssueMock).not.toHaveBeenCalled();
    store.close();
  });

  it("files only new findings when some fingerprints are new", async () => {
    const store = makeInMemoryStore();
    // Pre-register first 4
    for (const f of FIVE_FINDINGS.slice(0, 4)) {
      store.registerFingerprint(f.fingerprint);
    }
    store.setFirstTickAt();

    let filedUrls: string[] = [];
    const fileIssueMock = vi.fn().mockImplementation(async () => {
      const url = `https://github.com/org/repo/issues/${filedUrls.length + 1}`;
      filedUrls.push(url);
      return url;
    });

    const { filed, skipped } = await processFindings(
      store,
      async () => FIVE_FINDINGS,
      fileIssueMock
    );

    expect(filed).toBe(1);
    expect(skipped).toBe(4);
    expect(fileIssueMock).toHaveBeenCalledOnce();
    expect(fileIssueMock).toHaveBeenCalledWith(FIVE_FINDINGS[4]);
    store.close();
  });
});
