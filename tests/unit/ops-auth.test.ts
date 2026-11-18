import argon2 from "argon2";
import { afterEach, describe, expect, it } from "vitest";
import {
  createOpsAdminSessionToken,
  opsAdminSessionCookieName,
  verifyOpsAdminPassword,
  verifyOpsAdminSessionToken,
} from "@/lib/ops/auth";
import { getOpsAdminConfig, isOpsAdminInstance } from "@/lib/ops/config";

const opsEnvKeys = [
  "OPS_ADMIN_INSTANCE",
  "OPS_ADMIN_ENABLED",
  "OPS_ADMIN_PASSWORD_HASH",
  "OPS_ADMIN_PASSWORD_HASH_BASE64",
] as const;

const originalOpsEnv = Object.fromEntries(
  opsEnvKeys.map((key) => [key, process.env[key]]),
) as Record<(typeof opsEnvKeys)[number], string | undefined>;

afterEach(() => {
  for (const key of opsEnvKeys) {
    const value = originalOpsEnv[key];

    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("getOpsAdminConfig", () => {
  it("defaults to disabled without a password hash or ops instance", () => {
    delete process.env.OPS_ADMIN_INSTANCE;
    delete process.env.OPS_ADMIN_ENABLED;
    delete process.env.OPS_ADMIN_PASSWORD_HASH;
    delete process.env.OPS_ADMIN_PASSWORD_HASH_BASE64;

    expect(getOpsAdminConfig()).toEqual({
      enabled: false,
      hasPasswordHash: false,
      instance: false,
    });
    expect(isOpsAdminInstance()).toBe(false);
  });

  it("detects enabled ops instance and configured password hash", () => {
    process.env.OPS_ADMIN_INSTANCE = "true";
    process.env.OPS_ADMIN_ENABLED = "true";
    process.env.OPS_ADMIN_PASSWORD_HASH =
      "$argon2id$v=19$m=65536,t=3,p=4$placeholder$placeholder";
    delete process.env.OPS_ADMIN_PASSWORD_HASH_BASE64;

    expect(getOpsAdminConfig()).toEqual({
      enabled: true,
      hasPasswordHash: true,
      instance: true,
    });
    expect(isOpsAdminInstance()).toBe(true);
  });

  it("detects enabled ops instance with a base64 encoded password hash", () => {
    process.env.OPS_ADMIN_INSTANCE = "true";
    process.env.OPS_ADMIN_ENABLED = "true";
    delete process.env.OPS_ADMIN_PASSWORD_HASH;
    process.env.OPS_ADMIN_PASSWORD_HASH_BASE64 = Buffer.from(
      "$argon2id$v=19$m=65536,t=3,p=4$placeholder$placeholder",
      "utf8",
    ).toString("base64");

    expect(getOpsAdminConfig()).toEqual({
      enabled: true,
      hasPasswordHash: true,
      instance: true,
    });
  });
});

describe("verifyOpsAdminPassword", () => {
  it("returns true for the configured argon2 password hash", async () => {
    process.env.OPS_ADMIN_PASSWORD_HASH = await argon2.hash("correct-password");
    delete process.env.OPS_ADMIN_PASSWORD_HASH_BASE64;

    await expect(verifyOpsAdminPassword("correct-password")).resolves.toBe(
      true,
    );
  });

  it("returns true for a base64 encoded argon2 password hash", async () => {
    delete process.env.OPS_ADMIN_PASSWORD_HASH;
    process.env.OPS_ADMIN_PASSWORD_HASH_BASE64 = Buffer.from(
      await argon2.hash("correct-password"),
      "utf8",
    ).toString("base64");

    await expect(verifyOpsAdminPassword("correct-password")).resolves.toBe(
      true,
    );
  });

  it("falls back to the base64 hash when the direct hash is malformed", async () => {
    process.env.OPS_ADMIN_PASSWORD_HASH = "malformed-expanded-hash";
    process.env.OPS_ADMIN_PASSWORD_HASH_BASE64 = Buffer.from(
      await argon2.hash("correct-password"),
      "utf8",
    ).toString("base64");

    await expect(verifyOpsAdminPassword("correct-password")).resolves.toBe(
      true,
    );
  });

  it("returns false for an incorrect password", async () => {
    process.env.OPS_ADMIN_PASSWORD_HASH = await argon2.hash("correct-password");
    delete process.env.OPS_ADMIN_PASSWORD_HASH_BASE64;

    await expect(verifyOpsAdminPassword("wrong-password")).resolves.toBe(false);
  });

  it("returns false when the password hash is missing", async () => {
    delete process.env.OPS_ADMIN_PASSWORD_HASH;
    delete process.env.OPS_ADMIN_PASSWORD_HASH_BASE64;

    await expect(verifyOpsAdminPassword("correct-password")).resolves.toBe(
      false,
    );
  });
});

describe("ops admin session tokens", () => {
  const issuedAt = new Date("2026-05-09T01:00:00.000Z");

  it("uses the fixed session cookie name", () => {
    expect(opsAdminSessionCookieName).toBe("billboard-ops-session");
  });

  it("accepts a valid token signed with the expected secret", () => {
    const token = createOpsAdminSessionToken("session-secret", issuedAt);

    expect(
      verifyOpsAdminSessionToken(
        token,
        "session-secret",
        new Date("2026-05-09T08:59:59.000Z"),
      ),
    ).toBe(true);
  });

  it("rejects a token signed with a different secret", () => {
    const token = createOpsAdminSessionToken("session-secret", issuedAt);

    expect(
      verifyOpsAdminSessionToken(
        token,
        "other-secret",
        new Date("2026-05-09T02:00:00.000Z"),
      ),
    ).toBe(false);
  });

  it("rejects expired tokens after eight hours", () => {
    const token = createOpsAdminSessionToken("session-secret", issuedAt);

    expect(
      verifyOpsAdminSessionToken(
        token,
        "session-secret",
        new Date("2026-05-09T09:00:01.000Z"),
      ),
    ).toBe(false);
  });

  it("rejects malformed tokens", () => {
    expect(
      verifyOpsAdminSessionToken(
        "not-a-token",
        "session-secret",
        new Date("2026-05-09T02:00:00.000Z"),
      ),
    ).toBe(false);
  });
});
