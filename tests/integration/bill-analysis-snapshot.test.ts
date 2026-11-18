import { randomUUID } from "node:crypto";
import { PrismaClient, type Prisma } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as crypto from "@/lib/encryption/crypto";
import { encryptRow } from "@/lib/encryption/protected-models";
import { runEncryptionContext } from "@/lib/encryption/request-context";
import type { BillAnalysisSession } from "@/lib/reports/bill-analysis-store";
import { prepareBillAnalysis } from "@/lib/reports/bill-analysis-prepare";

const scope = { mode: "month" as const, period: "2026-10", ledgerId: null, actorMemberId: null };
const now = new Date("2026-11-02T04:00:00Z");
const registered = globalThis as typeof globalThis & { prisma?: PrismaClient };
function queryClient() { return new PrismaClient({ log: [{ emit: "event", level: "query" }] }); }

describe("bounded bill analysis financial snapshots", () => {
  let raw: ReturnType<typeof queryClient>;
  let querySnapshot: typeof import("@/lib/reports/bill-analysis-snapshot").queryBillAnalysisSnapshot;
  let db: typeof import("@/lib/db").db;
  let oldPrisma: PrismaClient | undefined;
  const householdIds: string[] = [], userIds: string[] = [], categoryIds: string[] = [];
  const queries: Array<{ query: string; params: string }> = [];

  beforeAll(async () => {
    process.loadEnvFile(".env.example");
    const url = new URL(process.env.DATABASE_URL ?? "");
    if (process.env.NODE_ENV === "production" || !["127.0.0.1", "localhost"].includes(url.hostname) || !/_(dev|test)$/.test(url.pathname)) throw new Error("Snapshot tests require a local development database");
    raw = queryClient();
    raw.$on("query", (event) => queries.push({ query: event.query, params: event.params }));
    oldPrisma = registered.prisma; registered.prisma = raw;
    ({ queryBillAnalysisSnapshot: querySnapshot } = await import("@/lib/reports/bill-analysis-snapshot"));
    ({ db } = await import("@/lib/db"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await raw.household.deleteMany({ where: { id: { in: householdIds.splice(0) } } });
    await raw.user.deleteMany({ where: { id: { in: userIds.splice(0) } } });
    await raw.category.deleteMany({ where: { id: { in: categoryIds.splice(0) } } });
    queries.length = 0;
  });
  afterAll(async () => { await raw?.$disconnect(); if (oldPrisma) registered.prisma = oldPrisma; else delete registered.prisma; });

  async function fixture(encrypted = false, longIds = false) {
    const id = () => randomUUID() + (longIds ? "x".repeat(64) : "");
    const household = await raw.household.create({ data: { id: id(), name: "Synthetic snapshot family" } }); householdIds.push(household.id);
    const user = await raw.user.create({ data: { id: id(), email: `snapshot-${randomUUID()}@example.com`, displayName: "Owner", passwordHash: "not-used" } }); userIds.push(user.id);
    const member = await raw.householdMember.create({ data: { id: id(), householdId: household.id, userId: user.id, role: "OWNER", memberName: "Owner" } });
    const ledger = await raw.ledger.create({ data: { id: id(), householdId: household.id, name: "Synthetic snapshot ledger", isDefault: true } });
    const category = await raw.category.create({ data: { id: id(), name: `Snapshot category ${randomUUID()}`, type: "EXPENSE", sortOrder: 9999 } }); categoryIds.push(category.id);
    const session = await raw.appSession.create({ data: { userId: user.id, memberId: member.id, sessionKey: randomUUID(), expiresAt: new Date(Date.now() + 1_800_000) } });
    const identity: BillAnalysisSession = { id: user.id, householdId: household.id, memberId: member.id, appSessionId: session.id };
    const code = encrypted ? crypto.createHouseholdCode(household.id) : null;
    const ring = code ? crypto.createKeyRing(code) : null;
    if (code && ring) {
      const encoded = await encryptRow("ledger", ledger, ring, household.id, category.id);
      await raw.ledger.update({ where: { id: ledger.id }, data: { name: String(encoded.name), encryptedPayload: String(encoded.encryptedPayload), encryptionRevision: String(encoded.encryptionRevision) } });
      await raw.householdEncryption.create({ data: { householdId: household.id, mode: "ENCRYPTED", revision: 1, generation: ring.generation, keyVersion: ring.currentKeyVersion, sealedKeyRing: await crypto.sealKeyRing(code, ring) } });
    }
    return { identity, ledgerId: ledger.id, categoryId: category.id, ring, id };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  function inFixture<T>(f: Fixture, work: () => Promise<T>) {
    return f.ring ? runEncryptionContext({ session: { ...f.identity, role: "OWNER" }, mode: "ENCRYPTED", configMode: "ENCRYPTED", revision: 1, ring: structuredClone(f.ring), expiresAt: Date.now() + 120_000, disposed: false, readOnly: false }, work) : work();
  }
  function row(f: Fixture, values: Partial<Prisma.TransactionUncheckedCreateInput> = {}): Prisma.TransactionUncheckedCreateInput {
    return { id: f.id(), householdId: f.identity.householdId, ledgerId: f.ledgerId, actorMemberId: f.identity.memberId, createdByMemberId: f.identity.memberId, categoryId: f.categoryId, type: "EXPENSE", amountFen: 100, occurredAt: new Date("2026-10-05T00:00:00+08:00"), note: "Synthetic note", ...values };
  }

  it("decrypts each selected encrypted transaction once across multiple ciphertext pages", async () => {
    const f = await fixture(true);
    await inFixture(f, () => db.transaction.createMany({ data: Array.from({ length: 201 }, (_, index) => row(f, { amountFen: index + 1, note: "SYNTHETIC_" + "x".repeat(32 * 1024) })) }));
    const original = crypto.openEntity;
    const decrypt = vi.spyOn(crypto, "openEntity").mockImplementation((...input) => original(...input));
    const snapshot = await inFixture(f, () => querySnapshot(f.identity, scope, "zh-CN", now));
    expect(snapshot.current).toHaveLength(201);
    expect(snapshot.current.reduce((sum, item) => sum + item.amountFen, 0)).toBe(201 * 202 / 2);
    expect(decrypt.mock.calls.filter((call) => call[1].model === "transaction")).toHaveLength(201);
    expect(snapshot.firstRecordedDate).toBe("2026-10-05");
  });

  it("rejects an oversized current note before fetching its plaintext", async () => {
    const f = await fixture();
    await raw.transaction.create({ data: row(f, { note: "x".repeat(256 * 1024 + 1) }) });
    queries.length = 0;
    const result = await querySnapshot(f.identity, scope, "zh-CN", now).then(() => null, (error: unknown) => (error as { code?: string }).code);
    expect(result).toBe("TOO_LARGE");
    const noteFetches = queries.filter(({ query }) => /^SELECT/i.test(query) && query.includes('"Transaction"') && query.includes('"note"') && !query.includes("octet_length"));
    expect(noteFetches).toHaveLength(0);
  });

  it("does not retrieve comparison notes and keeps exact comparison amounts", async () => {
    const f = await fixture();
    await raw.transaction.createMany({ data: [row(f, { note: "CURRENT_备注", amountFen: 123 }), row(f, { occurredAt: new Date("2026-09-05T00:00:00+08:00"), amountFen: 456, note: "COMPARE_PRIVATE_".repeat(400_000) }), row(f, { occurredAt: new Date("2025-10-05T00:00:00+08:00"), amountFen: 789, note: "YEAR_AGO_PRIVATE" }), row(f, { deletedAt: new Date(), amountFen: 999 })] });
    queries.length = 0;
    const snapshot = await querySnapshot(f.identity, scope, "zh-CN", now);
    expect(snapshot.current).toHaveLength(1);
    expect(snapshot.current[0]).toMatchObject({ amountFen: 123, note: "CURRENT_备注" });
    expect(snapshot.previous?.rows.map(({ amountFen, note }) => ({ amountFen, note }))).toEqual([{ amountFen: 456, note: null }]);
    expect(snapshot.yearAgo?.rows.map(({ amountFen, note }) => ({ amountFen, note }))).toEqual([{ amountFen: 789, note: null }]);
    const comparisonFetches = queries.filter(({ query, params }) => /^SELECT/i.test(query) && query.includes('"Transaction"') && (params.includes("2026-08-31") || params.includes("2025-09-30")));
    expect(comparisonFetches.length).toBeGreaterThan(0);
    expect(comparisonFetches.some(({ query }) => query.includes('"note"'))).toBe(false);
  });

  it("does not charge server-only identifiers against the final model input byte budget", async () => {
    const f = await fixture(false, true);
    await raw.transaction.createMany({ data: Array.from({ length: 10_000 }, () => row(f, { note: "x".repeat(300) })) });
    queries.length = 0;
    const snapshot = await querySnapshot(f.identity, scope, "zh-CN", now);
    expect(Buffer.byteLength(JSON.stringify(snapshot.current))).toBeGreaterThan(8 * 1024 * 1024);
    expect(prepareBillAnalysis(snapshot).batches.length).toBeLessThanOrEqual(24);
  });
});
