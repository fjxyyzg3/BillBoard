import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma, TransactionType } from "@prisma/client";

type FixtureTransaction = {
  id: string;
  householdId: string;
  ledgerId: string;
  actorMemberId: string;
  createdByMemberId: string;
  categoryId: string;
  category: { id: string; name: string };
  actorMember: { memberName: string };
  createdByMember: { memberName: string };
  amountFen: number;
  occurredAt: Date;
  type: TransactionType;
  note: string | null;
  source: string | null;
  sourceFingerprint: string | null;
  deletedAt: Date | null;
};

const state = vi.hoisted(() => ({ rows: [] as FixtureTransaction[], reads: 0 }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/encryption/request-context", () => ({ isEncryptedRequest: () => true }));
vi.mock("@/lib/ledgers/server", () => ({ authorizeLedgerReadScope: async () => ({ householdId: "family", ledgerId: "ledger" }) }));
vi.mock("@/lib/auth/household-context", () => ({ resolveHouseholdContext: async () => ({ householdId: "family", ledgerId: "ledger" }) }));

vi.mock("@/lib/db", () => {
  type Scope = {
    householdId?: string;
    ledgerId?: string;
    actorMemberId?: string | { in: string[] };
    id?: { gt: string };
    deletedAt?: null;
  };
  const scoped = (where: Scope = {}) => state.rows.filter((row) =>
    (!where.householdId || row.householdId === where.householdId)
    && (!where.ledgerId || row.ledgerId === where.ledgerId)
    && (!where.actorMemberId || (typeof where.actorMemberId === "string"
      ? row.actorMemberId === where.actorMemberId : where.actorMemberId.in.includes(row.actorMemberId)))
    && (where.deletedAt !== null || row.deletedAt === null)
    && (!where.id?.gt || row.id > where.id.gt),
  );
  const transaction = {
    findMany: async ({ where, take }: { where?: Scope; take?: number }) => {
      state.reads += 1;
      return scoped(where).sort((left, right) => left.id.localeCompare(right.id)).slice(0, take);
    },
    findFirst: async ({ where }: { where?: Scope }) =>
      scoped(where).sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime())[0] ?? null,
    // The physical aggregate columns are placeholders, while delegate rows are decoded.
    groupBy: async () => [],
  };
  const database = {
    transaction,
    household: {
      findUniqueOrThrow: async () => ({ timezone: "Asia/Shanghai" }),
      findFirst: async () => ({ timezone: "Asia/Shanghai", members: [{ id: "owner" }, { id: "former" }] }),
    },
    householdMember: { findMany: async () => [{ id: "owner" }, { id: "former" }] },
    category: { findMany: async () => [...new Map(state.rows.map((row) => [row.categoryId, row.category])).values()] },
    $queryRaw: async (query: { sql?: string }) => query.sql?.includes("WITH expenses") ? [{
      key: null, amountFen: null, transactionCount: null,
      expenseCount: 0, totalFen: 0, medianFen: null, maxFen: null, topFiveAmountFen: 0,
    }] : [],
    $transaction: async (work: unknown) => typeof work === "function"
      ? work(database) : Promise.all(work as Promise<unknown>[]),
  };
  return { db: database };
});

import { queryHomeReport } from "@/lib/reports/query-home-report";
import { queryReportAnalytics } from "@/lib/reports/query-report-analytics";
import { queryRecentCategoryUsage } from "@/lib/transactions/query-category-preferences";
import { updateImportCategoryMappingRule, upsertImportCategoryMappingRule } from "@/lib/imports/category-mapping-rules";
import { collectImportSourceAmounts, collectWechatLegacyAmounts } from "@/lib/encryption/financial-queries";
import { db } from "@/lib/db";
import { classifyCmbRefundHistory } from "@/lib/imports/cmb-refund-history";
import { CMB_FULLY_REFUNDED } from "@/lib/imports/types";

function row(index: number, overrides: Partial<FixtureTransaction> = {}): FixtureTransaction {
  return {
    id: String(index).padStart(6, "0"), householdId: "family", ledgerId: "ledger",
    actorMemberId: "owner", createdByMemberId: "owner", categoryId: "expense",
    category: { id: "expense", name: "Dining" },
    actorMember: { memberName: "Owner" }, createdByMember: { memberName: "Owner" },
    amountFen: 100, occurredAt: new Date("2026-03-31T16:00:00.000Z"),
    type: "EXPENSE", note: "Private encrypted fixture", source: null, sourceFingerprint: null, deletedAt: null, ...overrides,
  };
}

const now = new Date("2026-04-03T04:00:00.000Z");
const range = {
  mode: "month" as const, month: "2026-04", year: "2026",
  from: new Date("2026-03-31T16:00:00.000Z"), to: new Date("2026-04-30T15:59:59.999Z"),
};

beforeEach(() => { state.rows = []; state.reads = 0; });

describe("encrypted financial query behavior", () => {
  it("computes the family home report across scan batches and excludes other scopes", async () => {
    state.rows = Array.from({ length: 503 }, (_, index) => row(index, {
      amountFen: index + 1,
      actorMemberId: index === 502 ? "former" : "owner",
    }));
    state.rows.push(
      row(504, { householdId: "other-family", amountFen: 9_000_000 }),
      row(505, { ledgerId: "other-ledger", amountFen: 8_000_000 }),
      row(506, { deletedAt: now, amountFen: 7_000_000 }),
      row(507, { occurredAt: new Date("2026-03-31T15:59:59.999Z"), amountFen: 6_000_000 }),
    );
    const report = await queryHomeReport({ householdId: "family", currentMemberId: "owner", ledgerId: "ledger", range, now });
    expect(report.summary).toEqual({ incomeFen: 0, expenseFen: 126756, netFen: -126756, transactionCount: 503 });
    expect(report.categories.expense.items).toEqual([{
      categoryId: "expense", categoryName: "Dining", amountFen: 126756, transactionCount: 503, share: 1,
    }]);
    expect(report.trend.points.reduce((total, point) => total + point.expenseFen, 0)).toBe(126756);
    expect(JSON.stringify(report)).not.toContain("Private encrypted fixture");
  });

  it("preserves exact percentiles, buckets, prior periods and Shanghai end-of-day", async () => {
    const amounts = [1, 4999, 5000, 19999, 20000, 49999, 50000, 99999, 100000, 499999, 500000, 500001];
    state.rows = amounts.map((amountFen, index) => row(index, { amountFen }));
    state.rows.push(
      row(20, { type: "INCOME", categoryId: "income", category: { id: "income", name: "Salary" }, amountFen: 3_000_000 }),
      row(21, { occurredAt: new Date("2026-03-01T04:00:00.000Z"), amountFen: 1234 }),
      row(22, { occurredAt: new Date("2025-04-01T04:00:00.000Z"), amountFen: 5678 }),
      row(23, { occurredAt: new Date("2026-04-03T16:00:00.000Z"), amountFen: 9_000_000 }),
      row(24, { deletedAt: now, amountFen: 8_000_000 }),
      row(25, { householdId: "other-family", amountFen: 7_000_000 }),
    );
    const report = await queryReportAnalytics({ householdId: "family", currentMemberId: "owner", ledgerId: "ledger", range, now });
    const totalFen = amounts.reduce((sum, amountFen) => sum + amountFen, 0);
    expect(report.summary).toMatchObject({ expenseFen: totalFen, incomeFen: 3_000_000, transactionCount: 13 });
    expect(report.distribution).toMatchObject({ expenseCount: 12, medianFen: 49999.5, maxFen: 500001, topFiveAmountFen: 1699999 });
    expect(report.distribution.buckets.map((bucket) => bucket.transactionCount)).toEqual([2, 2, 2, 2, 2, 2]);
    expect(report.comparisons.previous.summary?.expenseFen).toBe(1234);
    expect(report.comparisons.yearAgo.summary?.expenseFen).toBe(5678);
    expect(report.range).toEqual({ from: "2026-04-01", to: "2026-04-03" });
    expect(report.firstRecordedDate).toBe("2025-04-01");
  });

  it("uses decoded category and date fields for member preference counts", async () => {
    state.rows = [
      row(0, { occurredAt: new Date("2026-04-02T15:59:59.999Z") }),
      row(1, { occurredAt: new Date("2026-04-01T04:00:00.000Z") }),
      row(2, { actorMemberId: "former", amountFen: 999 }),
      row(3, { occurredAt: new Date("2026-02-01T04:00:00.000Z") }),
      row(4, { deletedAt: now }),
      row(5, { ledgerId: "other-ledger" }),
    ];
    const usage = await queryRecentCategoryUsage({ householdId: "family", memberId: "owner", ledgerId: "ledger", now });
    expect(usage).toEqual([{
      categoryId: "expense", count: 2, lastOccurredAt: new Date("2026-04-02T15:59:59.999Z"), type: "expense",
    }]);
  });

  it("preserves mapping upsert identity and strictly increasing versions even when the stored clock is ahead", async () => {
    let saved: { id: string; categoryId: string | null; updatedAt: Date } | null = {
      id: "mapping", categoryId: "old-category", updatedAt: new Date("2099-01-01T00:00:00.000Z"),
    };
    const tx = {
      $queryRaw: async () => [],
      importCategoryMapping: {
        findUnique: async () => saved,
        upsert: async ({ create, update }: { create: NonNullable<typeof saved>; update: Partial<NonNullable<typeof saved>> }) => {
          saved = saved ? { ...saved, ...update } : create;
          return saved;
        },
      },
    } as unknown as Prisma.TransactionClient;
    const first = await upsertImportCategoryMappingRule(tx, {
      householdId: "family", source: "alipay", transactionType: "EXPENSE",
      primaryCategory: "Private category", secondaryCategory: "Private subcategory", categoryId: "new-category",
    });
    expect(first).toEqual({ id: "mapping", categoryId: "new-category", updatedAt: new Date("2099-01-01T00:00:00.001Z") });
  });

  it("rejects a stale mapping edit without changing the accepted value", async () => {
    let saved = { id: "mapping", householdId: "family", categoryId: "old-category" as string | null, updatedAt: now };
    const tx = {
      $queryRaw: async () => [],
      importCategoryMapping: {
        updateManyAndReturn: async ({ where, data }: {
          where: { id: string; householdId: string; updatedAt: Date };
          data: { categoryId: string | null; updatedAt: Date };
        }) => {
          if (where.id !== saved.id || where.householdId !== saved.householdId || where.updatedAt.getTime() !== saved.updatedAt.getTime()) return [];
          saved = { ...saved, ...data };
          return [{ id: saved.id, categoryId: saved.categoryId, updatedAt: saved.updatedAt }];
        },
      },
    } as unknown as Prisma.TransactionClient;
    const accepted = await updateImportCategoryMappingRule(tx, {
      id: "mapping", householdId: "family", categoryId: null, expectedUpdatedAt: now,
    });
    expect(accepted?.categoryId).toBeNull();
    expect(accepted!.updatedAt.getTime()).toBeGreaterThan(now.getTime());
    await expect(updateImportCategoryMappingRule(tx, {
      id: "mapping", householdId: "family", categoryId: "stale-category", expectedUpdatedAt: now,
    })).resolves.toBeUndefined();
    expect(saved.categoryId).toBeNull();
  });

  it("scans source history once for a large fingerprint set and retains soft-deleted and cross-ledger duplicates", async () => {
    state.rows = Array.from({ length: 503 }, (_, index) => row(index, {
      amountFen: index + 1, source: "sui_shou_ji", sourceFingerprint: `fingerprint-${index}`,
      ...(index === 501 ? { ledgerId: "other-ledger" } : {}),
      ...(index === 502 ? { deletedAt: now } : {}),
    }));
    state.rows.push(
      row(503, { householdId: "other-family", source: "sui_shou_ji", sourceFingerprint: "fingerprint-0", amountFen: 9_000_000 }),
      row(504, { source: "alipay", sourceFingerprint: "fingerprint-0", amountFen: 8_000_000 }),
    );
    const amounts = await collectImportSourceAmounts(db, {
      householdId: "family", source: "sui_shou_ji",
      fingerprints: ["fingerprint-0", "fingerprint-501", "fingerprint-502", ...Array.from({ length: 19_997 }, (_, index) => `missing-${index}`)],
    });
    expect(amounts).toEqual(new Map([["fingerprint-0", [1]], ["fingerprint-501", [502]], ["fingerprint-502", [503]]]));
    expect(state.reads).toBeLessThanOrEqual(2);
  });

  it("matches legacy WeChat refunds by their exact decoded timestamp and retains soft-deleted expenses", async () => {
    state.rows = [
      row(0, { source: "wechat_pay", occurredAt: now, amountFen: 1234 }),
      row(1, { source: "wechat_pay", occurredAt: now, deletedAt: now, amountFen: 2345 }),
      row(2, { source: "wechat_pay", occurredAt: now, type: "INCOME", amountFen: 9999 }),
      row(3, { source: "alipay", occurredAt: now, amountFen: 8888 }),
      row(4, { source: "wechat_pay", occurredAt: new Date(now.getTime() + 1), amountFen: 7777 }),
      row(5, { householdId: "other-family", source: "wechat_pay", occurredAt: now, amountFen: 6666 }),
    ];
    expect(await collectWechatLegacyAmounts(db, { householdId: "family", occurredAt: [now] }))
      .toEqual(new Map([[now.toISOString(), [1234, 2345]]]));
  });

  it("reads completed CMB consumption history once rather than once per fingerprint batch", async () => {
    let transactionReads = 0;
    const payment = "a".repeat(64);
    const refund = "b".repeat(64);
    const claim = {
      id: "claim", draftId: "completed", status: "USER_SKIPPED", userDecision: "SKIP",
      amountFen: 1000, primaryCategory: "Private refund", transactionType: "EXPENSE" as const,
      refundOriginalAmountFen: 1000, refundSourceFingerprints: [refund], sourceFingerprint: payment, skipReason: CMB_FULLY_REFUNDED,
    };
    const client = {
      transaction: { findMany: async () => { transactionReads += 1; return []; } },
      importDraft: { findMany: async () => [{ id: "completed", source: "cmb" }] },
      importDraftRow: { findMany: async () => [claim] },
    } as unknown as Prisma.TransactionClient;
    const outcomes = await classifyCmbRefundHistory(client, "family", [claim, ...Array.from({ length: 600 }, (_, index) => ({
      amountFen: 1000, primaryCategory: "Private payment", sourceFingerprint: String(index).padStart(64, "0"), transactionType: "EXPENSE" as const,
    }))]);
    expect(outcomes).toEqual(["SOURCE_DUPLICATE", ...Array.from({ length: 600 }, () => "NONE")]);
    expect(transactionReads).toBeLessThanOrEqual(1);
  });
});
