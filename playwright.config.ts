import { defineConfig } from "@playwright/test";
import { loadTestEnvironment } from "./ops/testing/environment";

loadTestEnvironment("e2e");

export default defineConfig({
  forbidOnly: true,
  // Cases share one E2E-only database and global login admission state.
  workers: 1,
  globalSetup: "./tests/e2e/global-setup.ts",
  globalTeardown: "./tests/e2e/global-teardown.ts",
  testDir: "./tests/e2e",
  reporter: [["list"], ["./ops/testing/playwright-reporter.ts"]],
  use: {
    baseURL: "http://127.0.0.1:2501",
    trace: "on-first-retry",
  },
});
