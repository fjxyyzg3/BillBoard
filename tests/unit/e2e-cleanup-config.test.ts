import { describe, expect, it } from "vitest";
import config from "../../playwright.config";

describe("e2e database cleanup", () => {
  it("clears transactions before and after Playwright runs", () => {
    expect(config.globalSetup).toBe("./tests/e2e/global-setup.ts");
    expect(config.globalTeardown).toBe("./tests/e2e/global-teardown.ts");
  });
});
