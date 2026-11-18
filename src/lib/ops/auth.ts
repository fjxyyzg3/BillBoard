import { createHmac, timingSafeEqual } from "node:crypto";
import argon2 from "argon2";

export const opsAdminSessionCookieName = "billboard-ops-session";

const opsAdminSessionMaxAgeMs = 8 * 60 * 60 * 1000;

export function createOpsAdminSessionToken(
  secret: string,
  issuedAt = new Date(),
): string {
  const issuedAtMs = String(issuedAt.getTime());
  const signature = signOpsAdminSessionTokenPayload(issuedAtMs, secret);

  return `${issuedAtMs}.${signature}`;
}

export function verifyOpsAdminSessionToken(
  token: string | undefined,
  secret: string,
  now = new Date(),
): boolean {
  if (!token || !secret) {
    return false;
  }

  const parts = token.split(".");

  if (parts.length !== 2) {
    return false;
  }

  const [issuedAtMsText, signature] = parts;

  if (!issuedAtMsText || !signature || !/^\d+$/.test(issuedAtMsText)) {
    return false;
  }

  const issuedAtMs = Number(issuedAtMsText);

  if (!Number.isSafeInteger(issuedAtMs)) {
    return false;
  }

  const ageMs = now.getTime() - issuedAtMs;

  if (ageMs < 0 || ageMs > opsAdminSessionMaxAgeMs) {
    return false;
  }

  const expectedSignature = signOpsAdminSessionTokenPayload(
    issuedAtMsText,
    secret,
  );

  return timingSafeStringEqual(signature, expectedSignature);
}

export async function verifyOpsAdminPassword(
  password: string,
): Promise<boolean> {
  const hash = getOpsAdminPasswordHash();

  if (!hash) {
    return false;
  }

  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

export function getOpsAdminPasswordHash(): string | null {
  return (
    normalizeOpsAdminPasswordHash(process.env.OPS_ADMIN_PASSWORD_HASH) ??
    decodeOpsAdminPasswordHashBase64(process.env.OPS_ADMIN_PASSWORD_HASH_BASE64)
  );
}

function signOpsAdminSessionTokenPayload(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function decodeOpsAdminPasswordHashBase64(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  try {
    return normalizeOpsAdminPasswordHash(
      Buffer.from(value.trim(), "base64").toString("utf8"),
    );
  } catch {
    return null;
  }
}

function normalizeOpsAdminPasswordHash(value: string | undefined): string | null {
  const hash = value?.trim();

  return hash?.startsWith("$argon2") ? hash : null;
}

function timingSafeStringEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);

  if (actualBuffer.length !== expectedBuffer.length) {
    const paddedLength = Math.max(actualBuffer.length, expectedBuffer.length);
    const paddedActual = Buffer.alloc(paddedLength);
    const paddedExpected = Buffer.alloc(paddedLength);

    actualBuffer.copy(paddedActual);
    expectedBuffer.copy(paddedExpected);
    timingSafeEqual(paddedActual, paddedExpected);

    return false;
  }

  return timingSafeEqual(actualBuffer, expectedBuffer);
}
