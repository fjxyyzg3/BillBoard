import { defineConfig } from "@playwright/test";
import { loadEnvFile } from "node:process";

try {
  loadEnvFile(".env");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
    throw error;
  }
}

loadEnvFile(".env.example");

export default defineConfig({
  globalSetup: "./tests/e2e/global-setup.ts",
  globalTeardown: "./tests/e2e/global-teardown.ts",
  testDir: "./tests/e2e",
  use: {
    baseURL: "http://127.0.0.1:2500",
    trace: "on-first-retry",
  },
  webServer: {
    command: "npm run dev",
    port: 2500,
    reuseExistingServer: !process.env.CI,
  },
});
