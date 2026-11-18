import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

if (existsSync(".env")) process.loadEnvFile(".env");
process.loadEnvFile(".env.example");

let db: typeof import("@/lib/db").db;
let listRecords: typeof import("@/lib/records/list-records").listRecords;
let queryHomeReport: typeof import("@/lib/reports/query-home-report").queryHomeReport;
let queryReportAnalytics: typeof import("@/lib/reports/query-report-analytics").queryReportAnalytics;
const households: string[] = [];
const users: string[] = [];
let householdId: string;
let memberId: string;
let mainId: string;
let travelId: string;
let archiveId: string;
let foreignId: string;
const now = new Date("2026-10-21T04:00:00Z");
const bounds = { from: new Date("2026-09-30T16:00:00Z"), to: new Date("2026-10-31T15:59:59.999Z") };

beforeAll(async () => {
  const database = new URL(process.env.DATABASE_URL!);
  if (!/dev|test/.test(database.pathname)) throw new Error("A development or test database is required");
  ({ db } = await import("@/lib/db"));
  ({ listRecords } = await import("@/lib/records/list-records"));
  ({ queryHomeReport } = await import("@/lib/reports/query-home-report"));
  ({ queryReportAnalytics } = await import("@/lib/reports/query-report-analytics"));
  const category = await db.category.findFirstOrThrow({ where: { name: "Dining", type: "EXPENSE" } });
  for (let index = 0; index < 2; index++) {
    const user = await db.user.create({ data: { email: `ledger-read-${randomUUID()}@example.com`, displayName: "Ledger reader", passwordHash: "not-used" } });
    users.push(user.id);
    const household = await db.household.create({ data: { name: "Ledger read fixture", ledgers: { create: [{ name: "Default", isDefault: true }, { name: "Travel" }, { name: "Archive", archivedAt: now }] } } });
    households.push(household.id);
    const member = await db.householdMember.create({ data: { householdId: household.id, userId: user.id, memberName: "Reader", role: "OWNER" } });
    const ledgers = await db.ledger.findMany({ where: { householdId: household.id } });
    const main = ledgers.find((ledger) => ledger.isDefault)!;
    const travel = ledgers.find((ledger) => ledger.name === "Travel")!;
    const archive = ledgers.find((ledger) => ledger.name === "Archive")!;
    if (index === 0) {
      householdId = household.id; memberId = member.id; mainId = main.id; travelId = travel.id; archiveId = archive.id;
    } else foreignId = travel.id;
    await db.transaction.createMany({ data: [
      { ledgerId: main.id, amountFen: 100 },
      { ledgerId: travel.id, amountFen: 200 },
      { ledgerId: archive.id, amountFen: 300 },
      { ledgerId: travel.id, amountFen: 999, deletedAt: now },
    ].map((row) => ({ ...row, householdId: household.id, actorMemberId: member.id, createdByMemberId: member.id, categoryId: category.id, type: "EXPENSE", occurredAt: new Date("2026-10-10T04:00:00Z") })) });
  }
});

afterAll(async () => {
  if (!db) return;
  await db.transaction.deleteMany({ where: { householdId: { in: households } } });
  await db.householdMember.deleteMany({ where: { householdId: { in: households } } });
  await db.household.deleteMany({ where: { id: { in: households } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
  await db.$disconnect();
});

describe("multi-ledger read scope", () => {
  it("lists the requested ledger and exposes its original target, including archived history", async () => {
    const travel = await listRecords({ householdId, currentMemberId: memberId, rangeBounds: bounds, ledgerId: travelId });
    expect(travel).toHaveLength(1);
    expect(travel[0]).toMatchObject({ amountFen: 200, ledgerId: travelId, ledgerName: "Travel", ledgerArchivedAt: null });
    const archived = await listRecords({ householdId, currentMemberId: memberId, rangeBounds: bounds, ledgerId: archiveId });
    expect(archived).toHaveLength(1);
    expect(archived[0].ledgerArchivedAt).toEqual(now);
  });

  it("keeps family totals equal to all ledger totals without counting soft-deleted records", async () => {
    const input = { householdId, currentMemberId: memberId, now, range: { mode: "month" as const, month: "2026-10", year: "2026" } };
    const family = await queryHomeReport(input);
    const reports = await Promise.all([mainId, travelId, archiveId].map((ledgerId) => queryHomeReport({ ...input, ledgerId })));
    expect(reports.map((report) => report.summary.expenseFen)).toEqual([100, 200, 300]);
    expect(family.summary.expenseFen).toBe(reports.reduce((sum, report) => sum + report.summary.expenseFen, 0));
    expect(family.summary.transactionCount).toBe(3);
    expect(reports[1].categories.expense.totalFen).toBe(200);
    expect(reports[1].trend.points.reduce((sum, point) => sum + point.expenseFen, 0)).toBe(200);
  });

  it("uses the same ledger in analytics SQL and amount distributions", async () => {
    const report = await queryHomeReport({ householdId, currentMemberId: memberId, now, range: { mode: "month", month: "2026-10", year: "2026" } });
    const analytics = await queryReportAnalytics({ householdId, currentMemberId: memberId, ledgerId: travelId, now, range: report.range });
    expect(analytics.distribution.totalFen).toBe(200);
    expect(analytics.distribution.expenseCount).toBe(1);
  });

  it("rejects another household ledger consistently before returning any data", async () => {
    await expect(listRecords({ householdId, currentMemberId: memberId, rangeBounds: bounds, ledgerId: foreignId })).rejects.toThrow("Ledger is unavailable");
    await expect(queryHomeReport({ householdId, currentMemberId: memberId, ledgerId: foreignId, now, range: { mode: "month", month: "2026-10", year: "2026" } })).rejects.toThrow("Ledger is unavailable");
    const report = await queryHomeReport({ householdId, currentMemberId: memberId, now, range: { mode: "month", month: "2026-10", year: "2026" } });
    await expect(queryReportAnalytics({ householdId, currentMemberId: memberId, ledgerId: foreignId, now, range: report.range })).rejects.toThrow("Ledger is unavailable");
  });
});
