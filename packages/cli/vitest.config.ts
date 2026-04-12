import { defineConfig } from "vitest/config";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // Point to source so Vite can resolve the package even without a dist build.
      // vi.mock() in config.test.ts replaces the module entirely at test time.
      "@linear-agent/core": path.resolve(
        __dirname,
        "../core/src/index.ts",
      ),
    },
  },
  test: {
    include: ["src/__tests__/**/*.test.ts"],
    passWithNoTests: true,
  },
});
