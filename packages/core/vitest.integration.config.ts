import { defineConfig } from "vitest/config";

/**
 * Integration test configuration.
 *
 * Runs heavy git / cross-worktree tests (BEC-99 related) that each take 8-10s.
 * These are excluded from the default `pnpm test` run to keep unit test feedback fast.
 *
 * Usage:
 *   pnpm --filter @urateam/core test:integration
 *   # or from the repo root:
 *   pnpm test:integration
 */
export default defineConfig({
  test: {
    include: ["src/__tests__/integration/**/*.test.ts"],
    passWithNoTests: true,
    // Integration tests perform real git worktree operations that can take 10-15s
    testTimeout: 60_000,
    // Run integration tests sequentially to avoid git resource contention
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
