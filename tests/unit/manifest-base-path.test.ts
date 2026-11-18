import { afterEach, describe, expect, it } from "vitest";
import manifest from "@/app/manifest";
import packageJson from "../../package.json";

describe("manifest base path", () => {
  const originalBasePath = process.env.APP_BASE_PATH;

  afterEach(() => {
    if (originalBasePath === undefined) {
      delete process.env.APP_BASE_PATH;
    } else {
      process.env.APP_BASE_PATH = originalBasePath;
    }
  });

  it("uses root-relative PWA paths by default", () => {
    delete process.env.APP_BASE_PATH;

    const value = manifest();

    expect(value.start_url).toBe("/home");
    expect(value.scope).toBe("/");
    expect(value.icons?.[0]?.src).toBe(`/icons/icon-192.png?v=${packageJson.version}`);
    expect(value.icons?.map((icon) => icon.purpose)).toEqual(["any", "any", "maskable"]);
  });

  it("prefixes PWA paths when an optional base path is configured", () => {
    process.env.APP_BASE_PATH = "/ledger";

    const value = manifest();

    expect(value.start_url).toBe("/ledger/home");
    expect(value.scope).toBe("/ledger/");
    expect(value.icons?.map((icon) => icon.src)).toEqual([
      `/ledger/icons/icon-192.png?v=${packageJson.version}`,
      `/ledger/icons/icon-512.png?v=${packageJson.version}`,
      `/ledger/icons/icon-maskable-512.png?v=${packageJson.version}`,
    ]);
  });
});
