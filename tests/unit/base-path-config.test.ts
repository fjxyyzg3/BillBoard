import { pathToFileURL } from "node:url";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";
import { afterEach, describe, expect, it } from "vitest";

const nextConfigUrl = pathToFileURL(`${process.cwd()}/next.config.ts`).href;

async function loadNextConfig(caseName: string) {
  const nextConfigModule = await import(`${nextConfigUrl}?case=${caseName}-${Date.now()}`);

  return await nextConfigModule.default(PHASE_DEVELOPMENT_SERVER) as { basePath?: string };
}

describe("application base path config", () => {
  const originalBasePath = process.env.APP_BASE_PATH;

  afterEach(() => {
    if (originalBasePath === undefined) {
      delete process.env.APP_BASE_PATH;
    } else {
      process.env.APP_BASE_PATH = originalBasePath;
    }
  });

  it("keeps local development at the root path by default", async () => {
    delete process.env.APP_BASE_PATH;

    const config = await loadNextConfig("root");

    expect(config.basePath).toBeUndefined();
  });

  it("normalizes an optional relative path prefix", async () => {
    process.env.APP_BASE_PATH = "ledger/";

    const config = await loadNextConfig("ledger");

    expect(config.basePath).toBe("/ledger");
  });

  it("rejects unsafe base path values", async () => {
    process.env.APP_BASE_PATH = "https://example.com/ledger";

    await expect(loadNextConfig("unsafe")).rejects.toThrow(
      "APP_BASE_PATH must be a relative URL path",
    );
  });
});
