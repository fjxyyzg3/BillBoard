import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const preferenceCookie = vi.hoisted(() => ({ value: undefined as string | undefined }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => name === "billboard-ledger-preference-v1" && preferenceCookie.value ? { value: preferenceCookie.value } : undefined,
  }),
}));

process.loadEnvFile(".env.example");

let db: typeof import("@/lib/db").db;
const households: string[] = [];
const users: string[] = [];
let categoryId: string;

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  if (process.env.NODE_ENV === "production" || !["127.0.0.1", "localhost"].includes(url.hostname) || !/_(?:dev|test)$/.test(url.pathname)) {
    throw new Error("Ledger tests require a local development/test database");
  }
  ({ db } = await import("@/lib/db"));
  const category = await db.category.create({ data: { name: `Ledger test ${randomUUID()}`, type: "EXPENSE", sortOrder: 9999 } });
  categoryId = category.id;
});

afterAll(async () => {
  if (!db) return;
  await db.ledgerAuditLog.deleteMany({ where: { householdId: { in: households } } });
  await db.transaction.deleteMany({ where: { householdId: { in: households } } });
  await db.naturalLanguageRequest.deleteMany({ where: { householdId: { in: households } } });
  await db.household.deleteMany({ where: { id: { in: households } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
  if (categoryId) await db.category.delete({ where: { id: categoryId } });
  await db.$disconnect();
});

async function member(householdId: string, role: "OWNER" | "MEMBER") {
  const user = await db.user.create({ data: {
    email: `ledger-${randomUUID()}@example.com`, displayName: role, passwordHash: "test-only",
  } });
  users.push(user.id);
  const membership = await db.householdMember.create({ data: { householdId, userId: user.id, memberName: `${role}-${randomUUID()}`, role } });
  const appSession = await db.appSession.create({ data: {
    sessionKey: randomUUID(), userId: user.id, memberId: membership.id, expiresAt: new Date(Date.now() + 60_000),
  } });
  return { id: user.id, householdId, memberId: membership.id, appSessionId: appSession.id };
}

async function fixture() {
  const household = await db.household.create({ data: { name: "Ledger fixture" } });
  households.push(household.id);
  const ledger = await db.ledger.create({ data: { householdId: household.id, name: "Daily", isDefault: true } });
  const owner = await member(household.id, "OWNER");
  const regular = await member(household.id, "MEMBER");
  return { household, ledger, owner, regular };
}

async function record(current: Awaited<ReturnType<typeof fixture>>, ledgerId = current.ledger.id) {
  return db.transaction.create({ data: {
    householdId: current.household.id, ledgerId, actorMemberId: current.owner.memberId, createdByMemberId: current.owner.memberId,
    clientRequestId: randomUUID(), categoryId, type: "EXPENSE", amountFen: 12345,
    occurredAt: new Date("2026-10-20T04:03:02.000Z"), note: "Preserved note", source: "test-source",
    sourceFingerprint: randomUUID(), sourceImportedAt: new Date("2026-10-21T00:00:00.000Z"),
  } });
}

describe("shared household ledger management", () => {
  it("lets ordinary members create and rename while limiting privileged changes to the owner", async () => {
    const { createLedger, renameLedger, setDefaultLedger, archiveLedger, restoreLedger } = await import("@/lib/ledgers/service");
    const current = await fixture();
    const created = await createLedger({ name: " Travel " }, current.regular);
    expect(created).toMatchObject({ name: "Travel", isDefault: false, archivedAt: null });
    expect(await renameLedger({ ledgerId: created.id, name: "Holiday" }, current.regular)).toMatchObject({ name: "Holiday" });
    for (const action of [setDefaultLedger, archiveLedger, restoreLedger]) {
      await expect(action({ ledgerId: created.id }, current.regular)).rejects.toThrow("Forbidden");
    }
    const audits = await db.ledgerAuditLog.findMany({ where: { householdId: current.household.id }, orderBy: { createdAt: "asc" } });
    expect(audits).toHaveLength(2);
    expect(audits.map(({ action }) => action)).toEqual(expect.arrayContaining(["LEDGER_CREATED", "LEDGER_RENAMED"]));
    expect(audits.every((audit) => audit.memberId === current.regular.memberId && audit.targetId === created.id && audit.ledgerId === created.id)).toBe(true);
    expect(Object.keys(audits[0]).sort()).toEqual(["action", "createdAt", "householdId", "id", "ledgerId", "memberId", "targetId"]);
  });

  it("keeps exactly one active default and preserves archived historical totals", async () => {
    const { createLedger, setDefaultLedger, archiveLedger, restoreLedger } = await import("@/lib/ledgers/service");
    const current = await fixture();
    await db.ledger.update({ where: { id: current.ledger.id }, data: { acceptsLegacyDrafts: true } });
    const extra = await createLedger({ name: "Travel" }, current.regular);
    const historical = await record(current);
    await expect(archiveLedger({ ledgerId: current.ledger.id }, current.owner)).rejects.toThrow("Cannot archive the default ledger");
    await setDefaultLedger({ ledgerId: extra.id }, current.owner);
    expect(await db.ledger.findUnique({ where: { id: current.ledger.id } })).toMatchObject({ acceptsLegacyDrafts: true });
    expect(await db.ledger.findUnique({ where: { id: extra.id } })).toMatchObject({ acceptsLegacyDrafts: false });
    await expect(db.ledger.update({ where: { id: extra.id }, data: { acceptsLegacyDrafts: true } })).rejects.toThrow();
    expect(await db.ledger.count({ where: { householdId: current.household.id, isDefault: true, archivedAt: null } })).toBe(1);
    expect(await archiveLedger({ ledgerId: current.ledger.id }, current.owner)).toMatchObject({ archivedAt: expect.any(String), isDefault: false });
    expect(await db.transaction.aggregate({ where: { householdId: current.household.id, deletedAt: null }, _sum: { amountFen: true } })).toMatchObject({ _sum: { amountFen: historical.amountFen } });
    await expect(setDefaultLedger({ ledgerId: current.ledger.id }, current.owner)).rejects.toThrow("Ledger is unavailable");
    await restoreLedger({ ledgerId: current.ledger.id }, current.owner);
    expect(await db.ledger.findUnique({ where: { id: current.ledger.id } })).toMatchObject({ archivedAt: null, isDefault: false });
    const { loadLedgerCatalog } = await import("@/lib/ledgers/server");
    expect((await loadLedgerCatalog(current.regular)).legacyDefaultLedgerId).toBe(current.ledger.id);
  });

  it("rejects cross-household targets and revoked or historical identities before changes", async () => {
    const { createLedger, renameLedger, setDefaultLedger, archiveLedger, restoreLedger } = await import("@/lib/ledgers/service");
    const current = await fixture();
    const outside = await fixture();
    await expect(renameLedger({ ledgerId: outside.ledger.id, name: "Changed" }, current.regular)).rejects.toThrow("Ledger is unavailable");
    for (const action of [setDefaultLedger, archiveLedger, restoreLedger]) {
      await expect(action({ ledgerId: outside.ledger.id }, current.owner)).rejects.toThrow("Ledger is unavailable");
    }
    await db.appSession.update({ where: { id: current.owner.appSessionId }, data: { revokedAt: new Date() } });
    await expect(createLedger({ name: "Revoked" }, current.owner)).rejects.toThrow("Unauthorized");
    await db.householdMember.update({ where: { id: current.regular.memberId }, data: { leftAt: new Date() } });
    await expect(createLedger({ name: "Former" }, current.regular)).rejects.toThrow("Unauthorized");
    expect(await db.ledger.count({ where: { householdId: current.household.id } })).toBe(1);
    expect(await db.ledgerAuditLog.count({ where: { householdId: current.household.id } })).toBe(0);
  });

  it("serializes concurrent default changes and archive attempts without losing the default", async () => {
    const { createLedger, setDefaultLedger, archiveLedger } = await import("@/lib/ledgers/service");
    const current = await fixture();
    const target = await createLedger({ name: "Travel" }, current.regular);
    const results = await Promise.allSettled([
      setDefaultLedger({ ledgerId: target.id }, current.owner),
      archiveLedger({ ledgerId: target.id }, current.owner),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(await db.ledger.count({ where: { householdId: current.household.id, isDefault: true, archivedAt: null } })).toBe(1);
    expect(await db.ledger.count({ where: { householdId: current.household.id, isDefault: true, archivedAt: { not: null } } })).toBe(0);
  });

  it("allows archived history reads only after validating the current session and household", async () => {
    const { authorizeLedgerReadScope, loadLedgerCatalog } = await import("@/lib/ledgers/server");
    const current = await fixture();
    const outside = await fixture();
    const archived = await db.ledger.create({ data: { householdId: current.household.id, name: "Archive", archivedAt: new Date() } });
    expect(await authorizeLedgerReadScope(db, current.regular, archived.id)).toMatchObject({ ledgerId: archived.id, memberId: current.regular.memberId });
    const catalog = await loadLedgerCatalog(current.regular);
    expect(catalog).toMatchObject({ identity: { householdId: current.household.id, memberId: current.regular.memberId }, role: "MEMBER" });
    expect(catalog.legacyDefaultLedgerId).toBeUndefined();
    expect(catalog.ledgers).toEqual(expect.arrayContaining([
      { id: current.ledger.id, name: "Daily", isDefault: true, archivedAt: null },
      { id: archived.id, name: "Archive", isDefault: false, archivedAt: expect.any(String) },
    ]));
    await expect(authorizeLedgerReadScope(db, current.regular, outside.ledger.id)).rejects.toThrow("Ledger is unavailable");
    await db.appSession.update({ where: { id: current.regular.appSessionId }, data: { revokedAt: new Date() } });
    await expect(authorizeLedgerReadScope(db, current.regular, archived.id)).rejects.toThrow("Unauthorized");
  });

  it("resolves request cookies and explicit page parameters independently from the write target", async () => {
    const { resolveLedgerPageContext } = await import("@/lib/ledgers/server");
    const { serializeLedgerPreference } = await import("@/lib/ledgers/selection");
    const current = await fixture();
    const travel = await db.ledger.create({ data: { householdId: current.household.id, name: "Travel" } });
    preferenceCookie.value = serializeLedgerPreference({
      householdId: current.household.id, memberId: current.regular.memberId, scope: { kind: "household" }, entryLedgerId: travel.id,
    });
    try {
      expect(await resolveLedgerPageContext(current.regular)).toMatchObject({
        scope: { kind: "household" }, entryLedgerId: travel.id, ledgerName: travel.name,
        context: { householdId: current.household.id, memberId: current.regular.memberId, ledgerId: travel.id },
      });
      expect(await resolveLedgerPageContext(current.regular, { ledger: current.ledger.id })).toMatchObject({
        scope: { kind: "ledger", ledgerId: current.ledger.id }, entryLedgerId: current.ledger.id,
      });
      expect(await resolveLedgerPageContext(current.owner)).toMatchObject({ scope: { kind: "household" }, entryLedgerId: current.ledger.id });
      for (const params of [{ ledger: [travel.id] }, { entryLedger: [travel.id] }, { ledger: "missing" }, { entryLedger: "missing" }]) {
        await expect(resolveLedgerPageContext(current.regular, params)).rejects.toThrow("Ledger is unavailable");
      }
    } finally {
      preferenceCookie.value = undefined;
    }
  });
});

describe("single-record ledger moves", () => {
  it("moves another member's record with only the explicit source and target while preserving its original fields", async () => {
    const { updateTransaction } = await import("@/lib/transactions/update-transaction");
    const current = await fixture();
    const target = await db.ledger.create({ data: { householdId: current.household.id, name: "Travel" } });
    const original = await record(current);
    const request = await db.naturalLanguageRequest.create({ data: {
      householdId: current.household.id, ledgerId: current.ledger.id, createdByMemberId: current.owner.memberId,
      clientRequestId: original.clientRequestId!, status: "SUCCEEDED", inputHash: "original-hash", result: { transactionIds: [original.id] },
    } });
    await db.householdMember.update({ where: { id: current.owner.memberId }, data: { leftAt: new Date() } });
    await updateTransaction(original.id, {
      context: { householdId: current.household.id, memberId: current.regular.memberId, ledgerId: current.ledger.id }, targetLedgerId: target.id,
    }, current.regular);
    const moved = await db.transaction.findUniqueOrThrow({ where: { id: original.id } });
    expect(moved).toEqual({ ...original, ledgerId: target.id, updatedAt: expect.any(Date) });
    expect(await db.naturalLanguageRequest.findUnique({ where: { id: request.id } })).toEqual(request);
    expect(await db.ledgerAuditLog.findMany({ where: { targetId: original.id } })).toMatchObject([
      { action: "TRANSACTION_MOVED", memberId: current.regular.memberId, ledgerId: target.id },
    ]);
  });

  it("combines an explicit edit with a move without changing the creator or import provenance", async () => {
    const { updateTransaction } = await import("@/lib/transactions/update-transaction");
    const current = await fixture();
    const target = await db.ledger.create({ data: { householdId: current.household.id, name: "Travel" } });
    const original = await record(current);
    await updateTransaction(original.id, {
      context: { householdId: current.household.id, memberId: current.regular.memberId, ledgerId: original.ledgerId }, targetLedgerId: target.id,
      amount: "2.50", occurredAt: "2026-10-21T09:10", actorMemberId: current.regular.memberId, note: "",
    }, current.regular);
    expect(await db.transaction.findUnique({ where: { id: original.id } })).toMatchObject({
      ledgerId: target.id, amountFen: 250, occurredAt: new Date("2026-10-21T01:10:00.000Z"), actorMemberId: current.regular.memberId, note: null,
      createdByMemberId: original.createdByMemberId, source: original.source, sourceFingerprint: original.sourceFingerprint, sourceImportedAt: original.sourceImportedAt,
    });
  });

  it("refuses foreign, archived, stale-source and soft-deleted moves without a partial update", async () => {
    const { updateTransaction } = await import("@/lib/transactions/update-transaction");
    const current = await fixture();
    const outside = await fixture();
    const target = await db.ledger.create({ data: { householdId: current.household.id, name: "Travel" } });
    const archive = await db.ledger.create({ data: { householdId: current.household.id, name: "Archive", archivedAt: new Date() } });
    const original = await record(current);
    const context = { householdId: current.household.id, memberId: current.regular.memberId, ledgerId: original.ledgerId };
    for (const targetLedgerId of [outside.ledger.id, archive.id, "missing"]) {
      await expect(updateTransaction(original.id, { context, targetLedgerId, amount: "1.00" }, current.regular)).rejects.toThrow("Ledger is unavailable");
    }
    await expect(updateTransaction(original.id, { context: { ...context, ledgerId: target.id }, targetLedgerId: current.ledger.id }, current.regular)).rejects.toThrow("Transaction not found");
    expect(await db.transaction.findUnique({ where: { id: original.id } })).toEqual(original);
    const archivedRecord = await record(current, archive.id);
    await expect(updateTransaction(archivedRecord.id, { context: { ...context, ledgerId: archive.id }, targetLedgerId: target.id }, current.regular)).rejects.toThrow("Ledger is unavailable");
    await db.transaction.update({ where: { id: original.id }, data: { deletedAt: new Date() } });
    await expect(updateTransaction(original.id, { context, targetLedgerId: target.id }, current.regular)).rejects.toThrow("Transaction not found");
    expect(await db.ledgerAuditLog.count({ where: { targetId: { in: [original.id, archivedRecord.id] } } })).toBe(0);
  });

  it("requires a current explicit context and cannot move using a revoked app session", async () => {
    const { updateTransaction } = await import("@/lib/transactions/update-transaction");
    const current = await fixture();
    const original = await record(current);
    await expect(updateTransaction(original.id, { targetLedgerId: current.ledger.id }, current.regular)).rejects.toThrow();
    await db.appSession.update({ where: { id: current.regular.appSessionId }, data: { revokedAt: new Date() } });
    await expect(updateTransaction(original.id, {
      context: { householdId: current.household.id, memberId: current.regular.memberId, ledgerId: current.ledger.id }, targetLedgerId: current.ledger.id,
    }, current.regular)).rejects.toThrow("Unauthorized");
    expect(await db.transaction.findUnique({ where: { id: original.id } })).toEqual(original);
  });
});
