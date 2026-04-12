import { describe, it, expect } from "vitest";
import {
  parseIssueFiles,
  buildConflictMatrix,
  detectFileOverlap,
  sortAndFilterNonConflicting,
  type IssueWithFiles,
} from "../pm/conflict-detector.js";

// ---------------------------------------------------------------------------
// parseIssueFiles
// ---------------------------------------------------------------------------
describe("parseIssueFiles", () => {
  it("parses a simple Files section", () => {
    const description =
      "Some description\n\n**Files**: packages/core/src/pm/conflict-detector.ts, packages/core/src/pipeline/runner.ts";
    expect(parseIssueFiles(description)).toEqual([
      "packages/core/src/pm/conflict-detector.ts",
      "packages/core/src/pipeline/runner.ts",
    ]);
  });

  it("strips backticks around file paths", () => {
    const description =
      "**Files**: `src/auth/login.ts`, `src/auth/session.ts`";
    expect(parseIssueFiles(description)).toEqual([
      "src/auth/login.ts",
      "src/auth/session.ts",
    ]);
  });

  it("returns empty array when no Files section is present", () => {
    expect(parseIssueFiles("Just a description with no files section")).toEqual([]);
  });

  it("returns empty array for empty string", () => {
    expect(parseIssueFiles("")).toEqual([]);
  });

  it("handles single file", () => {
    const description = "**Files**: src/index.ts";
    expect(parseIssueFiles(description)).toEqual(["src/index.ts"]);
  });

  it("is case-insensitive for the Files label", () => {
    const description = "**files**: src/a.ts, src/b.ts";
    expect(parseIssueFiles(description)).toEqual(["src/a.ts", "src/b.ts"]);
  });
});

// ---------------------------------------------------------------------------
// buildConflictMatrix
// ---------------------------------------------------------------------------
describe("buildConflictMatrix", () => {
  it("returns empty matrix for no issues", () => {
    const matrix = buildConflictMatrix([]);
    expect(matrix.size).toBe(0);
  });

  it("detects file overlap between two issues", () => {
    const issues: IssueWithFiles[] = [
      { issueId: "BEC-1", priority: 2, files: ["src/auth/login.ts"] },
      { issueId: "BEC-2", priority: 3, files: ["src/auth/login.ts", "src/api/routes.ts"] },
    ];
    const matrix = buildConflictMatrix(issues);
    expect(matrix.get("BEC-1")).toContain("BEC-2");
    expect(matrix.get("BEC-2")).toContain("BEC-1");
  });

  it("does not flag issues with no overlapping files", () => {
    const issues: IssueWithFiles[] = [
      { issueId: "BEC-1", priority: 2, files: ["src/auth/login.ts"] },
      { issueId: "BEC-2", priority: 3, files: ["src/api/routes.ts"] },
    ];
    const matrix = buildConflictMatrix(issues);
    expect(matrix.get("BEC-1")).toEqual([]);
    expect(matrix.get("BEC-2")).toEqual([]);
  });

  it("handles multiple issues with overlapping and non-overlapping files", () => {
    const issues: IssueWithFiles[] = [
      { issueId: "A", priority: 1, files: ["x.ts", "y.ts"] },
      { issueId: "B", priority: 2, files: ["y.ts", "z.ts"] },
      { issueId: "C", priority: 3, files: ["z.ts"] },
      { issueId: "D", priority: 4, files: ["w.ts"] },
    ];
    const matrix = buildConflictMatrix(issues);
    // A conflicts with B (shared y.ts)
    expect(matrix.get("A")).toContain("B");
    // B conflicts with C (shared z.ts)
    expect(matrix.get("B")).toContain("C");
    // D has no conflicts
    expect(matrix.get("D")).toEqual([]);
    // A does not conflict with C or D
    expect(matrix.get("A")).not.toContain("C");
    expect(matrix.get("A")).not.toContain("D");
  });

  it("issues with empty file lists do not conflict", () => {
    const issues: IssueWithFiles[] = [
      { issueId: "A", priority: 1, files: [] },
      { issueId: "B", priority: 2, files: [] },
    ];
    const matrix = buildConflictMatrix(issues);
    expect(matrix.get("A")).toEqual([]);
    expect(matrix.get("B")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// detectFileOverlap
// ---------------------------------------------------------------------------
describe("detectFileOverlap", () => {
  it("returns no conflict when activeWorkMap is empty", () => {
    const result = detectFileOverlap(["src/auth/login.ts"], new Map());
    expect(result.hasConflict).toBe(false);
    expect(result.overlappingFiles).toEqual([]);
    expect(result.conflictingRunIds).toEqual([]);
  });

  it("detects overlap with an active run", () => {
    const activeWorkMap = new Map([
      ["run-1", new Set(["src/auth/login.ts", "src/auth/session.ts"])],
    ]);
    const result = detectFileOverlap(
      ["src/auth/login.ts", "src/api/routes.ts"],
      activeWorkMap,
    );
    expect(result.hasConflict).toBe(true);
    expect(result.overlappingFiles).toContain("src/auth/login.ts");
    expect(result.conflictingRunIds).toContain("run-1");
  });

  it("returns no conflict when files are different", () => {
    const activeWorkMap = new Map([
      ["run-1", new Set(["src/auth/login.ts"])],
    ]);
    const result = detectFileOverlap(["src/api/routes.ts"], activeWorkMap);
    expect(result.hasConflict).toBe(false);
  });

  it("identifies conflicts across multiple active runs", () => {
    const activeWorkMap = new Map([
      ["run-1", new Set(["src/a.ts"])],
      ["run-2", new Set(["src/b.ts"])],
    ]);
    const result = detectFileOverlap(["src/a.ts", "src/b.ts"], activeWorkMap);
    expect(result.hasConflict).toBe(true);
    expect(result.conflictingRunIds).toContain("run-1");
    expect(result.conflictingRunIds).toContain("run-2");
    expect(result.overlappingFiles).toContain("src/a.ts");
    expect(result.overlappingFiles).toContain("src/b.ts");
  });

  it("deduplicates overlappingFiles when same file appears in multiple runs", () => {
    const activeWorkMap = new Map([
      ["run-1", new Set(["shared.ts"])],
      ["run-2", new Set(["shared.ts"])],
    ]);
    const result = detectFileOverlap(["shared.ts"], activeWorkMap);
    expect(result.overlappingFiles.filter((f) => f === "shared.ts")).toHaveLength(1);
  });

  it("returns no conflict when candidateFiles is empty", () => {
    const activeWorkMap = new Map([
      ["run-1", new Set(["src/a.ts"])],
    ]);
    const result = detectFileOverlap([], activeWorkMap);
    expect(result.hasConflict).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// sortAndFilterNonConflicting
// ---------------------------------------------------------------------------
describe("sortAndFilterNonConflicting", () => {
  it("returns all issues when there are no conflicts", () => {
    const issues: IssueWithFiles[] = [
      { issueId: "A", priority: 3, files: ["a.ts"] },
      { issueId: "B", priority: 2, files: ["b.ts"] },
      { issueId: "C", priority: 1, files: ["c.ts"] },
    ];
    const result = sortAndFilterNonConflicting(issues);
    // All issues should be selected (no conflicts)
    expect(result.map((i) => i.issueId)).toEqual(["C", "B", "A"]);
  });

  it("assigns higher priority issue and defers lower priority conflict", () => {
    const issues: IssueWithFiles[] = [
      { issueId: "LOW", priority: 3, files: ["shared.ts"] },
      { issueId: "HIGH", priority: 1, files: ["shared.ts"] },
    ];
    const result = sortAndFilterNonConflicting(issues);
    // HIGH priority (1) should win
    expect(result.map((i) => i.issueId)).toEqual(["HIGH"]);
    expect(result).not.toContainEqual(expect.objectContaining({ issueId: "LOW" }));
  });

  it("includes issues with no file overlap even when others conflict", () => {
    const issues: IssueWithFiles[] = [
      { issueId: "A", priority: 1, files: ["shared.ts"] },
      { issueId: "B", priority: 2, files: ["shared.ts"] },
      { issueId: "C", priority: 3, files: ["unique.ts"] },
    ];
    const result = sortAndFilterNonConflicting(issues);
    // A wins over B; C is unrelated so also included
    const ids = result.map((i) => i.issueId);
    expect(ids).toContain("A");
    expect(ids).toContain("C");
    expect(ids).not.toContain("B");
  });

  it("handles issues with empty file lists (no conflicts possible)", () => {
    const issues: IssueWithFiles[] = [
      { issueId: "A", priority: 1, files: [] },
      { issueId: "B", priority: 2, files: [] },
    ];
    const result = sortAndFilterNonConflicting(issues);
    expect(result).toHaveLength(2);
  });

  it("treats priority=0 as lowest priority", () => {
    const issues: IssueWithFiles[] = [
      { issueId: "NOPRIORITY", priority: 0, files: ["shared.ts"] },
      { issueId: "URGENT", priority: 1, files: ["shared.ts"] },
    ];
    const result = sortAndFilterNonConflicting(issues);
    expect(result.map((i) => i.issueId)).toEqual(["URGENT"]);
  });

  it("preserves relative order of same-priority issues", () => {
    const issues: IssueWithFiles[] = [
      { issueId: "FIRST", priority: 2, files: ["a.ts"] },
      { issueId: "SECOND", priority: 2, files: ["b.ts"] },
    ];
    const result = sortAndFilterNonConflicting(issues);
    expect(result.map((i) => i.issueId)).toEqual(["FIRST", "SECOND"]);
  });
});
