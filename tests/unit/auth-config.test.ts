import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("authConfig", () => {
  it("uses jwt sessions for credentials login", () => {
    const source = readFileSync(path.resolve(process.cwd(), "src/auth.ts"), "utf8");

    expect(source).toContain('session: { strategy: "jwt" }');
    expect(source).toContain("jwt: async");
  });

  it("keeps Task 3 auth limited to credentials login", () => {
    const source = readFileSync(path.resolve(process.cwd(), "src/auth.ts"), "utf8");

    expect(source).not.toContain("GitHub(");
  });

  it("configures the custom login page", () => {
    const source = readFileSync(path.resolve(process.cwd(), "src/auth.config.ts"), "utf8");

    expect(source).toContain('pages: { signIn: "/login" }');
  });
});
