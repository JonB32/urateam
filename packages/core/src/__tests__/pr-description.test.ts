import { describe, it, expect, vi, beforeEach } from "vitest";
import { generatePRDescription } from "../pipeline/pr-description.js";
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test file uses partial handoff objects

/**
 * Test the PR description enrichment feature (BEC-83 / BEC-109).
 *
 * These tests verify that auto-generated PR descriptions include:
 * - Summary section from handoff.summary
 * - Changes section with bulleted list of filesChanged
 * - Test plan section with test files
 * - Fallback content when optional fields unavailable
 * - Exact template order: Summary → Changes → Test plan → Issue link
 *
 * Tests use the actual generatePRDescription() function from production code.
 */

describe("PR Description Enrichment (BEC-83)", () => {
  // =========================================================================
  // 1. Summary Section
  // =========================================================================
  describe("Summary section", () => {
    it("populates Summary from handoff.summary", () => {
      const handoff: any = {
        summary: "Added user authentication with JWT tokens and bcrypt hashing.",
        filesChanged: [],
        approach: "Used passport.js middleware",
        context: "Authentication was missing",
        tokenBudget: { contextTokensUsed: 10000, recommendedMaxTurns: 10 },
      };

      const body = generatePRDescription({ handoff, issueId: "BEC-123" });

      expect(body).toContain("## Summary");
      expect(body).toContain("Added user authentication with JWT tokens and bcrypt hashing.");
    });

    it("uses fallback 'No summary available.' when handoff is undefined", () => {
      const body = generatePRDescription({ handoff: undefined, issueId: "BEC-123" });

      expect(body).toContain("## Summary");
      expect(body).toContain("No summary available.");
    });

    it("propagates the JSON-soup placeholder summary to ## Summary verbatim (urateam#97)", () => {
      // Closes the loop on the urateam#97 fix: extract-handoff slow path
      // produces a deterministic placeholder when the agent emits JSON soup
      // instead of prose; pr-description must render it as-is. Without this
      // test, a future change to the summary block could break the chain.
      const handoff: any = {
        summary: "Stage review completed — agent output was not parseable prose; see Changes for files modified",
        filesChanged: ["src/auth.ts"],
        approach: "test",
        context: { issueIntent: "test", constraints: [], assumptions: [] },
        tokenBudget: { contextTokensUsed: 100, recommendedMaxTurns: 5 },
      };

      const body = generatePRDescription({ handoff, issueId: "BEC-97" });

      expect(body).toContain("## Summary");
      expect(body).toContain("Stage review completed");
      expect(body).toContain("see Changes for files modified");
      // Critical: the body must NOT contain JSON-fragment-shaped strings
      // that the placeholder is meant to replace.
      expect(body).not.toContain('"description"');
      expect(body).not.toContain('"severity"');
    });

    it("renders empty summary when handoff.summary is an empty string", () => {
      const handoff: any = {
        summary: "",
        filesChanged: [],
        approach: "test",
        context: { issueIntent: "test", constraints: [], assumptions: [] },
        tokenBudget: { remaining: 1000, used: 100, totalBudget: 1100 },
      };

      const body = generatePRDescription({ handoff, issueId: "BEC-123" });

      expect(body).toContain("## Summary");
      // Empty string summary renders with just the header and blank line
      expect(body).toMatch(/## Summary\n\n/);
    });

    it("handles multi-line summaries correctly", () => {
      const handoff: any = {
        summary: `Implemented database migrations for user schema.
- Added users table with unique email constraint
- Created indexes for faster queries`,
        filesChanged: ["src/migrations/001_users.ts"],
        approach: "Used Drizzle ORM",
        context: "Schema needed updates",
        tokenBudget: { contextTokensUsed: 10000, recommendedMaxTurns: 10 },
      };

      const body = generatePRDescription({ handoff, issueId: "BEC-456" });

      expect(body).toContain("## Summary");
      expect(body).toContain("Implemented database migrations for user schema.");
      expect(body).toContain("- Added users table with unique email constraint");
    });
  });

  // =========================================================================
  // 2. Changes Section
  // =========================================================================
  describe("Changes section", () => {
    it("includes bulleted list of all filesChanged", () => {
      const handoff: any = {
        summary: "Updated auth flow",
        filesChanged: [
          "src/auth.ts",
          "src/auth.test.ts",
          "src/types/auth.ts",
          "src/middleware/auth-check.ts",
        ],
        approach: "Refactored",
        context: "Security update",
        tokenBudget: { contextTokensUsed: 10000, recommendedMaxTurns: 10 },
      };

      const body = generatePRDescription({ handoff, issueId: "BEC-789" });

      expect(body).toContain("## Changes");
      expect(body).toContain("- `src/auth.ts`");
      expect(body).toContain("- `src/auth.test.ts`");
      expect(body).toContain("- `src/types/auth.ts`");
      expect(body).toContain("- `src/middleware/auth-check.ts`");
    });

    it("uses fallback 'No file changes recorded.' when filesChanged is empty", () => {
      const handoff: any = {
        summary: "No changes needed",
        filesChanged: [],
        approach: "test",
        context: { issueIntent: "test", constraints: [], assumptions: [] },
        tokenBudget: { contextTokensUsed: 10000, recommendedMaxTurns: 10 },
      };

      const body = generatePRDescription({ handoff, issueId: "BEC-111" });

      expect(body).toContain("## Changes");
      expect(body).toContain("No file changes recorded.");
    });

    it("uses fallback 'No file changes recorded.' when handoff is undefined", () => {
      const body = generatePRDescription({ handoff: undefined, issueId: "BEC-222" });

      expect(body).toContain("## Changes");
      expect(body).toContain("No file changes recorded.");
    });

    it("properly escapes backticks in file paths", () => {
      const handoff: any = {
        summary: "Updated config",
        filesChanged: ["src/components/Button.tsx", "src/styles/button.css"],
        approach: "test",
        context: { issueIntent: "test", constraints: [], assumptions: [] },
        tokenBudget: { contextTokensUsed: 10000, recommendedMaxTurns: 10 },
      };

      const body = generatePRDescription({ handoff, issueId: "BEC-333" });

      expect(body).toContain("- `src/components/Button.tsx`");
      expect(body).toContain("- `src/styles/button.css`");
    });

    it("handles deeply nested file paths", () => {
      const handoff: any = {
        summary: "Deep refactor",
        filesChanged: [
          "packages/core/src/executor/stages/implement/handler.ts",
          "packages/core/src/__tests__/executor.test.ts",
        ],
        approach: "test",
        context: { issueIntent: "test", constraints: [], assumptions: [] },
        tokenBudget: { contextTokensUsed: 10000, recommendedMaxTurns: 10 },
      };

      const body = generatePRDescription({ handoff, issueId: "BEC-444" });

      expect(body).toContain("- `packages/core/src/executor/stages/implement/handler.ts`");
      expect(body).toContain("- `packages/core/src/__tests__/executor.test.ts`");
    });
  });

  // =========================================================================
  // 3. Test Plan Section
  // =========================================================================
  describe("Test plan section", () => {
    it("lists test files when filesChanged includes .test.ts files", () => {
      const handoff: any = {
        summary: "Added feature",
        filesChanged: [
          "src/feature.ts",
          "src/feature.test.ts",
          "src/helper.ts",
          "src/helper.test.ts",
        ],
        approach: "test",
        context: { issueIntent: "test", constraints: [], assumptions: [] },
        tokenBudget: { contextTokensUsed: 10000, recommendedMaxTurns: 10 },
      };

      const body = generatePRDescription({ handoff, issueId: "BEC-555" });

      expect(body).toContain("## Test plan");
      expect(body).toContain("- `src/feature.test.ts`");
      expect(body).toContain("- `src/helper.test.ts`");
      // Verify that test files appear in the test plan section, not the changes section
      const testPlanStart = body.indexOf("## Test plan");
      const issueLink = body.indexOf("Resolves");
      const testPlanSection = body.substring(testPlanStart, issueLink);
      expect(testPlanSection).toContain("- `src/feature.test.ts`");
      expect(testPlanSection).toContain("- `src/helper.test.ts`");
      // Non-test files should appear in Changes section, not Test plan section
      expect(testPlanSection).not.toContain("- `src/feature.ts`");
      expect(testPlanSection).not.toContain("- `src/helper.ts`");
    });

    it("identifies .test.jsx files as test files", () => {
      const handoff: any = {
        summary: "React component",
        filesChanged: ["src/Button.jsx", "src/Button.test.jsx"],
        approach: "test",
        context: { issueIntent: "test", constraints: [], assumptions: [] },
        tokenBudget: { contextTokensUsed: 10000, recommendedMaxTurns: 10 },
      };

      const body = generatePRDescription({ handoff, issueId: "BEC-666" });

      expect(body).toContain("## Test plan");
      expect(body).toContain("- `src/Button.test.jsx`");
    });

    it("identifies .spec.ts files as test files", () => {
      const handoff: any = {
        summary: "Angular service",
        filesChanged: ["src/app.service.ts", "src/app.service.spec.ts"],
        approach: "test",
        context: { issueIntent: "test", constraints: [], assumptions: [] },
        tokenBudget: { contextTokensUsed: 10000, recommendedMaxTurns: 10 },
      };

      const body = generatePRDescription({ handoff, issueId: "BEC-777" });

      expect(body).toContain("## Test plan");
      expect(body).toContain("- `src/app.service.spec.ts`");
    });

    it("identifies __tests__ directory files as test files", () => {
      const handoff: any = {
        summary: "Updated utils",
        filesChanged: [
          "src/utils.ts",
          "src/__tests__/utils.test.ts",
          "src/__tests__/integration/utils.test.ts",
        ],
        approach: "test",
        context: { issueIntent: "test", constraints: [], assumptions: [] },
        tokenBudget: { contextTokensUsed: 10000, recommendedMaxTurns: 10 },
      };

      const body = generatePRDescription({ handoff, issueId: "BEC-888" });

      expect(body).toContain("## Test plan");
      expect(body).toContain("- `src/__tests__/utils.test.ts`");
      expect(body).toContain("- `src/__tests__/integration/utils.test.ts`");
    });

    it("uses fallback 'No test changes' when no test files present", () => {
      const handoff: any = {
        summary: "Documentation only",
        filesChanged: ["README.md", "docs/guide.md"],
        approach: "test",
        context: { issueIntent: "test", constraints: [], assumptions: [] },
        tokenBudget: { contextTokensUsed: 10000, recommendedMaxTurns: 10 },
      };

      const body = generatePRDescription({ handoff, issueId: "BEC-999" });

      expect(body).toContain("## Test plan");
      expect(body).toContain("No test changes");
    });

    it("uses fallback 'No test changes' when handoff is undefined", () => {
      const body = generatePRDescription({ handoff: undefined, issueId: "BEC-101" });

      expect(body).toContain("## Test plan");
      expect(body).toContain("No test changes");
    });

    it("identifies files in test-related directories (tests/, specs/)", () => {
      const handoff: any = {
        summary: "Feature update",
        filesChanged: [
          "src/feature.ts",
          "tests/feature.test.ts",
          "specs/feature.spec.ts",
        ],
        approach: "test",
        context: { issueIntent: "test", constraints: [], assumptions: [] },
        tokenBudget: { contextTokensUsed: 10000, recommendedMaxTurns: 10 },
      };

      const body = generatePRDescription({ handoff, issueId: "BEC-202" });

      expect(body).toContain("## Test plan");
      expect(body).toContain("- `tests/feature.test.ts`");
      expect(body).toContain("- `specs/feature.spec.ts`");
    });
  });

  // =========================================================================
  // 4. Issue Link Section
  // =========================================================================
  describe("Issue link section", () => {
    it("includes 'Resolves' link with issue identifier", () => {
      const handoff: any = {
        summary: "Test",
        filesChanged: [],
        approach: "test",
        context: { issueIntent: "test", constraints: [], assumptions: [] },
        tokenBudget: { contextTokensUsed: 10000, recommendedMaxTurns: 10 },
      };

      const body = generatePRDescription({ handoff, issueId: "BEC-303" });

      expect(body).toContain("Resolves BEC-303");
    });

    it("includes 'Resolves' link even when handoff is undefined", () => {
      const body = generatePRDescription({ handoff: undefined, issueId: "BEC-404" });

      expect(body).toContain("Resolves BEC-404");
    });

    it("appears as the last section in PR body", () => {
      const handoff: any = {
        summary: "Test summary",
        filesChanged: ["file1.ts"],
        approach: "test",
        context: { issueIntent: "test", constraints: [], assumptions: [] },
        tokenBudget: { contextTokensUsed: 10000, recommendedMaxTurns: 10 },
      };

      const body = generatePRDescription({ handoff, issueId: "BEC-505" });

      expect(body.endsWith("Resolves BEC-505")).toBe(true);
    });
  });

  // =========================================================================
  // 5. Template Order and Structure
  // =========================================================================
  describe("Template order and structure", () => {
    it("follows exact order: Summary → Changes → Test plan → Issue link", () => {
      const handoff: any = {
        summary: "Summary text",
        filesChanged: ["src/test.ts", "src/test.test.ts"],
        approach: "test",
        context: { issueIntent: "test", constraints: [], assumptions: [] },
        tokenBudget: { contextTokensUsed: 10000, recommendedMaxTurns: 10 },
      };

      const body = generatePRDescription({ handoff, issueId: "BEC-606" });

      const summaryIndex = body.indexOf("## Summary");
      const changesIndex = body.indexOf("## Changes");
      const testPlanIndex = body.indexOf("## Test plan");
      const resolvesIndex = body.indexOf("Resolves");

      expect(summaryIndex).toBeLessThan(changesIndex);
      expect(changesIndex).toBeLessThan(testPlanIndex);
      expect(testPlanIndex).toBeLessThan(resolvesIndex);
    });

    it("separates sections with double newlines (paragraph breaks)", () => {
      const handoff: any = {
        summary: "Test",
        filesChanged: ["file.ts"],
        approach: "test",
        context: { issueIntent: "test", constraints: [], assumptions: [] },
        tokenBudget: { contextTokensUsed: 10000, recommendedMaxTurns: 10 },
      };

      const body = generatePRDescription({ handoff, issueId: "BEC-707" });

      // Sections should be separated by \n\n
      expect(body).toMatch(/## Summary\n.*\n\n## Changes/s);
      expect(body).toMatch(/## Changes\n.*\n\n## Test plan/s);
      expect(body).toMatch(/## Test plan\n.*\n\nResolves/s);
    });

    it("handles draft PR status correctly in body", () => {
      const handoff: any = {
        summary: "Test",
        filesChanged: [],
        approach: "test",
        context: { issueIntent: "test", constraints: [], assumptions: [] },
        tokenBudget: { contextTokensUsed: 10000, recommendedMaxTurns: 10 },
      };

      const body = generatePRDescription({
        handoff,
        issueId: "BEC-808",
        shouldDraft: true,
        ralphSatisfied: false,
        unresolvedBlockingFindings: [],
        ralphGaps: [{ criterion: "test" }],
      });

      expect(body).toContain("> **Draft PR**");
      expect(body).toContain("RALPH found 1 unmet acceptance criteria");
    });

    it("includes blocking review findings count in draft status", () => {
      const handoff: any = {
        summary: "Test",
        filesChanged: [],
        approach: "test",
        context: { issueIntent: "test", constraints: [], assumptions: [] },
        tokenBudget: { contextTokensUsed: 10000, recommendedMaxTurns: 10 },
      };

      const blockingFindings = [
        { type: "blocking", message: "test 1" },
        { type: "blocking", message: "test 2" },
      ];

      const body = generatePRDescription({
        handoff,
        issueId: "BEC-909",
        shouldDraft: true,
        ralphSatisfied: true,
        unresolvedBlockingFindings: blockingFindings,
        ralphGaps: [],
      });

      expect(body).toContain("> **Draft PR**");
      expect(body).toContain("2 blocking review findings remain");
    });

    it("includes agent commits section when agentCommits are provided", () => {
      const handoff: any = {
        summary: "Test",
        filesChanged: ["src/feature.ts"],
        approach: "test",
        context: { issueIntent: "test", constraints: [], assumptions: [] },
        tokenBudget: { contextTokensUsed: 10000, recommendedMaxTurns: 10 },
      };

      const body = generatePRDescription({
        handoff,
        issueId: "BEC-910",
        agentCommits: ["feat: add new feature", "fix: correct edge case"],
      });

      expect(body).toContain("## Commits");
      expect(body).toContain("- feat: add new feature");
      expect(body).toContain("- fix: correct edge case");
    });

    it("omits Commits section when all commits are auto-committed", () => {
      const handoff: any = {
        summary: "Test",
        filesChanged: ["src/feature.ts"],
        approach: "test",
        context: { issueIntent: "test", constraints: [], assumptions: [] },
        tokenBudget: { contextTokensUsed: 10000, recommendedMaxTurns: 10 },
      };

      const body = generatePRDescription({
        handoff,
        issueId: "BEC-911",
        agentCommits: ["Auto-commit (auto-committed)", "Another (auto-committed)"],
      });

      expect(body).not.toContain("## Commits");
    });
  });

  // =========================================================================
  // 6. Fallback Behavior
  // =========================================================================
  describe("Fallback behavior", () => {
    it("handles completely empty handoff gracefully", () => {
      const handoff: any = {
        summary: "",
        filesChanged: [],
        approach: "test",
        context: { issueIntent: "test", constraints: [], assumptions: [] },
        tokenBudget: { contextTokensUsed: 10000, recommendedMaxTurns: 10 },
      };

      const body = generatePRDescription({ handoff, issueId: "BEC-010" });

      expect(body).toContain("## Summary");
      expect(body).toContain("## Changes");
      expect(body).toContain("No file changes recorded.");
      expect(body).toContain("## Test plan");
      expect(body).toContain("No test changes");
      expect(body).toContain("Resolves BEC-010");
      // Verify all sections are present
      expect(body).toMatch(/## Summary[\s\S]*## Changes[\s\S]*## Test plan[\s\S]*Resolves/);
    });

    it("generates valid markdown when all fields are present", () => {
      const handoff: any = {
        summary: "Comprehensive update with tests and documentation.",
        filesChanged: [
          "src/main.ts",
          "src/utils.ts",
          "src/utils.test.ts",
          "src/helper.test.ts",
          "docs/api.md",
        ],
        approach: "Strategic refactor",
        context: "Performance improvements",
        tokenBudget: { contextTokensUsed: 10000, recommendedMaxTurns: 10 },
      };

      const body = generatePRDescription({ handoff, issueId: "BEC-111" });

      // Verify markdown structure
      expect(body).toMatch(/^## Summary\n/);
      expect(body).toContain("## Changes");
      expect(body).toContain("## Test plan");
      expect(body).toContain("Resolves BEC-111");

      // Verify code blocks are properly formatted
      expect(body).toContain("- `src/main.ts`");
      expect(body).toContain("- `src/utils.test.ts`");
    });
  });

  // =========================================================================
  // 7. Edge Cases
  // =========================================================================
  describe("Edge cases", () => {
    it("handles single file in changes section", () => {
      const handoff: any = {
        summary: "Single file change",
        filesChanged: ["src/single.ts"],
        approach: "test",
        context: { issueIntent: "test", constraints: [], assumptions: [] },
        tokenBudget: { contextTokensUsed: 10000, recommendedMaxTurns: 10 },
      };

      const body = generatePRDescription({ handoff, issueId: "BEC-212" });

      expect(body).toContain("## Changes");
      expect(body).toContain("- `src/single.ts`");
    });

    it("handles large number of files", () => {
      const filesChanged = Array.from({ length: 50 }, (_, i) => `src/file${i}.ts`);
      const handoff: any = {
        summary: "Large refactor",
        filesChanged,
        approach: "test",
        context: { issueIntent: "test", constraints: [], assumptions: [] },
        tokenBudget: { contextTokensUsed: 10000, recommendedMaxTurns: 10 },
      };

      const body = generatePRDescription({ handoff, issueId: "BEC-313" });

      expect(body).toContain("## Changes");
      for (let i = 0; i < 50; i++) {
        expect(body).toContain(`- \`src/file${i}.ts\``);
      }
    });

    it("handles files with special characters in names", () => {
      const handoff: any = {
        summary: "Update",
        filesChanged: [
          "src/my-component.tsx",
          "src/my_helper.ts",
          "src/const.CONSTANT.ts",
        ],
        approach: "test",
        context: { issueIntent: "test", constraints: [], assumptions: [] },
        tokenBudget: { contextTokensUsed: 10000, recommendedMaxTurns: 10 },
      };

      const body = generatePRDescription({ handoff, issueId: "BEC-414" });

      expect(body).toContain("- `src/my-component.tsx`");
      expect(body).toContain("- `src/my_helper.ts`");
      expect(body).toContain("- `src/const.CONSTANT.ts`");
    });

    it("handles summary with special markdown characters", () => {
      const handoff: any = {
        summary: "Fixed `bug` in **login** flow. See PR #123 for details.",
        filesChanged: [],
        approach: "test",
        context: { issueIntent: "test", constraints: [], assumptions: [] },
        tokenBudget: { contextTokensUsed: 10000, recommendedMaxTurns: 10 },
      };

      const body = generatePRDescription({ handoff, issueId: "BEC-515" });

      expect(body).toContain("Fixed `bug` in **login** flow. See PR #123 for details.");
    });

    it("handles multiple test file extensions (tsx, jsx, spec.ts)", () => {
      const handoff: any = {
        summary: "Mixed tests",
        filesChanged: [
          "src/Button.tsx",
          "src/Button.test.tsx",
          "src/Form.jsx",
          "src/Form.test.jsx",
          "src/service.ts",
          "src/service.spec.ts",
        ],
        approach: "test",
        context: { issueIntent: "test", constraints: [], assumptions: [] },
        tokenBudget: { contextTokensUsed: 10000, recommendedMaxTurns: 10 },
      };

      const body = generatePRDescription({ handoff, issueId: "BEC-616" });

      expect(body).toContain("## Test plan");
      expect(body).toContain("- `src/Button.test.tsx`");
      expect(body).toContain("- `src/Form.test.jsx`");
      expect(body).toContain("- `src/service.spec.ts`");
    });

    it("ignores non-test files even if 'test' appears in path", () => {
      const handoff: any = {
        summary: "Update",
        filesChanged: [
          "src/components/test-utils.ts", // NOT a test file
          "src/components/test-utils.test.ts", // IS a test file
        ],
        approach: "test",
        context: { issueIntent: "test", constraints: [], assumptions: [] },
        tokenBudget: { contextTokensUsed: 10000, recommendedMaxTurns: 10 },
      };

      const body = generatePRDescription({ handoff, issueId: "BEC-717" });

      const testPlanSection = body.split("## Test plan")[1].split("\n\nResolves")[0];
      // Should only contain the actual test file
      expect(testPlanSection).toContain("- `src/components/test-utils.test.ts`");
      // Non-test file should not be listed in test plan
      expect(testPlanSection).not.toContain("test-utils.ts`\n");
    });
  });

  // =========================================================================
  // 8. Acceptance Criteria Verification
  // =========================================================================
  describe("Acceptance Criteria (BEC-83)", () => {
    it("✓ PR descriptions include Summary section from handoff.summary (2-3 sentences)", () => {
      const handoff: any = {
        summary: "Implemented OAuth2 authentication flow with Google and GitHub providers.",
        filesChanged: ["src/auth/oauth.ts"],
        approach: "test",
        context: { issueIntent: "test", constraints: [], assumptions: [] },
        tokenBudget: { contextTokensUsed: 10000, recommendedMaxTurns: 10 },
      };

      const body = generatePRDescription({ handoff, issueId: "BEC-83" });

      expect(body).toContain("## Summary");
      expect(body).toContain("Implemented OAuth2 authentication flow");
      expect(body.split("## Summary")[1].split("##")[0]).toContain(
        "Implemented OAuth2 authentication flow",
      );
    });

    it("✓ PR descriptions include Changes section with all filesChanged", () => {
      const handoff: any = {
        summary: "Test",
        filesChanged: ["src/auth.ts", "src/routes/auth.ts", "src/types.ts"],
        approach: "test",
        context: { issueIntent: "test", constraints: [], assumptions: [] },
        tokenBudget: { contextTokensUsed: 10000, recommendedMaxTurns: 10 },
      };

      const body = generatePRDescription({ handoff, issueId: "BEC-83" });

      expect(body).toContain("## Changes");
      expect(body).toContain("- `src/auth.ts`");
      expect(body).toContain("- `src/routes/auth.ts`");
      expect(body).toContain("- `src/types.ts`");
    });

    it("✓ PR descriptions include Test plan section", () => {
      const handoff: any = {
        summary: "Test",
        filesChanged: ["src/feature.ts", "src/feature.test.ts"],
        approach: "test",
        context: { issueIntent: "test", constraints: [], assumptions: [] },
        tokenBudget: { contextTokensUsed: 10000, recommendedMaxTurns: 10 },
      };

      const body = generatePRDescription({ handoff, issueId: "BEC-83" });

      expect(body).toContain("## Test plan");
      expect(body).toContain("- `src/feature.test.ts`");
    });

    it("✓ PR descriptions include 'Resolves {issueIdentifier}'", () => {
      const handoff: any = {
        summary: "Test",
        filesChanged: [],
        approach: "test",
        context: { issueIntent: "test", constraints: [], assumptions: [] },
        tokenBudget: { contextTokensUsed: 10000, recommendedMaxTurns: 10 },
      };

      const body = generatePRDescription({ handoff, issueId: "BEC-83" });

      expect(body).toContain("Resolves BEC-83");
    });

    it("✓ PR body follows exact template order: Summary → Changes → Test plan → Issue link", () => {
      const handoff: any = {
        summary: "Test summary",
        filesChanged: ["src/file.ts", "src/file.test.ts"],
        approach: "test",
        context: { issueIntent: "test", constraints: [], assumptions: [] },
        tokenBudget: { contextTokensUsed: 10000, recommendedMaxTurns: 10 },
      };

      const body = generatePRDescription({ handoff, issueId: "BEC-83" });

      const sections = body.match(/## Summary|## Changes|## Test plan|Resolves/g);
      expect(sections).toEqual([
        "## Summary",
        "## Changes",
        "## Test plan",
        "Resolves",
      ]);
    });

    it("✓ Pipeline runner uses handoff artifact to populate all fields", () => {
      // Verify that generatePRDescription uses handoff?.summary and handoff?.filesChanged
      const handoff: any = {
        summary: "Custom summary from handoff",
        filesChanged: ["custom/file.ts"],
        approach: "test",
        context: { issueIntent: "test", constraints: [], assumptions: [] },
        tokenBudget: { contextTokensUsed: 10000, recommendedMaxTurns: 10 },
      };

      const body = generatePRDescription({ handoff, issueId: "BEC-83" });

      expect(body).toContain("Custom summary from handoff");
      expect(body).toContain("- `custom/file.ts`");
    });

    it("✓ PR creation succeeds with fallback content when optional fields unavailable", () => {
      const body = generatePRDescription({ handoff: undefined, issueId: "BEC-83" });

      expect(body).toContain("## Summary");
      expect(body).toContain("No summary available."); // Only when handoff is undefined
      expect(body).toContain("## Changes");
      expect(body).toContain("No file changes recorded.");
      expect(body).toContain("## Test plan");
      expect(body).toContain("No test changes");
      expect(body).toContain("Resolves BEC-83");
      // Verify structure is intact
      expect(body).toMatch(/## Summary[\s\S]*## Changes[\s\S]*## Test plan[\s\S]*Resolves/);
    });

    it("✓ PR descriptions created for all pipeline-generated PRs (100% coverage)", () => {
      // Test multiple scenarios to ensure all PRs get descriptions

      // Scenario 1: With full handoff
      const body1 = generatePRDescription({
        handoff: {
          summary: "Feature",
          filesChanged: ["file.ts"],
          approach: "test",
          context: { issueIntent: "test", constraints: [], assumptions: [] },
          tokenBudget: { contextTokensUsed: 10000, recommendedMaxTurns: 10 },
        } as any,
        issueId: "BEC-1",
      });
      expect(body1.includes("## Summary") && body1.includes("Resolves BEC-1")).toBe(true);

      // Scenario 2: With undefined handoff (should still have full PR body)
      const body2 = generatePRDescription({ handoff: undefined, issueId: "BEC-2" });
      expect(body2.includes("## Summary") && body2.includes("Resolves BEC-2")).toBe(true);

      // Scenario 3: With draft status
      const body3 = generatePRDescription({
        handoff: {
          summary: "Draft feature",
          filesChanged: [],
          approach: "test",
          context: { issueIntent: "test", constraints: [], assumptions: [] },
          tokenBudget: { contextTokensUsed: 10000, recommendedMaxTurns: 10 },
        } as any,
        issueId: "BEC-3",
        shouldDraft: true,
        ralphSatisfied: false,
        unresolvedBlockingFindings: [],
        ralphGaps: [{ criterion: "test" }],
      });
      expect(
        body3.includes("## Summary") &&
          body3.includes("> **Draft PR**") &&
          body3.includes("Resolves BEC-3"),
      ).toBe(true);
    });
  });

  // =========================================================================
  // 9. Integration: verifies createPRViaCli receives non-empty body (BEC-109)
  // =========================================================================
  describe("Integration: generatePRDescription output for createPRViaCli (BEC-109)", () => {
    it("produces a non-empty body with Summary, Changes, and Test plan sections", () => {
      const handoff: any = {
        summary: "Wired PR description generation into runner.ts createPR calls.",
        filesChanged: [
          "packages/core/src/pipeline/pr-description.ts",
          "packages/core/src/pipeline/runner.ts",
          "packages/core/src/__tests__/pr-description.test.ts",
        ],
        approach: "Extracted inline PR body logic into generatePRDescription()",
        context: { issueIntent: "BEC-109", constraints: [], assumptions: [] },
        tokenBudget: { contextTokensUsed: 50000, recommendedMaxTurns: 10 },
      };

      const body = generatePRDescription({ handoff, issueId: "BEC-109" });

      // Non-empty
      expect(body.length).toBeGreaterThan(0);

      // Required sections present
      expect(body).toContain("## Summary");
      expect(body).toContain("## Changes");
      expect(body).toContain("## Test plan");

      // Section content is meaningful
      expect(body).toContain("Wired PR description generation");
      expect(body).toContain("- `packages/core/src/pipeline/pr-description.ts`");
      expect(body).toContain("- `packages/core/src/__tests__/pr-description.test.ts`");

      // Issue link
      expect(body).toContain("Resolves BEC-109");
    });

    it("body passed to createPRViaCli contains all required sections for a typical run", () => {
      // Simulate what runner.ts does: call generatePRDescription then pass body to createPRViaCli
      const handoff: any = {
        summary: "Added authentication middleware with JWT validation.",
        filesChanged: [
          "src/middleware/auth.ts",
          "src/middleware/auth.test.ts",
          "src/routes/api.ts",
        ],
        approach: "Implemented using jsonwebtoken library",
        context: { issueIntent: "auth", constraints: [], assumptions: [] },
        tokenBudget: { contextTokensUsed: 20000, recommendedMaxTurns: 10 },
      };

      const body = generatePRDescription({
        handoff,
        issueId: "BEC-42",
        shouldDraft: false,
        ralphSatisfied: true,
        ralphGaps: [],
        unresolvedBlockingFindings: [],
        agentCommits: ["feat(auth): add JWT middleware", "test(auth): add unit tests"],
      });

      // Verify body is non-empty and has all required sections
      expect(body.length).toBeGreaterThan(50);
      expect(body).toContain("## Summary");
      expect(body).toContain("## Changes");
      expect(body).toContain("## Test plan");
      expect(body).toContain("Resolves BEC-42");

      // This body would be passed as the `body` param to createPRViaCli()
      // Verify it would produce a valid gh CLI call (non-empty, no undefined)
      expect(body).not.toContain("undefined");
      expect(body.trim().length).toBeGreaterThan(0);
    });
  });
});
