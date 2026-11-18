import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveTestDatabases } from "../../ops/testing/environment";
import { runTimedCommand } from "../../ops/testing/timing";

const env = {
  NODE_ENV: "test" as const,
  INTEGRATION_DATABASE_URL: "postgresql://billboard:billboard@127.0.0.1:5432/billboard_integration_test?schema=public",
  E2E_DATABASE_URL: "postgresql://billboard:billboard@127.0.0.1:5432/billboard_e2e_test?schema=public",
};
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("test database boundaries", () => {
  it("selects separate test targets regardless of an inherited application URL", () => {
    expect(resolveTestDatabases({ ...env, DATABASE_URL: "postgresql://private.invalid/production" }))
      .toEqual({ integration: env.INTEGRATION_DATABASE_URL, e2e: env.E2E_DATABASE_URL });
  });

  it.each([
    "postgresql://billboard:secret@127.0.0.1:5432/billboard_dev",
    env.INTEGRATION_DATABASE_URL,
    "postgresql://billboard:secret@remote.example:5432/billboard_e2e_test",
    `${env.E2E_DATABASE_URL}&schema=other`,
    `${env.E2E_DATABASE_URL}&host=remote.example`,
    "not-a-url-with-private-secret",
  ])("rejects unsafe or overlapping E2E targets without echoing connection details (%#)", (value) => {
    expect(() => resolveTestDatabases({ ...env, E2E_DATABASE_URL: value })).toThrow(/^e2e requires a loopback/);
  });

  it("refuses a production process even when both test URLs look safe", () => {
    expect(() => resolveTestDatabases({ ...env, NODE_ENV: "production" })).toThrow("NODE_ENV=production");
  });
});

describe("verification timing", () => {
  it.each([0, 7])("preserves child exit code %i and records duration without arguments or environment", async (exitCode) => {
    const directory = mkdtempSync(join(tmpdir(), "billboard-timing-"));
    directories.push(directory);
    const result = await runTimedCommand({
      suite: "synthetic", scope: "focused", directory,
      env: { ...process.env, SYNTHETIC_PRIVATE_VALUE: "must-not-be-recorded" },
      args: ["-e", `process.exit(${exitCode})`, "must-not-be-recorded"],
    });
    expect(result.exitCode).toBe(exitCode);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.scope).toBe("focused");
    const report = readFileSync(join(directory, "synthetic.json"), "utf8");
    expect(JSON.parse(report)).toEqual(result);
    expect(report).not.toContain("must-not-be-recorded");
    expect(report).not.toContain("SYNTHETIC_PRIVATE_VALUE");
  });
});
