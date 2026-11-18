import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getBillAnalysisOwner, finishBillAnalysisExecution, reapStoppedBillAnalysisExecutions } from "@/lib/reports/bill-analysis-owner";
import type { BillAnalysisOwner, BillAnalysisSession } from "@/lib/reports/bill-analysis-store";

type Fixture = { session: BillAnalysisSession; requestId: string; owner: BillAnalysisOwner };
const households: string[] = [], users: string[] = [], members: string[] = [];
const children: ChildProcess[] = [];
let raw: PrismaClient;

beforeAll(() => {
  process.loadEnvFile(".env.example");
  const url = new URL(process.env.DATABASE_URL ?? "");
  if (process.env.NODE_ENV === "production" || !["127.0.0.1", "localhost"].includes(url.hostname) || !/_(dev|test)$/.test(url.pathname)) {
    throw new Error("Owner recovery tests require a local development database");
  }
  raw = new PrismaClient();
});

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, "close");
  child.kill("SIGKILL");
  await closed;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(children.splice(0).map(stop));
  await raw.resourceWindow.deleteMany({ where: { OR: [
    { scope: "household", subjectId: { in: households } }, { scope: "member", subjectId: { in: members } },
  ] } });
  await raw.billAnalysisRequest.deleteMany({ where: { householdId: { in: households } } });
  await raw.billAnalysisReport.deleteMany({ where: { householdId: { in: households } } });
  await raw.household.deleteMany({ where: { id: { in: households.splice(0) } } });
  await raw.user.deleteMany({ where: { id: { in: users.splice(0) } } });
  members.length = 0;
});

afterAll(async () => {
  await raw?.$disconnect();
  const { physicalDb } = await import("@/lib/db");
  await physicalDb.$disconnect();
});

async function fixture(): Promise<Fixture> {
  const suffix = randomUUID();
  const household = await raw.household.create({ data: { name: "Synthetic owner recovery" } });
  households.push(household.id);
  const user = await raw.user.create({ data: { email: `analysis-owner-${suffix}@example.com`, displayName: "Owner", passwordHash: "not-used", aiProcessingEnabled: true } });
  users.push(user.id);
  const member = await raw.householdMember.create({ data: { householdId: household.id, userId: user.id, memberName: "Owner", role: "OWNER" } });
  members.push(member.id);
  await raw.ledger.create({ data: { householdId: household.id, name: "Default", isDefault: true } });
  const appSession = await raw.appSession.create({ data: { userId: user.id, memberId: member.id, sessionKey: randomUUID(), expiresAt: new Date(Date.now() + 900_000) } });
  return { session: { id: user.id, householdId: household.id, memberId: member.id, appSessionId: appSession.id }, requestId: randomUUID(), owner: getBillAnalysisOwner() };
}

async function claim(input: Fixture) {
  const store = await import("@/lib/reports/bill-analysis-store");
  const { acquireResourceLease } = await import("@/lib/resources/admission");
  const result = await store.claimBillAnalysisRequest(input.session, {
    requestId: input.requestId, scope: { mode: "month", period: "2026-10", ledgerId: null, actorMemberId: null },
    locale: "zh-CN", deadlineAt: new Date(Date.now() + 480_000), owner: input.owner,
  }, (tx) => acquireResourceLease(tx, input.session, "ai", { profile: "bill-analysis", deferCharge: true, taskKey: `bill-analysis:${input.requestId}` }));
  expect(result.created).toBe(true);
  return { ...result, store, lease: result.lease! };
}

async function childClaim(input: Fixture) {
  const code = `
    (async () => {
      const ownerModule = await import('./src/lib/reports/bill-analysis-owner.ts');
      const storeModule = await import('./src/lib/reports/bill-analysis-store.ts');
      const resourcesModule = await import('./src/lib/resources/admission.ts');
      const ownerApi = ownerModule.default ?? ownerModule;
      const store = storeModule.default ?? storeModule;
      const resources = resourcesModule.default ?? resourcesModule;
      const input = JSON.parse(process.env.BILL_ANALYSIS_TEST_FIXTURE);
      const owner = ownerApi.getBillAnalysisOwner();
      const result = await store.claimBillAnalysisRequest(input.session, {
        requestId: input.requestId, scope: { mode: 'month', period: '2026-10', ledgerId: null, actorMemberId: null },
        locale: 'zh-CN', deadlineAt: new Date(Date.now() + 480000), owner,
      }, (tx) => resources.acquireResourceLease(tx, input.session, 'ai', { profile: 'bill-analysis', deferCharge: true, taskKey: 'bill-analysis:' + input.requestId }));
      if (!result.created || !result.lease) throw new Error('Claim failed');
      process.stdout.write(JSON.stringify({ owner, token: result.lease.token }) + '\\n');
      setInterval(() => {}, 1000);
    })().catch(() => { process.stderr.write('Synthetic owner fixture failed.\\n'); process.exit(1); });
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "-e", code], { cwd: process.cwd(), windowsHide: true,
    env: { ...process.env, BILL_ANALYSIS_TEST_FIXTURE: JSON.stringify({ session: input.session, requestId: input.requestId }) } });
  children.push(child);
  const ready = await new Promise<{ owner: Omit<BillAnalysisOwner, "startedAt"> & { startedAt: string }; token: string }>((resolve, reject) => {
    let text = "";
    const timeout = setTimeout(() => reject(new Error("Synthetic child did not claim its lease")), 15_000);
    child.once("error", () => { clearTimeout(timeout); reject(new Error("Synthetic child could not start")); });
    child.once("close", () => { clearTimeout(timeout); reject(new Error("Synthetic child exited before ready")); });
    child.stdout!.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
      if (!text.includes("\n")) return;
      try { clearTimeout(timeout); resolve(JSON.parse(text.trim())); }
      catch { reject(new Error("Synthetic child returned an invalid receipt")); }
    });
  });
  return { child, token: ready.token, owner: { ...ready.owner, startedAt: new Date(ready.owner.startedAt) } };
}

describe("bill analysis execution recovery", () => {
  it("does not use a stopped-runtime claim to override the current live owner", async () => {
    const input = await fixture();
    const owned = await claim(input);
    await raw.resourceLease.update({ where: { token: owned.lease.token }, data: { expiresAt: new Date(0) } });
    expect(await reapStoppedBillAnalysisExecutions([getBillAnalysisOwner().runtime])).toBe(0);
    expect(await raw.resourceExecution.count({ where: { token: owned.lease.token } })).toBe(1);
  });

  it("fences a real hard-killed child, releases only its resources and never reruns its UUID", async () => {
    const input = await fixture();
    const running = await childClaim(input);
    expect(await reapStoppedBillAnalysisExecutions()).toBe(0);
    await raw.resourceLease.update({ where: { token: running.token }, data: { expiresAt: new Date(0) } });
    expect(await reapStoppedBillAnalysisExecutions()).toBe(0);
    expect(await raw.resourceExecution.count({ where: { token: running.token } })).toBe(1);
    await stop(running.child);
    expect(await reapStoppedBillAnalysisExecutions()).toBe(1);
    expect(await raw.resourceLease.count({ where: { token: running.token } })).toBe(0);
    expect(await raw.resourceExecution.count({ where: { token: running.token } })).toBe(0);
    const store = await import("@/lib/reports/bill-analysis-store");
    expect(await store.queryBillAnalysisRequest(input.session, input.requestId)).toMatchObject({ status: "error", error: "INTERRUPTED" });
    let acquisitions = 0;
    const replay = await store.claimBillAnalysisRequest(input.session, {
      requestId: input.requestId, scope: { mode: "month", period: "2026-10", ledgerId: null, actorMemberId: null }, locale: "zh-CN",
      deadlineAt: new Date(Date.now() + 480_000), owner: getBillAnalysisOwner(),
    }, async () => { acquisitions++; throw new Error("A terminal UUID must not acquire resources"); });
    expect(replay.created).toBe(false);
    expect(acquisitions).toBe(0);
    const next = await claim({ ...input, requestId: randomUUID(), owner: getBillAnalysisOwner() });
    expect(next.created).toBe(true);
    await finishBillAnalysisExecution(input.session, next.result.requestId, next.lease);
  }, 20_000);

  it("does not infer that a foreign runtime stopped from an expired lease or absent local PID", async () => {
    const input = await fixture();
    input.owner = { ...input.owner, id: randomUUID(), runtime: "synthetic-unknown-runtime", pid: 2_000_000_000, startedAt: new Date(0) };
    const owned = await claim(input);
    await raw.resourceLease.update({ where: { token: owned.lease.token }, data: { expiresAt: new Date(0) } });
    expect(await reapStoppedBillAnalysisExecutions()).toBe(0);
    expect(await raw.resourceExecution.count({ where: { token: owned.lease.token } })).toBe(1);
  });

  it("retries locally settled cleanup after a database failure without changing a successful report", async () => {
    const input = await fixture();
    const owned = await claim(input);
    await owned.store.admitBillAnalysisRequest(input.session, input.requestId, { scope: { mode: "month", period: "2026-10", ledgerId: null, actorMemberId: null }, locale: "zh-CN", range: { from: "2026-10-01", to: "2026-10-31" }, snapshotAt: new Date().toISOString(), inputHash: "a".repeat(64) }, owned.lease);
    await owned.store.completeBillAnalysisRequest(input.session, input.requestId, { body: { overview: "Synthetic saved report", observations: [], recommendations: [], limitations: [] }, metrics: [{ ref: "current.expenseFen", label: "Expense", value: 0, unit: "fen" }], evidence: [] }, owned.lease);
    const before = await raw.billAnalysisReport.findFirstOrThrow({ where: { householdId: input.session.householdId } });
    const { physicalDb } = await import("@/lib/db");
    const outage = vi.spyOn(physicalDb, "$transaction").mockRejectedValueOnce(new Error("Synthetic database outage"));
    try { await expect(finishBillAnalysisExecution(input.session, input.requestId, owned.lease)).rejects.toThrow("Synthetic database outage"); }
    finally { outage.mockRestore(); }
    expect(await raw.resourceExecution.count({ where: { token: owned.lease.token } })).toBe(1);
    expect(await reapStoppedBillAnalysisExecutions()).toBe(1);
    expect(await raw.resourceExecution.count({ where: { token: owned.lease.token } })).toBe(0);
    expect(await raw.billAnalysisRequest.findFirstOrThrow({ where: { clientRequestId: input.requestId } })).toMatchObject({ status: "SUCCEEDED" });
    expect(await raw.billAnalysisReport.findFirstOrThrow({ where: { id: before.id } })).toEqual(before);
  });

  it("allows minimal cleanup after original-session revocation without authorizing another attempt", async () => {
    const input = await fixture();
    const owned = await claim(input);
    await owned.store.admitBillAnalysisRequest(input.session, input.requestId, { scope: { mode: "month", period: "2026-10", ledgerId: null, actorMemberId: null }, locale: "zh-CN", range: { from: "2026-10-01", to: "2026-10-31" }, snapshotAt: new Date().toISOString(), inputHash: "a".repeat(64) }, owned.lease);
    expect(await raw.billAnalysisReport.findFirstOrThrow({ where: { householdId: input.session.householdId } })).toMatchObject({ activeRequestId: expect.any(String) });
    await raw.appSession.update({ where: { id: input.session.appSessionId }, data: { revokedAt: new Date() } });
    await finishBillAnalysisExecution(input.session, input.requestId, owned.lease);
    expect(await raw.resourceExecution.count({ where: { token: owned.lease.token } })).toBe(0);
    expect(await raw.billAnalysisRequest.findFirstOrThrow({ where: { clientRequestId: input.requestId } })).toMatchObject({ status: "FAILED" });
    expect(await raw.billAnalysisReport.findFirstOrThrow({ where: { householdId: input.session.householdId } })).toMatchObject({ activeRequestId: null });
    await expect(owned.store.queryBillAnalysisRequest(input.session, input.requestId)).rejects.toThrow("Unauthorized");
  });
});
