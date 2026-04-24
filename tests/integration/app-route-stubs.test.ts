import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("authenticated route stubs", () => {
  it("provides the routes targeted by auth redirects and middleware", () => {
    expect(existsSync(path.resolve(process.cwd(), "src/app/(app)/home/page.tsx"))).toBe(true);
    expect(existsSync(path.resolve(process.cwd(), "src/app/(app)/add/page.tsx"))).toBe(true);
    expect(existsSync(path.resolve(process.cwd(), "src/app/(app)/records/page.tsx"))).toBe(true);
  });
});
