import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("auth storage config", () => {
  it("removes database-session adapter remnants", () => {
    const packageJson = readFileSync(path.resolve(process.cwd(), "package.json"), "utf8");
    const schema = readFileSync(path.resolve(process.cwd(), "prisma/schema.prisma"), "utf8");

    expect(packageJson).not.toContain("@auth/prisma-adapter");
    expect(schema).not.toContain("accounts        Account[]");
    expect(schema).not.toContain("sessions        Session[]");
    expect(schema).not.toContain("model Account");
    expect(schema).not.toContain("model Session");
  });
});
