import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("authConfig", () => {
  it("uses database sessions for Task 3", () => {
    const source = readFileSync(path.resolve(process.cwd(), "src/auth.ts"), "utf8");

    expect(source).toContain('session: { strategy: "database" }');
    expect(source).toContain("PrismaAdapter(db)");
  });

  it("configures the custom login page", () => {
    const source = readFileSync(path.resolve(process.cwd(), "src/auth.ts"), "utf8");

    expect(source).toContain('pages: { signIn: "/login" }');
  });
});
