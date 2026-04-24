import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("middleware config", () => {
  it("protects the app routes required by Task 3", () => {
    const source = readFileSync(path.resolve(process.cwd(), "src/middleware.ts"), "utf8");

    expect(source).toContain('import NextAuth from "next-auth";');
    expect(source).toContain('from "@/auth.config"');
    expect(source).toContain("const { auth } = NextAuth(authConfig);");
    expect(source).toContain("export const middleware = auth;");
    expect(source).toContain('matcher: ["/home/:path*", "/add/:path*", "/records/:path*"]');
  });
});
