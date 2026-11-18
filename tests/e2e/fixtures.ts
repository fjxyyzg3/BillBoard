import { test as base } from "@playwright/test";
import { resetLoginBudget, resetProcessingTestState } from "./db-cleanup";

export * from "@playwright/test";

export const test = base.extend<{ loginBudgetIsolation: void }>({
  loginBudgetIsolation: [async ({ baseURL }, use) => {
    if (baseURL !== "http://127.0.0.1:2501") {
      throw new Error("Login budget isolation requires the local E2E server");
    }
    // Each case starts independently; all requests within a case use real limits.
    await resetLoginBudget();
    await resetProcessingTestState();
    await use();
  }, { auto: true }],
});
