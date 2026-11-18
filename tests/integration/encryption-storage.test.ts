import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { createHouseholdCode, createKeyRing, sealKeyRing } from "@/lib/encryption/crypto";
import { runEncryptionContext } from "@/lib/encryption/request-context";

process.loadEnvFile(".env.example");
const raw = new PrismaClient();
const households: string[] = [];
const users: string[] = [];
beforeAll(() => {
  const url = new URL(process.env.DATABASE_URL!);
  if (process.env.NODE_ENV === "production" || !["localhost", "127.0.0.1"].includes(url.hostname) || !/_(dev|test)$/.test(url.pathname)) throw new Error("A local development/test database is required");
});
afterAll(async () => {
  await raw.household.deleteMany({ where: { id: { in: households } } });
  await raw.user.deleteMany({ where: { id: { in: users } } });
  await raw.$disconnect();
});

it("stores authenticated finance values outside physical columns and preserves query semantics", async () => {
  const { db } = await import("@/lib/db");
  const h = await raw.household.create({ data: { name: "Encryption storage fixture" } });
  households.push(h.id);
  const user = await raw.user.create({ data: { email: `enc-${randomUUID()}@example.com`, displayName: "Fixture", passwordHash: "fixture" } });
  users.push(user.id);
  const member = await raw.householdMember.create({ data: { householdId: h.id, userId: user.id, role: "OWNER", memberName: "Fixture" } });
  const ledger = await raw.ledger.create({ data: { householdId: h.id, name: "Fixture", isDefault: true } });
  const appSession = await raw.appSession.create({ data: { userId: user.id, memberId: member.id, sessionKey: randomUUID(), expiresAt: new Date(Date.now() + 120000) } });
  const category = await raw.category.findFirstOrThrow();
  const code = createHouseholdCode(h.id);
  const ring = createKeyRing(code);
  await raw.householdEncryption.create({ data: { householdId: h.id, mode: "ENCRYPTED", revision: 1, generation: code.generation, keyVersion: code.keyVersion, sealedKeyRing: await sealKeyRing(code, ring) } });
  await runEncryptionContext({
    session: { id: user.id, householdId: h.id, memberId: member.id, appSessionId: appSession.id, role: "OWNER" },
    mode: "ENCRYPTED", configMode: "ENCRYPTED", revision: 1, ring,
    expiresAt: Date.now() + 60000, disposed: false, readOnly: false,
  }, async () => {
    const record = await db.transaction.create({ data: { householdId: h.id, ledgerId: ledger.id, actorMemberId: member.id, createdByMemberId: member.id, type: "EXPENSE", categoryId: category.id, amountFen: 126756, occurredAt: new Date("2026-10-01T10:00:00+08:00"), note: "PRIVATE_STORAGE_CANARY_126756" } });
    const stored = await raw.transaction.findUniqueOrThrow({ where: { id: record.id } });
    expect(stored.note).not.toBe("PRIVATE_STORAGE_CANARY_126756");
    expect(stored.amountFen).not.toBe(126756);
    expect(JSON.stringify(stored)).not.toContain("PRIVATE_STORAGE_CANARY");
    expect(await db.transaction.findMany({ where: { householdId: h.id, deletedAt: null, amountFen: { gt: 120000 }, note: { contains: "CANARY" } }, select: { id: true, amountFen: true, category: { select: { id: true } } } })).toEqual([{ id: record.id, amountFen: 126756, category: { id: category.id } }]);
  });
});
