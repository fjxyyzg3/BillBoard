import { createHash, randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createHouseholdCode, createKeyRing, sealKeyRing, type KeyRing } from "@/lib/encryption/crypto";
import { encryptionDatabase } from "@/lib/encryption/database";
import { runEncryptionContext } from "@/lib/encryption/request-context";

process.loadEnvFile(".env.example");

let raw: PrismaClient;
let db: typeof import("@/lib/db").db;
let listRecords: typeof import("@/lib/records/list-records").listRecords;
let createTransaction: typeof import("@/lib/transactions/create-transaction").createTransaction;
let updateTransaction: typeof import("@/lib/transactions/update-transaction").updateTransaction;
let deleteTransaction: typeof import("@/lib/transactions/delete-transaction").deleteTransaction;
let naturalLanguage: typeof import("@/lib/transactions/natural-language-entry");
const householdIds: string[] = [];
const userIds: string[] = [];
const categoryIds: string[] = [];
let categories: { expense: string; alternate: string; income: string } | undefined;
const now = new Date("2026-04-03T04:00:00.123Z");
const rangeBounds = { from: new Date("2026-03-31T16:00:00.000Z"), to: new Date("2026-04-30T15:59:59.999Z") };

type Fixture = {
  householdId: string; id: string; memberId: string; appSessionId: string; formerId: string;
  ledgerId: string; secondLedgerId: string; expense: string; alternate: string; income: string; ring: KeyRing | null; revision: number;
};

async function within<T>(f: Pick<Fixture, "householdId" | "id" | "memberId" | "appSessionId" | "ring" | "revision">, work: () => Promise<T>): Promise<T> {
  if (!f.ring) return work();
  return runEncryptionContext({
    session: { id: f.id, householdId: f.householdId, memberId: f.memberId, appSessionId: f.appSessionId, role: "OWNER" },
    mode: "ENCRYPTED", configMode: "ENCRYPTED", revision: f.revision, ring: structuredClone(f.ring),
    expiresAt: Date.now() + 60_000, disposed: false, readOnly: false,
  }, work);
}

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL ?? "");
  if (process.env.NODE_ENV === "production" || !["localhost", "127.0.0.1"].includes(url.hostname) || !/_(dev|test)$/.test(url.pathname)) {
    throw new Error("A local development/test database is required for encrypted query semantics");
  }
  raw = new PrismaClient();
  ({ db } = await import("@/lib/db"));
  ({ listRecords } = await import("@/lib/records/list-records"));
  ({ createTransaction } = await import("@/lib/transactions/create-transaction"));
  ({ updateTransaction } = await import("@/lib/transactions/update-transaction"));
  ({ deleteTransaction } = await import("@/lib/transactions/delete-transaction"));
  naturalLanguage = await import("@/lib/transactions/natural-language-entry");
});

afterEach(async () => {
  if (!raw) return;
  await raw.transaction.deleteMany({ where: { householdId: { in: householdIds } } });
  await raw.naturalLanguageRequest.deleteMany({ where: { householdId: { in: householdIds } } });
  await raw.ledgerAuditLog.deleteMany({ where: { householdId: { in: householdIds } } });
  await raw.household.deleteMany({ where: { id: { in: householdIds.splice(0) } } });
  await raw.user.deleteMany({ where: { id: { in: userIds.splice(0) } } });
  await raw.category.deleteMany({ where: { id: { in: categoryIds.splice(0) } } });
  categories = undefined;
});
afterAll(async () => { await raw?.$disconnect(); await db?.$disconnect(); });

async function fixture(encrypted: boolean): Promise<Fixture> {
  const suffix = randomUUID();
  const household = await raw.household.create({ data: { name: `Query semantics fixture ${suffix}` } });
  householdIds.push(household.id);
  const owner = await raw.user.create({ data: { email: `semantics-owner-${suffix}@example.com`, displayName: "Owner", passwordHash: "not-used" } });
  const former = await raw.user.create({ data: { email: `semantics-former-${suffix}@example.com`, displayName: "Former", passwordHash: "not-used" } });
  userIds.push(owner.id, former.id);
  const member = await raw.householdMember.create({ data: { householdId: household.id, userId: owner.id, role: "OWNER", memberName: "Owner" } });
  const history = await raw.householdMember.create({ data: { householdId: household.id, userId: former.id, role: "MEMBER", memberName: "Cafe former", leftAt: now } });
  const session = await raw.appSession.create({ data: { userId: owner.id, memberId: member.id, sessionKey: randomUUID(), expiresAt: new Date(Date.now() + 600_000) } });
  if (!categories) {
    const created = await Promise.all((["expense", "alternate", "income"] as const).map((name) => raw.category.create({
      data: { type: name === "income" ? "INCOME" : "EXPENSE", name: `Semantics ${name} ${suffix}`, sortOrder: 0 },
    })));
    categoryIds.push(...created.map(({ id }) => id));
    categories = { expense: created[0].id, alternate: created[1].id, income: created[2].id };
  }
  const code = encrypted ? createHouseholdCode(household.id) : null;
  const ring = code ? createKeyRing(code) : null;
  if (code && ring) await raw.householdEncryption.create({ data: {
    householdId: household.id, mode: "ENCRYPTED", revision: 1, generation: ring.generation,
    keyVersion: ring.currentKeyVersion, sealedKeyRing: await sealKeyRing(code, ring),
  } });
  const identity = { householdId: household.id, id: owner.id, memberId: member.id, appSessionId: session.id, ring, revision: encrypted ? 1 : 0 };
  return within(identity, async () => {
    const ledger = await db.ledger.create({ data: { householdId: household.id, name: "Private active ledger", isDefault: true } });
    const second = await db.ledger.create({ data: { householdId: household.id, name: "Private second ledger" } });
    return { ...identity, ledgerId: ledger.id, secondLedgerId: second.id, formerId: history.id, ...categories! };
  });
}

function record(f: Fixture, overrides: Partial<Prisma.TransactionUncheckedCreateInput> = {}): Prisma.TransactionUncheckedCreateInput {
  return {
    householdId: f.householdId, ledgerId: f.ledgerId, actorMemberId: f.memberId, createdByMemberId: f.memberId,
    categoryId: f.expense, type: "EXPENSE", amountFen: 100, occurredAt: now, ...overrides,
  };
}

describe("encrypted delegate query semantics", () => {
  it("filters decrypted values and relations before amount sorting and pagination", async () => {
    const results = [];
    for (const encrypted of [false, true]) {
      const f = await fixture(encrypted);
      results.push(await within(f, async () => {
        await db.transaction.createMany({ data: [
          ...Array.from({ length: 503 }, (_, index) => record(f, { id: `${f.householdId}-row-${String(index).padStart(4, "0")}`, note: "ordinary" })),
          record(f, { amountFen: 5000, note: "Private CAFE match" }),
          record(f, { amountFen: 4000, note: "Private actor match", actorMemberId: f.formerId, ledgerId: f.secondLedgerId }),
          record(f, { amountFen: 3000, note: "Private category match", categoryId: f.alternate }),
          record(f, { amountFen: 2000, note: "Private cafe match" }),
          record(f, { amountFen: 9000, note: "Private cafe deleted", deletedAt: now }),
          record(f, { amountFen: 8000, note: "Private cafe future", occurredAt: new Date("2026-05-01T00:00:00+08:00") }),
        ] });
        await db.ledger.update({ where: { id: f.secondLedgerId }, data: { archivedAt: now } });
        const rows = await listRecords({
          householdId: f.householdId, currentMemberId: f.memberId, rangeBounds,
          search: "cafe", searchCategoryIds: [f.alternate], type: "expense", amountFilter: { mode: "range", minFen: 1000 },
          sort: "amount-desc", offset: 1, limit: 2,
        });
        return rows.map(({ id: _id, ledgerId: _ledgerId, actorMemberId: _actor, createdByMemberId: _creator, ...row }) => row);
      }));
    }
    expect(results[1]).toEqual(results[0]);
    expect(results[1].map(({ amountFen }) => amountFen)).toEqual([4000, 3000]);
    expect(results[1][0]).toMatchObject({ actorMemberName: "Cafe former", actorMemberInactive: true, ledgerArchivedAt: now });
    expect(results[1][1].categoryId).toBe(categories!.alternate);
  }, 30_000);

  it("keeps all decrypted pages and hydrated relations in one snapshot while another connection commits", async () => {
    const f = await fixture(true);
    const ids = Array.from({ length: 503 }, (_, index) => `${f.householdId}-snapshot-${String(index).padStart(4, "0")}`);
    await within(f, () => db.transaction.createMany({ data: ids.map((id, index) => record(f, {
      id, ledgerId: f.secondLedgerId, actorMemberId: f.formerId,
      amountFen: index >= 500 ? 500 : 100,
      note: index >= 500 ? "Snapshot old detail" : "Snapshot baseline",
    })) }));
    let committed = false;
    let pageCount = 0;
    const observedPhysical = raw.$extends({ query: { transaction: {
      async findMany({ args, query }) {
        const rows = await query(args);
        if (args.take === 500) {
          pageCount++;
          if (!committed) {
            committed = true;
            // The global client uses another connection from the observed reader.
            await db.$transaction(async (tx) => {
              await tx.transaction.updateMany({ where: { householdId: f.householdId, id: { in: ids.slice(500) } }, data: { amountFen: 9000, note: "Snapshot new detail" } });
              await tx.ledger.update({ where: { id: f.secondLedgerId }, data: { name: "Snapshot renamed ledger" } });
              await tx.householdMember.update({ where: { id: f.formerId }, data: { memberName: "Snapshot renamed former" } });
            });
          }
        }
        return rows;
      },
    } } });
    const reader = encryptionDatabase(observedPhysical as unknown as PrismaClient);
    const query = () => reader.transaction.findMany({
      where: { householdId: f.householdId, deletedAt: null, note: { startsWith: "Snapshot" } },
      orderBy: [{ amountFen: "desc" }, { id: "asc" }], take: 3,
      select: {
        id: true, amountFen: true, note: true,
        ledger: { select: { name: true } },
        category: { select: { id: true } },
        actorMember: { select: { memberName: true, leftAt: true, user: { select: { status: true } } } },
      },
    });
    const initial = await within(f, query);
    expect(committed).toBe(true);
    expect(pageCount).toBe(2);
    expect(initial).toEqual(ids.slice(500).map((id) => ({
      id, amountFen: 500, note: "Snapshot old detail",
      ledger: { name: "Private second ledger" }, category: { id: f.expense },
      actorMember: { memberName: "Cafe former", leftAt: now, user: { status: "ACTIVE" } },
    })));
    expect(await within(f, query)).toEqual(ids.slice(500).map((id) => ({
      id, amountFen: 9000, note: "Snapshot new detail",
      ledger: { name: "Snapshot renamed ledger" }, category: { id: f.expense },
      actorMember: { memberName: "Snapshot renamed former", leftAt: now, user: { status: "ACTIVE" } },
    })));
    expect(pageCount).toBe(4);
  }, 30_000);

  it.each([false, true])("retains manual UUIDs, move authentication, historical attribution and archive write checks (encrypted=%s)", async (encrypted) => {
    const f = await fixture(encrypted);
    await within(f, async () => {
      const context = { householdId: f.householdId, memberId: f.memberId, ledgerId: f.ledgerId };
      const input = {
        context, clientRequestId: randomUUID(), type: "expense", categoryId: f.expense,
        actorMemberId: f.memberId, amount: "12.34", occurredAt: "2026-04-03T12:00", note: "Private UUID canary",
      };
      const first = await createTransaction(input, f);
      expect(await createTransaction(input, f)).toEqual({ ...first, wasCreated: false });
      await expect(createTransaction({ ...input, amount: "12.35" }, f)).rejects.toThrow("Transaction request conflicts");
      const beforeMove = await raw.transaction.findUniqueOrThrow({ where: { id: first.id }, select: { encryptedPayload: true } });
      await updateTransaction(first.id, { context, targetLedgerId: f.secondLedgerId }, f);
      expect(await db.transaction.findUniqueOrThrow({ where: { id: first.id }, select: { ledgerId: true, amountFen: true, clientRequestId: true } }))
        .toEqual({ ledgerId: f.secondLedgerId, amountFen: 1234, clientRequestId: input.clientRequestId });
      expect(await createTransaction(input, f)).toEqual({ ...first, wasCreated: false });
      if (encrypted) {
        const afterMove = await raw.transaction.findUniqueOrThrow({ where: { id: first.id }, select: { encryptedPayload: true } });
        expect(afterMove.encryptedPayload).not.toBe(beforeMove.encryptedPayload);
      }
      const historical = await db.transaction.create({ data: record(f, { actorMemberId: f.formerId, note: "Historical attribution" }) });
      await updateTransaction(historical.id, { context, note: "Historical attribution retained" }, f);
      expect(await db.transaction.findUniqueOrThrow({ where: { id: historical.id }, select: { actorMemberId: true, note: true } }))
        .toEqual({ actorMemberId: f.formerId, note: "Historical attribution retained" });
      await db.ledger.update({ where: { id: f.secondLedgerId }, data: { archivedAt: now } });
      const archivedContext = { ...context, ledgerId: f.secondLedgerId };
      await expect(updateTransaction(first.id, { context: archivedContext, note: "Blocked" }, f)).rejects.toThrow("Ledger is unavailable");
      await expect(deleteTransaction(first.id, f, archivedContext)).rejects.toThrow("Ledger is unavailable");
    });
  });

  it.each([false, true])("returns the original completed AI result and checks its original input digest without a new task (encrypted=%s)", async (encrypted) => {
    const f = await fixture(encrypted);
    await within(f, async () => {
      const requestId = randomUUID();
      const text = "PRIVATE_ORIGINAL_AI_INPUT 12.34";
      const inputHash = createHash("sha256").update(text).digest("hex");
      const referenceAt = new Date("2026-04-03T04:00:00.456Z");
      const result = { count: 1, totalAmountFen: 1234, transactionIds: [randomUUID()] };
      const stored = await db.naturalLanguageRequest.create({ data: {
        householdId: f.householdId, createdByMemberId: f.memberId, ledgerId: f.secondLedgerId,
        clientRequestId: requestId, inputHash, referenceAt, status: "SUCCEEDED", result,
      } });
      await db.ledger.update({ where: { id: f.secondLedgerId }, data: { archivedAt: now } });
      const context = { householdId: f.householdId, memberId: f.memberId, ledgerId: f.secondLedgerId };
      const cached = await naturalLanguage.createNaturalLanguageEntry({ requestId, text, locale: "zh-CN", context }, f, async () => f);
      expect(cached).toMatchObject({ wasCreated: false, result: { status: "success", requestId, count: 1, expenseAmountFen: 1234 } });
      expect(await naturalLanguage.getNaturalLanguageEntry(requestId, f, context)).toEqual(cached.result);
      expect(await naturalLanguage.createNaturalLanguageEntry({ requestId, text: `${text} changed`, locale: "zh-CN", context }, f, async () => f))
        .toMatchObject({ wasCreated: false, result: { status: "error", requestId, code: "CONFLICT" } });
      expect(await db.naturalLanguageRequest.findUniqueOrThrow({ where: { id: stored.id }, select: { inputHash: true, referenceAt: true, result: true } }))
        .toEqual({ inputHash, referenceAt, result });
      if (encrypted) {
        const physical = await raw.naturalLanguageRequest.findUniqueOrThrow({ where: { id: stored.id } });
        expect(JSON.stringify(physical).includes(inputHash)).toBe(false);
        expect(physical.result).toBeNull();
      }
    });
  });

  it.each([false, true])("preserves bulk source uniqueness instead of inserting logical duplicates (encrypted=%s)", async (encrypted) => {
    const f = await fixture(encrypted);
    await within(f, async () => {
      const sourceFingerprint = createHash("sha256").update("same-source-row").digest("hex");
      const data = record(f, { source: "sui_shou_ji", sourceFingerprint, sourceImportedAt: now });
      const inserted = await db.transaction.createManyAndReturn({ data: [{ ...data, id: randomUUID() }, { ...data, id: randomUUID() }], skipDuplicates: true });
      expect(inserted).toHaveLength(1);
      expect(await db.transaction.count({ where: { householdId: f.householdId, source: "sui_shou_ji", sourceFingerprint } })).toBe(1);
      await expect(db.transaction.create({ data: { ...data, id: randomUUID() } })).rejects.toMatchObject({ code: "P2002" });
    });
  });

  it("retains source deduplication against soft-deleted rows after a wrapping-key rotation", async () => {
    const f = await fixture(true);
    const sourceFingerprint = createHash("sha256").update("original-source-row").digest("hex");
    const data = record(f, { source: "sui_shou_ji", sourceFingerprint, sourceImportedAt: now, deletedAt: now });
    const original = await within(f, () => db.transaction.create({ data }));
    const code = createHouseholdCode(f.householdId, f.ring!.generation, f.ring!.currentKeyVersion + 1);
    const ring = createKeyRing(code, f.ring!);
    await raw.householdEncryption.update({ where: { householdId: f.householdId }, data: {
      revision: 2, keyVersion: ring.currentKeyVersion, sealedKeyRing: await sealKeyRing(code, ring),
    } });
    f.ring = ring;
    f.revision = 2;
    await within(f, async () => {
      expect(await db.transaction.createManyAndReturn({ data: [{ ...data, id: randomUUID(), deletedAt: null }], skipDuplicates: true })).toEqual([]);
      await expect(db.transaction.create({ data: { ...data, id: randomUUID(), deletedAt: null } })).rejects.toMatchObject({ code: "P2002" });
      expect(await db.transaction.findUniqueOrThrow({ where: { id: original.id }, select: { sourceFingerprint: true, deletedAt: true } }))
        .toEqual({ sourceFingerprint, deletedAt: now });
      expect(await db.transaction.count({ where: { householdId: f.householdId } })).toBe(1);
    });
  });
});
