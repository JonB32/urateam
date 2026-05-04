import { defineConfig } from "vitest/config";

/**
 * Default unit test configuration.
 *
 * Excludes heavy git integration tests (BEC-99 cross-worktree tests, ~8-10s each)
 * so that `pnpm test` stays fast. Run integration tests separately:
 *   pnpm --filter @urateam/core test:integration
 *
 * Performance optimisation: the collection bottleneck is reduced by:
 *   1. Excluding the integration/ sub-directory from this config (fewer files to collect)
 *   2. Using a dedicated config for integration tests to avoid serial execution overhead
 *
 * See vitest.integration.config.ts for the integration test configuration.
 */
export default defineConfig({
  test: {
    include: ["src/__tests__/**/*.test.ts"],
    exclude: ["src/__tests__/integration/**/*.test.ts"],
    passWithNoTests: true,
    // 30s — license-helper-using tests (sso/policy/rbac feature-flag tests +
    // barrel re-export tests) do crypto + dynamic-import work that takes
    // 4-5s in isolation and can exceed 15s under parallel-worker contention.
    // 30s gives ~5x headroom over the slowest observed run while keeping
    // legitimately-hung tests detectable in a single CI minute.
    testTimeout: 30_000,
  },
});
