import path from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: {
    environment: "node",
    allowOnly: false,
    exclude: [...configDefaults.exclude, ".worktrees/**", "tests/e2e/**"],
    reporters: ["default", "./ops/testing/vitest-reporter.ts"],
    projects: [
      { extends: true, test: {
        name: "unit", include: ["tests/unit/**/*.test.{ts,tsx}"],
        // Keep CPU-heavy crypto/import/security checks from starving each other.
        maxWorkers: 4,
      } },
      { extends: true, test: {
        name: "integration", include: ["tests/integration/**/*.test.{ts,tsx}"],
        fileParallelism: false, setupFiles: ["./tests/integration/setup.ts"],
      } },
    ],
  },
});
