import { defineConfig } from "vitest/config";

/**
 * Integration test configuration for create-urateam.
 *
 * Runs `pnpm pack` + `npm install <tarball>` in a temp dir, then exercises
 * the installed copy. Catches packaging bugs that unit tests against the
 * source tree miss (e.g. the 0.1.4 → 0.1.5 .gitignore ENOENT crash, where
 * npm strips files literally named `.gitignore` from published tarballs).
 *
 * Slow: each test pays a pack + install cost. Run via:
 *   pnpm --filter create-urateam test:integration
 */
export default defineConfig({
  test: {
    include: ["src/__tests__/integration/**/*.test.ts"],
    passWithNoTests: true,
    testTimeout: 120_000,
    hookTimeout: 120_000,
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
  },
});
