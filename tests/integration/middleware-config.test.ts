import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("middleware config", () => {
  it("protects app routes with a read-only JWT gate and leaves link routes public", () => {
    const source = readFileSync(path.resolve(process.cwd(), "src/proxy.ts"), "utf8");

    expect(source).toContain('import { getToken } from "next-auth/jwt";');
    expect(source).toContain('from "@/auth.config"');
    expect(source).toContain("export async function proxy(");
    expect(source).not.toContain("NextAuth(");
    expect(source).not.toContain("encode(");
    expect(source).not.toContain('from "@/auth"');
    expect(source).not.toContain("@prisma");
    expect(source).not.toContain("argon2");
    expect(source).toContain('/^\\/(?:home|add|records|account)(?:\\/|$)/');
    expect(source).not.toContain('"/account-link"');
    expect(source).not.toContain('"/forgot-password"');
  });
});
