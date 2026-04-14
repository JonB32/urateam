import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Default unit-test run. Integration tests live under integration/ and
    // run via vitest.integration.config.ts so they don't slow down the inner
    // dev loop with `pnpm pack` + `npm install`.
    exclude: ["**/node_modules/**", "**/dist/**", "src/__tests__/integration/**"],
  },
});
