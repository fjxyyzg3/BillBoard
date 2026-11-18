import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("login form base path", () => {
  it("redirects successful logins through the configured app base path", () => {
    const source = readFileSync(join(process.cwd(), "src/components/login-form.tsx"), "utf8");

    expect(source).toContain("SessionProvider");
    expect(source).toContain("basePath={authBasePath}");
    expect(source).toContain('router.replace("/home")');
    expect(source).not.toContain('window.location.href = "/home"');
  });

  it("passes the prefixed NextAuth API path from the server-rendered login page", () => {
    const source = readFileSync(join(process.cwd(), "src/app/(auth)/login/page.tsx"), "utf8");

    expect(source).toContain('withAppBasePath("/api/auth")');
    expect(source).toContain('authBasePath={withAppBasePath("/api/auth")}');
  });
});
