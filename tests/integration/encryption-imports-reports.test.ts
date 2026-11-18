import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { CategoryType, PrismaClient, type Prisma } from "@prisma/client";
import ExcelJS from "exceljs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHouseholdCode, createKeyRing, sealKeyRing, type KeyRing } from "@/lib/encryption/crypto";
import { runEncryptionContext } from "@/lib/encryption/request-context";
import { CMB_FULLY_REFUNDED, CMB_SOURCE, SUI_SHOU_JI_SOURCE, WECHAT_PAY_SOURCE, WECHAT_REFUND_REQUIRES_MANUAL_ADJUSTMENT } from "@/lib/imports/types";
import { parseSuiShouJiWorkbook } from "@/lib/imports/sources/sui-shou-ji";
import type { ReportRange } from "@/lib/reports/report-range";

vi.mock("server-only", () => ({}));

if (existsSync(".env.example")) process.loadEnvFile?.(".env.example");

let raw: PrismaClient;
let db: typeof import("@/lib/db").db;
let drafts: typeof import("@/lib/imports/drafts");
let queryHomeReport: typeof import("@/lib/reports/query-home-report").queryHomeReport;
let queryReportAnalytics: typeof import("@/lib/reports/query-report-analytics").queryReportAnalytics;
let queryRecentCategoryUsage: typeof import("@/lib/transactions/query-category-preferences").queryRecentCategoryUsage;
let rules: typeof import("@/lib/imports/category-mapping-rules");
let management: typeof import("@/lib/imports/category-mapping-management");
let classifyCmbRefundHistory: typeof import("@/lib/imports/cmb-refund-history").classifyCmbRefundHistory;
const householdIds: string[] = [];
const userIds: string[] = [];
const memberIds: string[] = [];
const categoryIds: string[] = [];
let categories: { expense: string; income: string } | undefined;
const now = new Date("2026-04-03T04:00:00.000Z");
const reportRange: ReportRange = {
  mode: "month", month: "2026-04", year: "2026",
  from: new Date("2026-03-31T16:00:00.000Z"), to: new Date("2026-04-30T15:59:59.999Z"),
};

type Identity = {
  householdId: string; memberId: string; id: string; appSessionId: string;
  formerId: string; expense: string; income: string; ring: KeyRing | null;
};
type Fixture = Identity & { ledgerId: string; archivedLedgerId: string };

async function inFixture<T>(fixture: Identity, work: () => Promise<T>): Promise<T> {
  if (!fixture.ring) return work();
  return runEncryptionContext({
    session: { id: fixture.id, householdId: fixture.householdId, memberId: fixture.memberId, appSessionId: fixture.appSessionId, role: "OWNER" },
    mode: "ENCRYPTED", configMode: "ENCRYPTED", revision: 1, ring: structuredClone(fixture.ring),
    expiresAt: Date.now() + 180_000, disposed: false, readOnly: false,
  }, work);
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL || process.env.NODE_ENV === "production") throw new Error("A local development database is required for encrypted import/report tests");
  const url = new URL(process.env.DATABASE_URL);
  if (!["127.0.0.1", "localhost"].includes(url.hostname) || !/_(dev|test)$/.test(url.pathname)) {
    throw new Error("Refusing a non-local or non-development encrypted import/report database");
  }
  raw = new PrismaClient();
  ({ db } = await import("@/lib/db"));
  drafts = await import("@/lib/imports/drafts");
  ({ queryHomeReport } = await import("@/lib/reports/query-home-report"));
  ({ queryReportAnalytics } = await import("@/lib/reports/query-report-analytics"));
  ({ queryRecentCategoryUsage } = await import("@/lib/transactions/query-category-preferences"));
  rules = await import("@/lib/imports/category-mapping-rules");
  management = await import("@/lib/imports/category-mapping-management");
  ({ classifyCmbRefundHistory } = await import("@/lib/imports/cmb-refund-history"));
});

afterEach(async () => {
  if (!raw) return;
  await raw.transaction.deleteMany({ where: { householdId: { in: householdIds } } });
  await raw.importDraft.deleteMany({ where: { householdId: { in: householdIds } } });
  await raw.ledgerAuditLog.deleteMany({ where: { householdId: { in: householdIds } } });
  await raw.resourceWindow.deleteMany({ where: { OR: [
    { scope: "household", subjectId: { in: householdIds } },
    { scope: "member", subjectId: { in: memberIds } },
  ] } });
  await raw.household.deleteMany({ where: { id: { in: householdIds.splice(0) } } });
  await raw.user.deleteMany({ where: { id: { in: userIds.splice(0) } } });
  await raw.category.deleteMany({ where: { id: { in: categoryIds.splice(0) } } });
  memberIds.length = 0;
  categories = undefined;
});

afterAll(async () => { await raw?.$disconnect(); await db?.$disconnect(); });

async function fixture(encrypted: boolean): Promise<Fixture> {
  const suffix = randomUUID();
  const household = await raw.household.create({ data: { name: `Encrypted query fixture ${suffix}` } });
  householdIds.push(household.id);
  const ownerUser = await raw.user.create({ data: { email: `enc-owner-${suffix}@example.com`, displayName: "Owner", passwordHash: "not-used" } });
  const formerUser = await raw.user.create({ data: { email: `enc-former-${suffix}@example.com`, displayName: "Former", passwordHash: "not-used" } });
  userIds.push(ownerUser.id, formerUser.id);
  const owner = await raw.householdMember.create({ data: { householdId: household.id, userId: ownerUser.id, memberName: "Owner", role: "OWNER" } });
  const former = await raw.householdMember.create({ data: { householdId: household.id, userId: formerUser.id, memberName: "Former", role: "MEMBER", leftAt: now } });
  memberIds.push(owner.id, former.id);
  const appSession = await raw.appSession.create({ data: {
    userId: ownerUser.id, memberId: owner.id, sessionKey: randomUUID(), expiresAt: new Date(Date.now() + 600_000),
  } });
  if (!categories) {
    const [expense, income] = await Promise.all([CategoryType.EXPENSE, CategoryType.INCOME].map((type) =>
      raw.category.create({ data: { name: `Encrypted report ${type} ${suffix}`, type, sortOrder: 0 } }),
    ));
    categoryIds.push(expense.id, income.id);
    categories = { expense: expense.id, income: income.id };
  }
  const code = encrypted ? createHouseholdCode(household.id) : null;
  const ring = code ? createKeyRing(code) : null;
  if (code && ring) await raw.householdEncryption.create({ data: {
    householdId: household.id, mode: "ENCRYPTED", revision: 1,
    generation: ring.generation, keyVersion: ring.currentKeyVersion, sealedKeyRing: await sealKeyRing(code, ring),
  } });
  const identity: Identity = {
    householdId: household.id, id: ownerUser.id, memberId: owner.id, appSessionId: appSession.id,
    formerId: former.id, ...categories, ring,
  };
  return inFixture(identity, async () => {
    const ledger = await db.ledger.create({ data: { householdId: household.id, name: "Private default ledger", isDefault: true } });
    const archived = await db.ledger.create({ data: { householdId: household.id, name: "Private archived ledger" } });
    return { ...identity, ledgerId: ledger.id, archivedLedgerId: archived.id };
  });
}

function transaction(f: Fixture, overrides: Partial<Prisma.TransactionUncheckedCreateInput> = {}): Prisma.TransactionUncheckedCreateInput {
  return {
    householdId: f.householdId, ledgerId: f.ledgerId, actorMemberId: f.memberId, createdByMemberId: f.memberId,
    type: "EXPENSE", categoryId: f.expense, amountFen: 100, occurredAt: new Date("2026-04-01T04:00:00.000Z"),
    note: "PRIVATE_ENCRYPTED_QUERY_CANARY", ...overrides,
  };
}

function fingerprint(value: string) { return createHash("sha256").update(value).digest("hex"); }

async function workbookBuffer(sheetName: string, rows: unknown[][]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet(sheetName).addRows(rows);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

describe("encrypted imports and financial reports", () => {
  it("matches unencrypted reports across batches, archived ledgers, historical members and Shanghai boundaries", async () => {
    const results = [];
    for (const encrypted of [false, true]) {
      const f = await fixture(encrypted);
      results.push(await inFixture(f, async () => {
        await db.transaction.createMany({ data: [
          ...Array.from({ length: 503 }, (_, index) => transaction(f, {
            amountFen: index + 1, actorMemberId: index % 2 ? f.formerId : f.memberId,
          })),
          transaction(f, { type: "INCOME", categoryId: f.income, amountFen: 3_000_000 }),
          transaction(f, { ledgerId: f.archivedLedgerId, amountFen: 12345 }),
          transaction(f, { occurredAt: new Date("2026-03-01T04:00:00.000Z"), amountFen: 4567 }),
          transaction(f, { occurredAt: new Date("2025-04-01T04:00:00.000Z"), amountFen: 5678 }),
          transaction(f, { occurredAt: new Date("2026-04-03T16:00:00.000Z"), amountFen: 8_000_000 }),
          transaction(f, { deletedAt: now, amountFen: 9_000_000 }),
        ] });
        await db.ledger.update({ where: { id: f.archivedLedgerId }, data: { archivedAt: now } });
        const input = { householdId: f.householdId, currentMemberId: f.memberId, range: reportRange, now };
        const home = await queryHomeReport(input);
        const analytics = await queryReportAnalytics(input);
        const usage = await queryRecentCategoryUsage({ householdId: f.householdId, memberId: f.memberId, ledgerId: f.ledgerId, now });
        const archived = await queryHomeReport({ ...input, ledgerId: f.archivedLedgerId });
        const former = await queryReportAnalytics({ ...input, actorMemberId: f.formerId });
        const formerHome = await queryHomeReport({ ...input, actorMemberId: f.formerId });
        const partial = await queryHomeReport({
          ...input,
          range: { ...reportRange, mode: "custom", start: "2026-03-20", end: "2026-04-03" },
        });
        if (encrypted) {
          const stored = await raw.transaction.findMany({ where: { householdId: f.householdId }, select: { note: true, amountFen: true, occurredAt: true } });
          expect(stored.some((row) => row.note === "PRIVATE_ENCRYPTED_QUERY_CANARY")).toBe(false);
          expect(stored.every((row) => row.amountFen !== 3_000_000)).toBe(true);
        }
        return { home, analytics, usage, archived, former, formerHome, partial };
      }));
    }
    expect(results[1]).toEqual(results[0]);
    expect(results[1].analytics.summary.expenseFen).toBe(126756 + 12345);
    expect(results[1].archived.summary.expenseFen).toBe(12345);
    expect(results[1].home.balanceTrend.points).toHaveLength(1);
    expect(results[1].home.balanceTrend.points[0]).toMatchObject({
      bucketKey: "2026-04", netFen: 2860899, cumulativeNetFen: 2860899,
      bucketStart: new Date("2026-03-31T16:00:00.000Z"), bucketEnd: new Date("2026-04-03T15:59:59.999Z"),
    });
    expect(results[1].archived.balanceTrend.points[0]).toMatchObject({ netFen: -12345, cumulativeNetFen: -12345 });
    expect(results[1].formerHome.balanceTrend.points[0]).toMatchObject({ netFen: -63252, cumulativeNetFen: -63252 });
    expect(results[1].partial.balanceTrend.points.map(({ bucketKey, netFen, cumulativeNetFen }) => ({ bucketKey, netFen, cumulativeNetFen }))).toEqual([
      { bucketKey: "2026-03", netFen: 0, cumulativeNetFen: 0 },
      { bucketKey: "2026-04", netFen: 2860899, cumulativeNetFen: 2860899 },
    ]);
    expect(results[1].analytics.comparisons.previous.summary?.expenseFen).toBe(4567);
    expect(results[1].analytics.comparisons.yearAgo.summary?.expenseFen).toBe(5678);
  }, 60_000);

  it.each([false, true])("confirms 20,000 rows with original fingerprints and durable soft-delete deduplication (encrypted=%s)", async (encrypted) => {
    const f = await fixture(encrypted);
    await inFixture(f, async () => {
      await db.transaction.createMany({ data: Array.from({ length: encrypted ? 20_000 : 1 }, (_, index) => transaction(f, {
        source: SUI_SHOU_JI_SOURCE, sourceFingerprint: fingerprint(index === 0 ? "bulk-0" : `history-${index}`),
        sourceImportedAt: now, deletedAt: now,
      })) });
      const draft = await db.importDraft.create({ data: {
        householdId: f.householdId, ledgerId: f.ledgerId, createdByMemberId: f.memberId,
        source: SUI_SHOU_JI_SOURCE, fileName: "PRIVATE_BULK_CANARY.xlsx",
      } });
      for (let offset = 0; offset < 20_000; offset += 500) {
        await db.importDraftRow.createMany({ data: Array.from({ length: 500 }, (_, index) => {
          const line = offset + index;
          return {
            draftId: draft.id, rowNumber: line + 1, transactionType: "EXPENSE", amountFen: line + 100,
            occurredAt: now, occurredDate: "2026-04-03", categoryId: f.expense,
            actorMemberId: f.memberId, createdByMemberId: f.memberId, note: "PRIVATE_BULK_CANARY_NOTE",
            sourceFingerprint: fingerprint(`bulk-${line === 19_999 ? 1 : line}`),
            status: "READY", userDecision: "KEEP",
          };
        }) });
      }
      const result = await drafts.confirmImportDraft(draft.id, f);
      expect(result).toMatchObject({ completedNow: true, createdCount: 19_998, sourceDuplicateCount: 2, requiresReview: false });
      expect(await drafts.confirmImportDraft(draft.id, f)).toMatchObject({ completedNow: false, createdCount: 19_998, sourceDuplicateCount: 2 });
      expect(await db.transaction.count({ where: { householdId: f.householdId, deletedAt: null } })).toBe(19_998);
      expect(await db.transaction.findFirst({
        where: { householdId: f.householdId, sourceFingerprint: fingerprint("bulk-1"), deletedAt: null },
        select: { amountFen: true, source: true, sourceFingerprint: true, note: true },
      })).toEqual({ amountFen: 101, source: SUI_SHOU_JI_SOURCE, sourceFingerprint: fingerprint("bulk-1"), note: "PRIVATE_BULK_CANARY_NOTE" });
      if (encrypted) {
        const physical = await raw.transaction.findMany({ where: { householdId: f.householdId }, select: { note: true, source: true, sourceFingerprint: true } });
        expect(JSON.stringify(physical).includes("PRIVATE_BULK_CANARY")).toBe(false);
        expect(physical.some((row) => row.sourceFingerprint === fingerprint("bulk-1"))).toBe(false);
        expect(await raw.importDraft.findUniqueOrThrow({ where: { id: draft.id }, select: { fileName: true } })).not.toEqual({ fileName: "PRIVATE_BULK_CANARY.xlsx" });
      }
    });
  }, 240_000);

  it.each([false, true])("retains mapping conflicts and completed full-refund claims (encrypted=%s)", async (encrypted) => {
    const f = await fixture(encrypted);
    await inFixture(f, async () => {
      const key = {
        householdId: f.householdId, source: CMB_SOURCE, transactionType: "EXPENSE" as const,
        primaryCategory: "PRIVATE_MAPPING_CANARY", secondaryCategory: "PRIVATE_MAPPING_SECONDARY",
      };
      const initial = await db.$transaction((tx) => rules.upsertImportCategoryMappingRule(tx, { ...key, categoryId: f.expense }));
      const replacement = await db.$transaction((tx) => rules.upsertImportCategoryMappingRule(tx, { ...key, categoryId: f.expense }));
      expect(replacement.id).toBe(initial.id);
      expect(replacement.updatedAt.getTime()).toBeGreaterThan(initial.updatedAt.getTime());
      expect(await raw.importCategoryMapping.findUniqueOrThrow({ where: { id: initial.id }, select: { updatedAt: true } }))
        .toEqual({ updatedAt: replacement.updatedAt });
      await expect(management.saveManagedImportCategoryMappings([
        { id: initial.id, categoryId: null, expectedUpdatedAt: initial.updatedAt.toISOString() },
      ], f)).rejects.toBeInstanceOf(management.ImportCategoryMappingConflictError);
      await management.saveManagedImportCategoryMappings([
        { id: replacement.id, categoryId: null, expectedUpdatedAt: replacement.updatedAt.toISOString() },
      ], f);
      const mappingKey = `${CMB_SOURCE}|EXPENSE|${key.primaryCategory}|${key.secondaryCategory}`;
      const pending = await db.importDraft.create({ data: {
        householdId: f.householdId, ledgerId: f.ledgerId, createdByMemberId: f.memberId,
        source: CMB_SOURCE, fileName: "PRIVATE_PENDING_CANARY.pdf",
        rows: { createMany: { data: [{
          rowNumber: 1, mappingKey, primaryCategory: key.primaryCategory, secondaryCategory: key.secondaryCategory,
          actorMemberId: f.memberId, createdByMemberId: f.memberId,
          transactionType: "EXPENSE", amountFen: 1000, occurredAt: now,
          sourceFingerprint: fingerprint("pending-payment"), status: "NEEDS_MAPPING", userDecision: "KEEP",
        }] } },
      } });
      await expect(drafts.saveImportDraftMappings(pending.id, [{
        mappingKey: mappingKey.replace(`${CMB_SOURCE}|`, "alipay|"), categoryId: f.expense,
      }], f)).rejects.toThrow("Mapping source does not match import draft source");
      await drafts.saveImportDraftMappings(pending.id, [{ mappingKey, categoryId: f.expense }], f);
      expect(await db.importDraftRow.findFirstOrThrow({
        where: { draftId: pending.id }, select: { categoryId: true, status: true },
      })).toEqual({ categoryId: f.expense, status: "READY" });
      const payment = fingerprint("completed-payment");
      const refund = fingerprint("completed-refund");
      const claim = {
        transactionType: "EXPENSE" as const, amountFen: 1000, primaryCategory: "Private refund category",
        refundOriginalAmountFen: 1000, refundSourceFingerprints: [refund],
        sourceFingerprint: payment, skipReason: CMB_FULLY_REFUNDED,
      };
      await db.importDraft.create({ data: {
        householdId: f.householdId, ledgerId: f.ledgerId, createdByMemberId: f.memberId,
        source: CMB_SOURCE, fileName: "PRIVATE_REFUND_CANARY.pdf", status: "COMPLETED", completedAt: now,
        rows: { createMany: { data: [{ ...claim, rowNumber: 1, status: "USER_SKIPPED", userDecision: "SKIP" }] } },
      } });
      expect(await classifyCmbRefundHistory(db, f.householdId, [claim, {
        amountFen: 1000, primaryCategory: "快捷退款", sourceFingerprint: refund, transactionType: "INCOME",
      }])).toEqual(["SOURCE_DUPLICATE", "SOURCE_DUPLICATE"]);
      if (encrypted) {
        const physical = await raw.importCategoryMapping.findUniqueOrThrow({ where: { id: initial.id } });
        expect(JSON.stringify(physical)).not.toContain("PRIVATE_MAPPING_CANARY");
        const physicalRows = await raw.importDraftRow.findMany({ where: { draft: { householdId: f.householdId } } });
        expect(JSON.stringify(physicalRows)).not.toContain(payment);
        expect(JSON.stringify(physicalRows)).not.toContain(refund);
      }
    });
  }, 60_000);

  it("matches both modes when parsed SSJ duplicates and late WeChat legacy refunds require review", async () => {
    const ssj = await workbookBuffer("支出", [
      ["交易类型", "日期", "一级分类", "二级分类", "账户币种", "金额", "成员", "记账人", "备注"],
      ["支出", "2026-04-03 12:00:00", "Private primary", "Private secondary", "CNY", "12.34", "Owner", "Owner", "PRIVATE_SSJ_FIRST"],
      ["支出", "2026-04-03 12:00:00", "Private primary", "Private secondary", "CNY", "12.34", "Owner", "Owner", "PRIVATE_SSJ_SECOND"],
    ]);
    const parsed = await parseSuiShouJiWorkbook(ssj);
    expect(parsed.rows).toHaveLength(2);
    const wechat = await workbookBuffer("Sheet1", [
      ["微信支付账单明细"], ["微信昵称：[Owner]"],
      ["交易时间", "交易类型", "交易对方", "商品", "收/支", "金额(元)", "支付方式", "当前状态", "交易单号", "商户单号", "备注"],
      ["2026-08-22 12:33:33", "示例服务有限公司-退款", "示例服务有限公司", "示例服务有限公司", "收入", "1.19", "零钱", "已退款¥1.19", "PRIVATE_REFUND_ORDER", "", "/"],
      ["2026-08-22 06:10:21", "商户消费", "示例服务有限公司", "示例商品", "支出", "2", "零钱", "已退款(¥1.19)", "PRIVATE_PAYMENT_ORDER", "PRIVATE_MERCHANT_ORDER", "/"],
    ]);
    const results = [];
    for (const encrypted of [false, true]) {
      const f = await fixture(encrypted);
      results.push(await inFixture(f, async () => {
        const context = { householdId: f.householdId, memberId: f.memberId, ledgerId: f.ledgerId };
        await db.$transaction((tx) => rules.upsertImportCategoryMappingRule(tx, {
          householdId: f.householdId, source: SUI_SHOU_JI_SOURCE, transactionType: "EXPENSE",
          primaryCategory: "Private primary", secondaryCategory: "Private secondary", categoryId: f.expense,
        }));
        await db.transaction.createMany({ data: [
          transaction(f, { amountFen: 1234, occurredAt: now }),
          transaction(f, { amountFen: 1234, occurredAt: now, source: "alipay", sourceFingerprint: fingerprint("other-source"), sourceImportedAt: now }),
          transaction(f, { amountFen: 1234, occurredAt: now, deletedAt: now }),
          transaction(f, { amountFen: 1234, occurredAt: now, source: SUI_SHOU_JI_SOURCE, sourceFingerprint: parsed.rows[0].sourceFingerprint, sourceImportedAt: now, deletedAt: now }),
        ] });
        const ssjDraft = await drafts.createSuiShouJiImportDraft({ buffer: ssj, fileName: "PRIVATE_SSJ_CANARY.xlsx", context, sessionUser: f });
        const ssjSummary = await drafts.getImportDraftSummary(ssjDraft.id, f);
        expect(ssjSummary.rows.map(({ status }) => status)).toEqual(["SOURCE_DUPLICATE", "POSSIBLE_DUPLICATE"]);
        expect(ssjSummary.rows[1].duplicateCandidates).toHaveLength(2);
        const wechatDraft = await drafts.createWechatPayImportDraft({ buffer: wechat, fileName: "PRIVATE_WECHAT_CANARY.xlsx", context, sessionUser: f });
        await drafts.savePaymentImportDraftOwnerMember(wechatDraft.id, f.memberId, f);
        const wechatSummary = await drafts.getImportDraftSummary(wechatDraft.id, f);
        const payment = wechatSummary.rows.find(({ amountFen }) => amountFen === 81)!;
        expect(payment).toBeDefined();
        await drafts.saveImportDraftMappings(wechatDraft.id, [{ mappingKey: payment.mappingKey!, categoryId: f.expense }], f);
        await db.transaction.create({ data: transaction(f, {
          amountFen: 200, occurredAt: new Date("2026-08-21T22:10:21.000Z"), deletedAt: now,
          source: WECHAT_PAY_SOURCE, sourceFingerprint: fingerprint("legacy-wechat-original"), sourceImportedAt: now,
        }) });
        const review = await drafts.confirmImportDraft(wechatDraft.id, f);
        expect(review).toMatchObject({ completedNow: false, createdCount: 0, requiresReview: true, sourceDuplicateCount: 1 });
        const reviewed = await drafts.getImportDraftSummary(wechatDraft.id, f);
        const refund = reviewed.rows.find(({ amountFen }) => amountFen === 81)!;
        expect(refund).toMatchObject({ status: "SOURCE_DUPLICATE", skipReason: WECHAT_REFUND_REQUIRES_MANUAL_ADJUSTMENT });
        const completed = await drafts.confirmImportDraft(wechatDraft.id, f);
        expect(completed).toMatchObject({ completedNow: true, createdCount: 0, sourceDuplicateCount: 1 });
        return {
          ssj: ssjSummary.rows.map(({ status, amountFen, duplicateCandidates }) => ({
            status, amountFen, candidates: duplicateCandidates.map(({ amountFen: amount, source }) => ({ amount, source })).sort((left, right) => String(left.source).localeCompare(String(right.source))),
          })),
          review, completed, refund: { status: refund.status, skipReason: refund.skipReason, amountFen: refund.amountFen },
        };
      }));
    }
    expect(results[1]).toEqual(results[0]);
  }, 60_000);
});
