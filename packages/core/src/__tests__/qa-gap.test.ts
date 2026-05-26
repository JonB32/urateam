import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { unlinkSync } from "node:fs";
import { eq, and, isNull } from "drizzle-orm";
import { createDb } from "../db/index.js";
import { qaGapIssues } from "../db/schema.js";
import { fileGapIssue, buildGapAnalysisPrompt, parseGapAnalysis } from "../qa/gap.js";

function tmpDbPath(): string {
  const id = randomBytes(8).toString("hex");
  return `/tmp/laf-qa-gap-fn-${id}.sqlite`;
}

describe("fileGapIssue", () => {
  const paths: string[] = [];
  let db: any;
  const repoUrl = "https://github.com/org/repo";
  const branch = "main";
  const workflowPath = ".github/workflows/smoke.yml";

  beforeEach(async () => {
    const path = tmpDbPath();
    paths.push(path);
    const created = await createDb({ driver: "sqlite", connectionString: path });
    db = created as any;
  });

  afterEach(() => {
    for (const p of paths) {
      try { unlinkSync(p); } catch {}
      try { unlinkSync(p + "-wal"); } catch {}
      try { unlinkSync(p + "-shm"); } catch {}
    }
    paths.length = 0;
  });

  function makeMockLinear(over: any = {}) {
    return {
      createIssue: vi.fn(async () => ({
        issue: Promise.resolve({ identifier: "BEC-150", url: "https://linear.app/beckerspace/issue/BEC-150" }),
      })),
      ...over,
    };
  }

  it("files a new issue when none exists, persists qa_gap_issues row", async () => {
    const linear = makeMockLinear();
    const result = await fileGapIssue({
      db,
      linear: linear as any,
      repoUrl,
      branch,
      workflowPath,
      linearTeamId: "team-uuid-123",
    });
    expect(result.kind).toBe("filed");
    expect(result.kind === "filed" && result.linearIssueId).toBe("BEC-150");
    expect(linear.createIssue).toHaveBeenCalledTimes(1);
    const rows = await db.select().from(qaGapIssues).where(
      and(eq(qaGapIssues.repoUrl, repoUrl), isNull(qaGapIssues.resolvedAt)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].linearIssueId).toBe("BEC-150");
  });

  it("is idempotent — second call with existing open row is a no-op", async () => {
    const linear = makeMockLinear();
    await fileGapIssue({ db, linear: linear as any, repoUrl, branch, workflowPath, linearTeamId: "team-uuid-123" });
    linear.createIssue.mockClear();

    const result = await fileGapIssue({ db, linear: linear as any, repoUrl, branch, workflowPath, linearTeamId: "team-uuid-123" });
    expect(result.kind).toBe("already_filed");
    expect(result.kind === "already_filed" && result.linearIssueId).toBe("BEC-150");
    expect(linear.createIssue).not.toHaveBeenCalled();
  });

  it("re-files when the previous row was resolved", async () => {
    const linear = makeMockLinear();
    await fileGapIssue({ db, linear: linear as any, repoUrl, branch, workflowPath, linearTeamId: "team-uuid-123" });

    // Resolve the existing row
    await db.update(qaGapIssues)
      .set({ resolvedAt: new Date() })
      .where(eq(qaGapIssues.linearIssueId, "BEC-150"));

    // Update the mock to return a new ID for the second filing
    linear.createIssue.mockResolvedValueOnce({
      issue: Promise.resolve({ identifier: "BEC-160", url: "https://linear.app/beckerspace/issue/BEC-160" }),
    });

    const result = await fileGapIssue({ db, linear: linear as any, repoUrl, branch, workflowPath, linearTeamId: "team-uuid-123" });
    expect(result.kind).toBe("filed");
    expect(result.kind === "filed" && result.linearIssueId).toBe("BEC-160");
    expect(linear.createIssue).toHaveBeenCalledTimes(2);
  });

  it("returns linear_error on Linear API failure", async () => {
    const linear = makeMockLinear({
      createIssue: vi.fn(async () => { throw new Error("Linear unauthorized"); }),
    });
    const result = await fileGapIssue({ db, linear: linear as any, repoUrl, branch, workflowPath, linearTeamId: "team-uuid-123" });
    expect(result.kind).toBe("linear_error");
    expect(result.kind === "linear_error" && result.message).toMatch(/unauthorized/);
  });

  describe("LLM analysis (QA_GAP_LLM_ANALYSIS)", () => {
    const llmResponse = JSON.stringify({
      framework: "Playwright",
      suggestedPath: "tests/smoke/smoke.spec.ts",
      infraProvider: "Vercel Preview",
      acceptanceCriteria: [
        "Add `.github/workflows/smoke.yml` with `on: workflow_dispatch`",
        "Tests run against `$PREVIEW_URL` environment variable",
        "Homepage smoke test passes (tests/smoke/smoke.spec.ts)",
      ],
      summary: "This repo looks like a Next.js app. Playwright is recommended for browser smoke tests.",
    });

    it("calls LLM once when QA_GAP_LLM_ANALYSIS=true and includes recommendations in issue body", async () => {
      const savedEnv = process.env.QA_GAP_LLM_ANALYSIS;
      process.env.QA_GAP_LLM_ANALYSIS = "true";
      try {
        const callClaude = vi.fn(async () => llmResponse);
        const linear = makeMockLinear();
        const result = await fileGapIssue({
          db,
          linear: linear as any,
          repoUrl,
          branch,
          workflowPath,
          linearTeamId: "team-uuid-123",
          callClaude,
        });
        expect(result.kind).toBe("filed");
        expect(callClaude).toHaveBeenCalledTimes(1);
        // The createIssue description must include LLM recommendations
        const description = linear.createIssue.mock.calls[0][0].description as string;
        expect(description).toContain("Playwright");
        expect(description).toContain("tests/smoke/smoke.spec.ts");
        expect(description).toContain("Vercel Preview");
        expect(description).toContain("Recommended setup (LLM analysis)");
      } finally {
        if (savedEnv === undefined) {
          delete process.env.QA_GAP_LLM_ANALYSIS;
        } else {
          process.env.QA_GAP_LLM_ANALYSIS = savedEnv;
        }
      }
    });

    it("does NOT call LLM when QA_GAP_LLM_ANALYSIS is unset, preserving static template", async () => {
      const savedEnv = process.env.QA_GAP_LLM_ANALYSIS;
      delete process.env.QA_GAP_LLM_ANALYSIS;
      try {
        const callClaude = vi.fn(async () => llmResponse);
        const linear = makeMockLinear();
        const result = await fileGapIssue({
          db,
          linear: linear as any,
          repoUrl,
          branch,
          workflowPath,
          linearTeamId: "team-uuid-123",
          callClaude,
        });
        expect(result.kind).toBe("filed");
        expect(callClaude).not.toHaveBeenCalled();
        const description = linear.createIssue.mock.calls[0][0].description as string;
        expect(description).toContain("QA workflow missing");
        expect(description).not.toContain("Recommended setup (LLM analysis)");
      } finally {
        if (savedEnv === undefined) {
          delete process.env.QA_GAP_LLM_ANALYSIS;
        } else {
          process.env.QA_GAP_LLM_ANALYSIS = savedEnv;
        }
      }
    });

    it("does NOT call LLM again on second call (already_filed idempotency)", async () => {
      const savedEnv = process.env.QA_GAP_LLM_ANALYSIS;
      process.env.QA_GAP_LLM_ANALYSIS = "true";
      try {
        const callClaude = vi.fn(async () => llmResponse);
        const linear = makeMockLinear();
        // First call — LLM should be invoked once.
        await fileGapIssue({
          db,
          linear: linear as any,
          repoUrl,
          branch,
          workflowPath,
          linearTeamId: "team-uuid-123",
          callClaude,
        });
        callClaude.mockClear();
        linear.createIssue.mockClear();

        // Second call — idempotency guard returns early; LLM must NOT be called.
        const result = await fileGapIssue({
          db,
          linear: linear as any,
          repoUrl,
          branch,
          workflowPath,
          linearTeamId: "team-uuid-123",
          callClaude,
        });
        expect(result.kind).toBe("already_filed");
        expect(callClaude).not.toHaveBeenCalled();
        expect(linear.createIssue).not.toHaveBeenCalled();
      } finally {
        if (savedEnv === undefined) {
          delete process.env.QA_GAP_LLM_ANALYSIS;
        } else {
          process.env.QA_GAP_LLM_ANALYSIS = savedEnv;
        }
      }
    });
  });
});

describe("buildGapAnalysisPrompt", () => {
  it("includes repoUrl, branch, and workflowPath in the prompt", () => {
    const prompt = buildGapAnalysisPrompt(
      "https://github.com/org/repo",
      "main",
      ".github/workflows/smoke.yml",
    );
    expect(prompt).toContain("https://github.com/org/repo");
    expect(prompt).toContain("main");
    expect(prompt).toContain(".github/workflows/smoke.yml");
    expect(prompt).toContain("JSON");
  });
});

describe("parseGapAnalysis", () => {
  it("parses a valid JSON object", () => {
    const raw = JSON.stringify({
      framework: "Playwright",
      suggestedPath: "tests/smoke.spec.ts",
      infraProvider: "Vercel Preview",
      acceptanceCriteria: ["Add workflow", "Run tests"],
      summary: "Use Playwright.",
    });
    const result = parseGapAnalysis(raw);
    expect(result).not.toBeNull();
    expect(result?.framework).toBe("Playwright");
    expect(result?.suggestedPath).toBe("tests/smoke.spec.ts");
    expect(result?.infraProvider).toBe("Vercel Preview");
    expect(result?.acceptanceCriteria).toHaveLength(2);
  });

  it("parses a JSON fenced code block", () => {
    const raw = "```json\n" + JSON.stringify({
      framework: "Jest",
      suggestedPath: "src/__tests__/smoke.test.ts",
      infraProvider: "Render Preview",
      acceptanceCriteria: ["Setup Jest"],
      summary: "Use Jest.",
    }) + "\n```";
    const result = parseGapAnalysis(raw);
    expect(result?.framework).toBe("Jest");
  });

  it("returns null for malformed JSON", () => {
    expect(parseGapAnalysis("not json at all")).toBeNull();
  });

  it("returns null when required fields are missing", () => {
    expect(parseGapAnalysis(JSON.stringify({ framework: "Playwright" }))).toBeNull();
  });
});
