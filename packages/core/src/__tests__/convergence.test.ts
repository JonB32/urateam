/**
 * Unit tests for the deep-review loop convergence detection (BEC-211).
 *
 * These tests verify that detectConvergence correctly identifies cycles,
 * respects the maxReviewTurns cap, and returns structured ConvergenceResult
 * objects with useful diagnostic detail strings.
 *
 * Integration path: detectConvergence is called from runner.ts inside the
 * deep-review loop at the end of each pass, immediately before the loop
 * decides whether to execute the next implement+review stage pair.
 */

import { describe, it, expect } from "vitest";
import { detectConvergence, type PassHistory } from "../pipeline/convergence.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePass(
  passNumber: number,
  filesChanged: string[],
  findingsCount: number,
): PassHistory {
  return { passNumber, filesChanged, findingsCount };
}

// ---------------------------------------------------------------------------
// 1. no-findings: ideal convergence
// ---------------------------------------------------------------------------

describe("detectConvergence — no-findings", () => {
  it("returns no-findings when current pass has zero findings", () => {
    const history = [makePass(1, ["src/A.ts"], 0)];
    const result = detectConvergence(history, 1, 15, 1);
    expect(result).not.toBeNull();
    expect(result!.reason).toBe("no-findings");
    expect(result!.iteration).toBe(1);
    expect(result!.detail).toMatch(/zero findings/i);
  });

  it("returns no-findings even on the first pass when zero findings", () => {
    const history = [makePass(1, [], 0)];
    const result = detectConvergence(history, 1, 15, 1);
    expect(result?.reason).toBe("no-findings");
  });
});

// ---------------------------------------------------------------------------
// 2. max-turns: hard safety cap
// ---------------------------------------------------------------------------

describe("detectConvergence — max-turns", () => {
  it("triggers max-turns when currentTurns equals maxReviewTurns", () => {
    const history = [makePass(15, ["src/A.ts"], 3)];
    const result = detectConvergence(history, 15, 15, 15);
    expect(result).not.toBeNull();
    expect(result!.reason).toBe("max-turns");
    expect(result!.iteration).toBe(15);
    expect(result!.detail).toMatch(/maxReviewTurns/);
  });

  it("triggers max-turns when currentTurns exceeds maxReviewTurns", () => {
    // Shouldn't happen normally (passLimit = min(..., maxReviewTurns)),
    // but the function should be safe if called with turns > max.
    const history = [makePass(16, ["src/A.ts"], 1)];
    const result = detectConvergence(history, 16, 15, 16);
    expect(result?.reason).toBe("max-turns");
  });

  it("does NOT trigger max-turns one pass before the cap", () => {
    const history = [makePass(14, ["src/A.ts"], 3)];
    const result = detectConvergence(history, 14, 15, 14);
    // No convergence yet (only 1 pass in history; need 2 for plateau/oscillation)
    expect(result).toBeNull();
  });

  it("max-turns has lower priority than no-findings", () => {
    // Even when currentTurns == maxReviewTurns, if findingsCount is 0, we get
    // no-findings first (both fire at the same condition but no-findings is checked first).
    const history = [makePass(15, ["src/A.ts"], 0)];
    const result = detectConvergence(history, 15, 15, 15);
    expect(result?.reason).toBe("no-findings");
  });
});

// ---------------------------------------------------------------------------
// 3. file-oscillation: cycle detection (the main BEC-211 fix)
// ---------------------------------------------------------------------------

describe("detectConvergence — file-oscillation", () => {
  it("detects oscillation when two consecutive passes change the same files", () => {
    const history = [
      makePass(1, ["src/A.ts", "src/B.ts"], 10),
      makePass(2, ["src/A.ts", "src/B.ts"], 9), // same files, decreasing count
    ];
    const result = detectConvergence(history, 2, 15, 2);
    expect(result).not.toBeNull();
    expect(result!.reason).toBe("file-oscillation");
    expect(result!.iteration).toBe(2);
    expect(result!.detail).toMatch(/src\/A\.ts/);
    expect(result!.detail).toMatch(/src\/B\.ts/);
    expect(result!.detail).toMatch(/cycling/i);
  });

  it("normalises file order before comparing (detects oscillation regardless of input order)", () => {
    const history = [
      makePass(1, ["src/B.ts", "src/A.ts"], 5), // B before A
      makePass(2, ["src/A.ts", "src/B.ts"], 4), // A before B — same set
    ];
    const result = detectConvergence(history, 2, 15, 2);
    expect(result?.reason).toBe("file-oscillation");
  });

  it("does NOT fire when consecutive passes change different files", () => {
    const history = [
      makePass(1, ["src/A.ts"], 5),
      makePass(2, ["src/B.ts"], 4), // different file
    ];
    const result = detectConvergence(history, 2, 15, 2);
    // count decreased (5→4) and files differ — should return null
    expect(result).toBeNull();
  });

  it("does NOT fire on the first pass (needs two passes for comparison)", () => {
    const history = [makePass(1, ["src/A.ts"], 5)];
    const result = detectConvergence(history, 1, 15, 1);
    expect(result).toBeNull();
  });

  it("does NOT fire when file sets have the same count but different contents", () => {
    const history = [
      makePass(1, ["src/A.ts", "src/B.ts"], 5),
      makePass(2, ["src/A.ts", "src/C.ts"], 4), // B→C, same count, different files
    ];
    const result = detectConvergence(history, 2, 15, 2);
    expect(result).toBeNull();
  });

  it("does NOT fire when both passes have empty filesChanged", () => {
    // Empty-set match should be ignored (we can't infer oscillation from no files)
    const history = [
      makePass(1, [], 5),
      makePass(2, [], 4),
    ];
    const result = detectConvergence(history, 2, 15, 2);
    // Count still decreased (5→4), file-oscillation guard skips empty sets → null
    expect(result).toBeNull();
  });

  it("detects the oscillating-6-pass scenario from BEC-211 reproduce test", () => {
    // The scenario from bec-211-reproduce.test.ts: 6 passes, same two files
    // every pass, findings 10→9→8→7→6→5. The old count-only check ran all 6.
    // The new file-oscillation check stops at pass 2.
    const files = ["src/A.ts", "src/B.ts"];
    const history: PassHistory[] = [];
    let stoppedAt = 6;
    for (let i = 1; i <= 6; i++) {
      history.push(makePass(i, files, 11 - i)); // 10, 9, 8, 7, 6, 5
      const result = detectConvergence(history, i, 15, i);
      if (result) {
        stoppedAt = i;
        expect(result.reason).toBe("file-oscillation");
        break;
      }
    }
    expect(stoppedAt).toBe(2); // stops at pass 2, not pass 6
    expect(stoppedAt).toBeLessThan(6);
  });
});

// ---------------------------------------------------------------------------
// 4. count-plateau: existing guard (retained)
// ---------------------------------------------------------------------------

describe("detectConvergence — count-plateau", () => {
  it("detects plateau when findings count stays the same", () => {
    const history = [
      makePass(1, ["src/A.ts"], 5),
      makePass(2, ["src/B.ts"], 5), // same count, different files
    ];
    const result = detectConvergence(history, 2, 15, 2);
    expect(result).not.toBeNull();
    expect(result!.reason).toBe("count-plateau");
    expect(result!.iteration).toBe(2);
  });

  it("detects plateau when findings count increases", () => {
    const history = [
      makePass(1, ["src/A.ts"], 3),
      makePass(2, ["src/B.ts"], 5), // increased — different files to avoid oscillation
    ];
    const result = detectConvergence(history, 2, 15, 2);
    expect(result?.reason).toBe("count-plateau");
  });

  it("does NOT fire when findings strictly decrease", () => {
    const history = [
      makePass(1, ["src/A.ts"], 5),
      makePass(2, ["src/B.ts"], 3), // decreased, different files
    ];
    const result = detectConvergence(history, 2, 15, 2);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. Priority ordering: no-findings > max-turns > file-oscillation > count-plateau
// ---------------------------------------------------------------------------

describe("detectConvergence — priority ordering", () => {
  it("no-findings fires before max-turns even when both conditions are true", () => {
    const history = [makePass(15, ["src/A.ts"], 0)];
    const result = detectConvergence(history, 15, 15, 15);
    expect(result?.reason).toBe("no-findings");
  });

  it("max-turns fires before file-oscillation when both conditions are true", () => {
    const history = [
      makePass(14, ["src/A.ts"], 5),
      makePass(15, ["src/A.ts"], 3), // same file as pass 14 (oscillation) AND at max-turns
    ];
    const result = detectConvergence(history, 15, 15, 15);
    expect(result?.reason).toBe("max-turns");
  });

  it("file-oscillation fires before count-plateau when both conditions are true", () => {
    const history = [
      makePass(1, ["src/A.ts"], 5),
      makePass(2, ["src/A.ts"], 5), // same file AND same count
    ];
    const result = detectConvergence(history, 2, 15, 2);
    // Both oscillation (same file) and plateau (same count) are true.
    // Oscillation is checked first.
    expect(result?.reason).toBe("file-oscillation");
  });
});

// ---------------------------------------------------------------------------
// 6. Edge cases
// ---------------------------------------------------------------------------

describe("detectConvergence — edge cases", () => {
  it("returns null for empty history", () => {
    expect(detectConvergence([], 1, 15, 1)).toBeNull();
  });

  it("handles single-file changes correctly", () => {
    const history = [
      makePass(1, ["src/single.ts"], 2),
      makePass(2, ["src/single.ts"], 1), // same single file
    ];
    const result = detectConvergence(history, 2, 15, 2);
    expect(result?.reason).toBe("file-oscillation");
  });

  it("correctly handles maxReviewTurns of 1 (forces exit on first pass with findings)", () => {
    const history = [makePass(1, ["src/A.ts"], 3)];
    const result = detectConvergence(history, 1, 1, 1);
    // currentTurns (1) >= maxReviewTurns (1) → max-turns
    // But findingsCount is 3 (not 0) so no-findings doesn't fire
    expect(result?.reason).toBe("max-turns");
  });

  it("detail string contains iteration number and human-readable context", () => {
    const history = [
      makePass(3, ["src/A.ts", "src/B.ts"], 7),
      makePass(4, ["src/A.ts", "src/B.ts"], 5),
    ];
    const result = detectConvergence(history, 4, 15, 4);
    expect(result?.reason).toBe("file-oscillation");
    expect(result?.detail).toContain("pass 4");
    expect(result?.detail).toContain("pass 3");
    expect(result?.detail).toContain("src/A.ts");
  });
});
