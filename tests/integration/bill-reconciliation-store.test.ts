import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";

let raw: PrismaClient;
const households: string[] = [], users: string[] = [];
beforeAll(() => {
  process.loadEnvFile(".env.example");
  const url = new URL(process.env.DATABASE_URL ?? "");
  if (process.env.NODE_ENV === "production" || !["127.0.0.1", "localhost"].includes(url.hostname) || !/_(dev|test)$/.test(url.pathname)) throw new Error("Local development database required");
  raw = new PrismaClient();
});
afterEach(async () => {
  await raw.billReconciliationApplication.deleteMany({ where: { householdId: { in: households } } });
  await raw.billAnalysisRequest.deleteMany({ where: { householdId: { in: households } } });
  await raw.billAnalysisReport.deleteMany({ where: { householdId: { in: households } } });
  await raw.household.deleteMany({ where: { id: { in: households.splice(0) } } });
  await raw.user.deleteMany({ where: { id: { in: users.splice(0) } } });
});
afterAll(async () => { await raw?.$disconnect(); });

it("keeps the legacy analysis slot separate from a reconciliation of the same scope", async () => {
  const store = await import("@/lib/reports/bill-analysis-store");
  const { acquireResourceLease, releaseResourceLease } = await import("@/lib/resources/admission");
  const household = await raw.household.create({ data: { name: "Synthetic report purposes" } });
  households.push(household.id);
  const user = await raw.user.create({ data: { email: `report-purpose-${randomUUID()}@example.com`, displayName: "Owner", passwordHash: "not-used", aiProcessingEnabled: true } });
  users.push(user.id);
  const member = await raw.householdMember.create({ data: { householdId: household.id, userId: user.id, role: "OWNER", memberName: "Owner" } });
  await raw.ledger.create({ data: { householdId: household.id, isDefault: true, name: "Default" } });
  const appSession = await raw.appSession.create({ data: { userId: user.id, memberId: member.id, sessionKey: randomUUID(), expiresAt: new Date(Date.now() + 900_000) } });
  const session = { id: user.id, memberId: member.id, householdId: household.id, appSessionId: appSession.id };
  const scope = { mode: "month" as const, period: "2026-10", ledgerId: null, actorMemberId: null };
  for (const purpose of ["analysis", "reconciliation"] as const) {
    const requestId = randomUUID();
    const claimed = await store.claimBillAnalysisRequest(session, { requestId, scope, locale: "zh-CN", purpose, deadlineAt: new Date(Date.now() + 480_000), owner: { id: randomUUID(), runtime: "synthetic", pid: 123, startedAt: new Date() } }, (tx) => acquireResourceLease(tx, session, "ai", { profile: "bill-analysis", deferCharge: true }));
    try { await store.failBillAnalysisRequest(session, requestId, "UNAVAILABLE"); }
    finally { await releaseResourceLease(claimed.lease!); }
  }
  const reports = await raw.billAnalysisReport.findMany({ where: { householdId: household.id } });
  expect(reports).toHaveLength(2);
  expect(reports.some((report) => (report.definition as { purpose?: string }).purpose === "reconciliation")).toBe(true);
  const entries = await store.listBillAnalysisEntries(session);
  expect(entries.entries.filter((entry) => entry.purpose === "reconciliation")).toHaveLength(1);
});
