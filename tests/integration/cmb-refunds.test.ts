import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  CategoryType,
  HouseholdRole,
  ImportDraftRowStatus,
  ImportDraftStatus,
  ImportRowDecision,
  Prisma,
  TransactionType,
} from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  CMB_FULLY_REFUNDED,
  CMB_REFUND_MANUAL_REASONS,
  CMB_REFUND_REQUIRES_MANUAL_ADJUSTMENT,
  CMB_SOURCE,
} from "@/lib/imports/types";

process.loadEnvFile(".env.example");

let db: typeof import("@/lib/db").db;
let services: typeof import("@/lib/imports/drafts");
const householdIds: string[] = [];
const userIds: string[] = [];
const categoryIds: string[] = [];

beforeAll(async () => {
  const value = process.env.DATABASE_URL;
  if (!value || process.env.NODE_ENV === "production") {
    throw new Error("A development database is required for CMB refund integration tests");
  }
  const url = new URL(value);
  if (!["127.0.0.1", "localhost"].includes(url.hostname) || !/(?:dev|test)/i.test(url.pathname)) {
    throw new Error("Refusing a non-local or non-development CMB refund test database");
  }
  ({ db } = await import("@/lib/db"));
  services = await import("@/lib/imports/drafts");
});

afterEach(async () => {
  for (const householdId of householdIds.splice(0)) {
    await db.household.delete({ where: { id: householdId } });
  }
  await db.user.deleteMany({ where: { id: { in: userIds.splice(0) } } });
  await db.category.deleteMany({ where: { id: { in: categoryIds.splice(0) } } });
});

beforeEach(async () => {
  await db.resourceLease.deleteMany();
  await db.resourceWindow.deleteMany();
});

afterAll(async () => { await db?.$disconnect(); });

function fingerprint(label: string) {
  return createHash("sha256").update(label).digest("hex");
}

async function fixture() {
  const suffix = randomUUID();
  const household = await db.household.create({ data: { name: `CMB refunds ${suffix}` } });
  householdIds.push(household.id);
  const ledger = await db.ledger.create({ data: { householdId: household.id, name: "Default", isDefault: true } });
  const user = await db.user.create({
    data: { email: `cmb-refund-${suffix}@example.com`, displayName: "Example", passwordHash: "not-used" },
  });
  userIds.push(user.id);
  const member = await db.householdMember.create({
    data: { householdId: household.id, userId: user.id, memberName: "示例户名", role: HouseholdRole.OWNER },
  });
  const categories = await Promise.all([CategoryType.EXPENSE, CategoryType.INCOME].map((type) =>
    db.category.create({ data: { name: `CMB ${type} ${suffix}`, type, isActive: true, sortOrder: 0 } }),
  ));
  categoryIds.push(...categories.map(({ id }) => id));
  return {
    session: { householdId: household.id, memberId: member.id, ledgerId: ledger.id },
    expense: categories[0], income: categories[1],
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
type RowOverrides = Partial<Prisma.ImportDraftRowUncheckedCreateWithoutDraftInput>;

async function confirmConcurrentDraftsThenRetryBusy(ids: [string, string], session: Fixture["session"]) {
  const attempts = await Promise.allSettled(ids.map((id) => services.confirmImportDraft(id, session)));
  const busy = attempts.flatMap((attempt, index) => attempt.status === "rejected" ? [index] : []);
  expect(busy.length).toBeLessThanOrEqual(1);
  expect(await db.resourceLease.count({ where: { householdId: session.householdId } })).toBe(0);
  expect(await db.resourceWindow.findUnique({ where: { key: `import:household:${session.householdId}` } })).toMatchObject({ used: 2 - busy.length });
  const results = [];
  for (const [index, attempt] of attempts.entries()) {
    if (attempt.status === "fulfilled") {
      results.push(attempt.value);
      continue;
    }
    expect(attempt.reason).toMatchObject({ code: "BUSY" });
    expect(await db.importDraft.findUniqueOrThrow({ where: { id: ids[index] } })).toMatchObject({ status: ImportDraftStatus.PENDING, completedAt: null });
    // Simulate one explicit user retry after the accepted work finishes, using the original draft.
    results.push(await services.confirmImportDraft(ids[index], session));
  }
  expect(await db.resourceWindow.findUnique({ where: { key: `import:household:${session.householdId}` } })).toMatchObject({ used: 2 });
  expect(await db.resourceLease.count({ where: { householdId: session.householdId } })).toBe(0);
  return results;
}

async function draft(context: Fixture, overrides: RowOverrides[] = [{}]) {
  return db.importDraft.create({
    data: {
      householdId: context.session.householdId,
      ledgerId: context.session.ledgerId,
      createdByMemberId: context.session.memberId,
      fileName: "cmb.pdf",
      source: CMB_SOURCE,
      rows: {
        create: overrides.map((override, index) => ({
          rowNumber: index + 1,
          transactionType: TransactionType.EXPENSE,
          amountFen: 6000,
          occurredAt: new Date("2026-07-31T16:00:00.000Z"),
          occurredDate: "2026-08-01",
          actorMemberId: context.session.memberId,
          createdByMemberId: context.session.memberId,
          categoryId: context.expense.id,
          primaryCategory: "快捷支付",
          secondaryCategory: "示例商户",
          sourceFingerprint: fingerprint("payment"),
          refundOriginalAmountFen: 10000,
          refundSourceFingerprints: [fingerprint("refund")],
          status: ImportDraftRowStatus.READY,
          userDecision: ImportRowDecision.KEEP,
          ...override,
        })),
      },
    },
    include: { rows: true },
  });
}

function fullRow(overrides: RowOverrides = {}): RowOverrides {
  return {
    amountFen: 10000,
    status: ImportDraftRowStatus.USER_SKIPPED,
    userDecision: ImportRowDecision.SKIP,
    skipReason: CMB_FULLY_REFUNDED,
    ...overrides,
  };
}

function ordinaryRow(overrides: RowOverrides = {}): RowOverrides {
  return { amountFen: 10000, refundOriginalAmountFen: null, refundSourceFingerprints: [], ...overrides };
}

async function historicalTransaction(context: Fixture, overrides: Partial<Prisma.TransactionUncheckedCreateInput> = {}) {
  return db.transaction.create({
    data: {
      householdId: context.session.householdId,
      ledgerId: context.session.ledgerId,
      actorMemberId: context.session.memberId,
      createdByMemberId: context.session.memberId,
      categoryId: context.expense.id,
      amountFen: 10000,
      occurredAt: new Date("2026-07-31T16:00:00.000Z"),
      type: TransactionType.EXPENSE,
      source: CMB_SOURCE,
      sourceFingerprint: fingerprint("payment"),
      sourceImportedAt: new Date(),
      ...overrides,
    },
  });
}

async function expectManualReview(context: Fixture, pending: Awaited<ReturnType<typeof draft>>) {
  const result = await services.confirmImportDraft(pending.id, context.session);
  expect(result).toMatchObject({ completedNow: false, createdCount: 0, requiresReview: true });
  const stored = await db.importDraft.findUniqueOrThrow({
    where: { id: pending.id }, include: { rows: { orderBy: { rowNumber: "asc" } } },
  });
  expect(stored.status).toBe(ImportDraftStatus.PENDING);
  expect(stored.rows[0]).toMatchObject({
    skipReason: CMB_REFUND_REQUIRES_MANUAL_ADJUSTMENT,
    userDecision: ImportRowDecision.SKIP,
  });
}

describe("CMB refund persistence and confirmation", () => {
  it("persists parser refund metadata and exposes only the original amount to review", async () => {
    const context = await fixture();
    const parsed = await services.createCmbImportDraft({ context: context.session,
      buffer: await readFile(path.join(process.cwd(), "tests/fixtures/imports/cmb/statement-refunds.pdf")),
      fileName: "private-statement.pdf", sessionUser: context.session,
    });
    const rows = await db.importDraftRow.findMany({ where: { draftId: parsed.id }, orderBy: { rowNumber: "asc" } });
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ amountFen: 7000, refundOriginalAmountFen: 10000 });
    expect(rows[0].refundSourceFingerprints).toEqual([expect.stringMatching(/^[a-f0-9]{64}$/)]);
    expect(rows[1]).toMatchObject({
      amountFen: 4000, refundOriginalAmountFen: 4000,
      skipReason: CMB_FULLY_REFUNDED, status: ImportDraftRowStatus.USER_SKIPPED,
    });
    expect(rows[2]).toMatchObject({
      amountFen: 1500, refundOriginalAmountFen: null, refundSourceFingerprints: [],
      skipReason: "CMB_REFUND_PAYMENT_NOT_FOUND", status: ImportDraftRowStatus.USER_SKIPPED,
    });
    const summary = await services.getImportDraftSummary(parsed.id, context.session);
    expect(summary.rows[0].refundOriginalAmountFen).toBe(10000);
    for (const row of summary.rows) {
      expect(Object.hasOwn(row, "refundSourceFingerprints")).toBe(false);
      expect(Object.hasOwn(row, "sourceFingerprint")).toBe(false);
    }
    await services.saveImportDraftMappings(parsed.id, [{
      categoryId: context.expense.id, mappingKey: summary.rows[0].mappingKey!,
    }], context.session);
    await services.saveImportDraftMemberMappings(parsed.id, summary.memberMappings.map(({ externalName }) => ({
      externalName, memberId: context.session.memberId,
    })), context.session);
    expect(await services.confirmImportDraft(parsed.id, context.session)).toMatchObject({
      completedNow: true, createdCount: 1, userSkippedCount: 2,
    });
    const repeated = await services.createCmbImportDraft({ context: context.session,
      buffer: await readFile(path.join(process.cwd(), "tests/fixtures/imports/cmb/statement-refunds.pdf")),
      fileName: "private-statement.pdf", sessionUser: context.session,
    });
    expect((await services.getImportDraftSummary(repeated.id, context.session)).counts).toMatchObject({
      sourceDuplicate: 2, userSkipped: 1, importable: 0,
    });
  });

  it("imports one net expense, detects an exact repeat, and keeps confirmation idempotent", async () => {
    const context = await fixture();
    const first = await draft(context);
    expect(await services.confirmImportDraft(first.id, context.session)).toMatchObject({ createdCount: 1, completedNow: true });
    const repeat = await draft(context);
    expect(await services.confirmImportDraft(repeat.id, context.session)).toMatchObject({ requiresReview: true, createdCount: 0 });
    expect(await services.confirmImportDraft(repeat.id, context.session)).toMatchObject({ completedNow: true, createdCount: 0 });
    expect(await services.confirmImportDraft(first.id, context.session)).toMatchObject({ completedNow: false, createdCount: 1 });
    expect(await db.transaction.findMany({ where: { householdId: context.session.householdId } })).toMatchObject([{ amountFen: 6000 }]);
  });

  it("keeps a full-refund claim after completion and blocks old plain payment and refund rows", async () => {
    const context = await fixture();
    const first = await draft(context, [fullRow()]);
    expect(await services.confirmImportDraft(first.id, context.session)).toMatchObject({ completedNow: true, createdCount: 0 });
    const legacy = await draft(context, [ordinaryRow(), ordinaryRow({
      amountFen: 10000, sourceFingerprint: fingerprint("refund"),
      primaryCategory: "快捷退款", transactionType: TransactionType.INCOME, categoryId: context.income.id,
    })]);
    expect(await services.confirmImportDraft(legacy.id, context.session)).toMatchObject({ requiresReview: true, createdCount: 0 });
    const rows = await db.importDraftRow.findMany({ where: { draftId: legacy.id } });
    expect(rows.every(({ status }) => status === ImportDraftRowStatus.SOURCE_DUPLICATE)).toBe(true);
    expect(await db.transaction.count({ where: { householdId: context.session.householdId } })).toBe(0);
  });

  it("rejects a changed refund set even when the net amount is unchanged", async () => {
    const context = await fixture();
    await services.confirmImportDraft((await draft(context)).id, context.session);
    await expectManualReview(context, await draft(context, [{ refundSourceFingerprints: [fingerprint("different-refund")] }]));
  });

  it("does not allow another payment to reuse a consumed refund", async () => {
    const context = await fixture();
    await services.confirmImportDraft((await draft(context)).id, context.session);
    await expectManualReview(context, await draft(context, [{ sourceFingerprint: fingerprint("different-payment") }]));
  });

  it.each([false, true])("requires manual review for an existing original payment, deleted=%s", async (deleted) => {
    const context = await fixture();
    await historicalTransaction(context, { deletedAt: deleted ? new Date() : null });
    await expectManualReview(context, await draft(context));
  });

  it("does not infer a refund claim from an existing transaction with the same net amount", async () => {
    const context = await fixture();
    await historicalTransaction(context, { amountFen: 6000 });
    await expectManualReview(context, await draft(context));
  });

  it("preserves a completed claim after the net transaction is soft deleted", async () => {
    const context = await fixture();
    await services.confirmImportDraft((await draft(context)).id, context.session);
    await db.transaction.updateMany({
      where: { householdId: context.session.householdId }, data: { deletedAt: new Date() },
    });
    const plain = await draft(context, [ordinaryRow()]);
    expect(await services.confirmImportDraft(plain.id, context.session)).toMatchObject({ requiresReview: true, createdCount: 0 });
    expect((await db.importDraftRow.findFirstOrThrow({ where: { draftId: plain.id } })).status)
      .toBe(ImportDraftRowStatus.SOURCE_DUPLICATE);
    await expectManualReview(context, await draft(context, [{ refundSourceFingerprints: [fingerprint("new-refund")] }]));
    expect(await db.transaction.count({ where: { householdId: context.session.householdId } })).toBe(1);
  });

  it("compares refund identity as a set and includes the original amount", async () => {
    const context = await fixture();
    const refunds = [fingerprint("refund-1"), fingerprint("refund-2")];
    await services.confirmImportDraft((await draft(context, [{ refundSourceFingerprints: refunds }])).id, context.session);
    const repeated = await draft(context, [{ refundSourceFingerprints: [...refunds].reverse() }]);
    expect(await services.confirmImportDraft(repeated.id, context.session)).toMatchObject({ requiresReview: true, createdCount: 0 });
    expect((await db.importDraftRow.findFirstOrThrow({ where: { draftId: repeated.id } })).skipReason).toBe("Source duplicate");
    await expectManualReview(context, await draft(context, [{ refundSourceFingerprints: refunds, refundOriginalAmountFen: 11000 }]));
  });

  it.each([false, true])("requires manual review for an already imported refund, deleted=%s", async (deleted) => {
    const context = await fixture();
    await historicalTransaction(context, {
      amountFen: 4000, type: TransactionType.INCOME, categoryId: context.income.id,
      sourceFingerprint: fingerprint("refund"), deletedAt: deleted ? new Date() : null,
    });
    await expectManualReview(context, await draft(context));
  });

  it("does not claim a refund when the net row was skipped by the user", async () => {
    const context = await fixture();
    const skipped = await draft(context, [{ status: ImportDraftRowStatus.USER_SKIPPED, userDecision: ImportRowDecision.SKIP, skipReason: "User skipped" }]);
    await services.confirmImportDraft(skipped.id, context.session);
    expect(await services.confirmImportDraft((await draft(context)).id, context.session)).toMatchObject({ createdCount: 1 });
  });

  it.each([
    [ImportDraftRowStatus.USER_SKIPPED, CMB_REFUND_REQUIRES_MANUAL_ADJUSTMENT],
    [ImportDraftRowStatus.SOURCE_DUPLICATE, "Source duplicate"],
  ])("does not treat a completed %s row as a consumption claim", async (status, skipReason) => {
    const context = await fixture();
    await services.confirmImportDraft((await draft(context, [{
      status, skipReason, userDecision: ImportRowDecision.SKIP,
    }])).id, context.session);
    expect(await services.confirmImportDraft((await draft(context)).id, context.session)).toMatchObject({ createdCount: 1 });
  });

  it("recognizes a kept possible-duplicate row as an actual completed claim", async () => {
    const context = await fixture();
    await services.confirmImportDraft((await draft(context, [{ status: ImportDraftRowStatus.POSSIBLE_DUPLICATE }])).id, context.session);
    await expectManualReview(context, await draft(context, [{ sourceFingerprint: fingerprint("another-payment") }]));
  });

  it("rechecks a full refund and leaves unrelated rows unimported when history changed", async () => {
    const context = await fixture();
    const pending = await draft(context, [fullRow(), ordinaryRow({ sourceFingerprint: fingerprint("unrelated") })]);
    await historicalTransaction(context);
    await expectManualReview(context, pending);
    expect(await db.transaction.count({ where: { householdId: context.session.householdId } })).toBe(1);
  });

  it("locks an old unpaired refund for review instead of importing it as income", async () => {
    const context = await fixture();
    const pending = await draft(context, [ordinaryRow({
      sourceFingerprint: fingerprint("refund"), primaryCategory: "快捷退款",
      transactionType: TransactionType.INCOME, categoryId: context.income.id,
    })]);
    await expectManualReview(context, pending);
  });

  it.each(["partial", "full"])("serializes concurrent %s claims for the same refund", async (kind) => {
    const context = await fixture();
    const first = await draft(context, [kind === "full" ? fullRow() : {}]);
    const second = await draft(context, [kind === "full"
      ? fullRow({ sourceFingerprint: fingerprint("other-payment") })
      : { sourceFingerprint: fingerprint("other-payment") }]);
    const results = await confirmConcurrentDraftsThenRetryBusy([first.id, second.id], context.session);
    expect(results.filter(({ completedNow }) => completedNow)).toHaveLength(1);
    expect(results.filter(({ requiresReview }) => requiresReview)).toHaveLength(1);
    expect(await db.transaction.count({ where: { householdId: context.session.householdId } })).toBe(kind === "full" ? 0 : 1);
  });

  it("does not reuse a refund twice within one draft", async () => {
    const context = await fixture();
    const pending = await draft(context, [{}, { sourceFingerprint: fingerprint("other-payment") }]);
    expect(await services.confirmImportDraft(pending.id, context.session)).toMatchObject({ requiresReview: true, createdCount: 0 });
    expect(await db.transaction.count({ where: { householdId: context.session.householdId } })).toBe(0);
    expect(await db.importDraftRow.count({ where: {
      draftId: pending.id, skipReason: CMB_REFUND_REQUIRES_MANUAL_ADJUSTMENT,
    } })).toBe(2);
  });

  it.each(["partial", "full"])("serializes an old ordinary payment against a new %s claim", async (kind) => {
    const context = await fixture();
    const ordinary = await draft(context, [ordinaryRow()]);
    const merged = await draft(context, [kind === "full" ? fullRow() : {}]);
    const results = await confirmConcurrentDraftsThenRetryBusy([ordinary.id, merged.id], context.session);
    expect(results.filter(({ completedNow }) => completedNow)).toHaveLength(1);
    expect(results.filter(({ requiresReview }) => requiresReview)).toHaveLength(1);
    expect(await db.transaction.count({ where: { householdId: context.session.householdId } })).toBeLessThanOrEqual(1);
  });

  it("keeps consumption and history checks isolated by household", async () => {
    const first = await fixture();
    const second = await fixture();
    await services.confirmImportDraft((await draft(first)).id, first.session);
    expect(await services.confirmImportDraft((await draft(second)).id, second.session)).toMatchObject({ createdCount: 1 });
  });

  it.each([CMB_FULLY_REFUNDED, ...CMB_REFUND_MANUAL_REASONS])("rejects changing a locked CMB result: %s", async (skipReason) => {
    const context = await fixture();
    const pending = await draft(context, [{ status: ImportDraftRowStatus.USER_SKIPPED, userDecision: ImportRowDecision.SKIP, skipReason }]);
    await expect(services.setImportDraftRowDecision(pending.id, pending.rows[0].id, ImportRowDecision.KEEP, context.session))
      .rejects.toThrow("Import draft row decision cannot be changed");
  });
});
