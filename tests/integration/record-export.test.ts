import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import type { Prisma } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startRecordExportCleanup } from "@/lib/exports/temp-file";

if (existsSync(".env")) process.loadEnvFile(".env");
process.loadEnvFile(".env.example");

const state = vi.hoisted(() => ({ directory: "", unlinkFailure: "", session: undefined as unknown }));
vi.mock("node:os", async (original) => {
  const actual = await original<typeof import("node:os")>();
  return { ...actual, tmpdir: () => state.directory || actual.tmpdir() };
});
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, unlink: vi.fn(async (filename: Parameters<typeof actual.unlink>[0]) => {
    if (String(filename) === state.unlinkFailure) throw Object.assign(new Error("temporary filesystem failure"), { code: "EPERM" });
    return actual.unlink(filename);
  }) };
});
vi.mock("@/lib/auth/session", () => ({ requireAppSession: vi.fn(async () => {
  if (!state.session) throw new Error("Unauthorized");
  return state.session;
}) }));

type FixtureSession = { id: string; email: string; name: string; householdId: string; memberId: string; appSessionId: string; role: "OWNER" };
let db: typeof import("@/lib/db").db;
let generateRecordExport: typeof import("@/lib/exports/service").generateRecordExport;
let parseRecordExportInput: typeof import("@/lib/exports/input").parseRecordExportInput;
let POST: typeof import("@/app/api/records/export/route").POST;
let session: FixtureSession;
let mainId: string;
let archivedId: string;
let otherId: string;
let foreignId: string;
let historicalMemberId: string;
let foreignMemberId: string;
let categoryId: string;
const households: string[] = [];
const users: string[] = [];
const artifacts: Array<Awaited<ReturnType<typeof generateRecordExport>>> = [];
const plaintextCanary = "PRIVATE_UNENCRYPTED_EXPORT_CANARY";
const input = () => parseRecordExportInput({ from: "2026-10-01", to: "2026-10-31", locale: "zh-CN" });

async function generate(extra: Partial<ReturnType<typeof input>> = {}, options?: { signal?: AbortSignal }) {
  const artifact = await generateRecordExport(session, { ...input(), ...extra }, options);
  artifacts.push(artifact);
  return artifact;
}

async function read(artifact: Awaited<ReturnType<typeof generate>>) {
  const download = await artifact.claim(session);
  const bytes = Buffer.from(await new Response(download.body).arrayBuffer());
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes);
  return workbook.worksheets[0];
}

async function temporaryFiles() {
  const root = path.join(state.directory, "billboard-record-exports");
  const entries = await fs.readdir(root).catch(() => []);
  const files = await Promise.all(entries.map((entry) => fs.readdir(path.join(root, entry)).catch(() => [])));
  return files.flat();
}

async function fixture() {
  for (let index = 0; index < 2; index++) {
    const user = await db.user.create({ data: { email: `export-${randomUUID()}@example.test`, displayName: "Export member", passwordHash: "not-used" } });
    users.push(user.id);
    const household = await db.household.create({ data: { name: "Export fixture", ledgers: { create: [{ name: "Default", isDefault: true }, { name: "旅行账本" }, { name: "归档账本", archivedAt: new Date() }] } } });
    households.push(household.id);
    const member = await db.householdMember.create({ data: { householdId: household.id, userId: user.id, memberName: "当前成员", role: "OWNER" } });
    const original = await db.appSession.create({ data: { sessionKey: randomUUID(), userId: user.id, memberId: member.id, expiresAt: new Date(Date.now() + 3_600_000) } });
    const ledgers = await db.ledger.findMany({ where: { householdId: household.id } });
    const main = ledgers.find((ledger) => ledger.isDefault)!;
    const archived = ledgers.find((ledger) => ledger.archivedAt)!;
    const other = ledgers.find((ledger) => !ledger.isDefault && !ledger.archivedAt)!;
    const base = { householdId: household.id, categoryId, actorMemberId: member.id, createdByMemberId: member.id, type: "EXPENSE" as const };
    if (index === 0) {
      session = { id: user.id, email: user.email, name: user.displayName, householdId: household.id, memberId: member.id, appSessionId: original.id, role: "OWNER" };
      mainId = main.id; archivedId = archived.id; otherId = other.id;
      const former = await db.user.create({ data: { email: `export-former-${randomUUID()}@example.test`, displayName: "Historical member", passwordHash: "not-used" } });
      users.push(former.id);
      const historic = await db.householdMember.create({ data: { householdId: household.id, userId: former.id, memberName: "历史成员", role: "MEMBER", leftAt: new Date() } });
      historicalMemberId = historic.id;
      await db.transaction.createMany({ data: [
        { ...base, ledgerId: main.id, amountFen: 1, occurredAt: new Date("2026-09-30T16:00:00Z"), note: "=HYPERLINK(\"https://example.test\",\"x\")", source: "wechat_pay", sourceFingerprint: "hidden-source-fingerprint" },
        { ...base, ledgerId: other.id, amountFen: 200, occurredAt: new Date("2026-10-15T04:00:00Z"), note: plaintextCanary },
        { ...base, ledgerId: archived.id, actorMemberId: historic.id, createdByMemberId: historic.id, amountFen: 300, occurredAt: new Date("2026-10-31T15:59:59.999Z") },
        { ...base, ledgerId: main.id, amountFen: 999, occurredAt: new Date("2026-10-15T04:00:00Z"), deletedAt: new Date() },
        { ...base, ledgerId: main.id, amountFen: 888, occurredAt: new Date("2026-09-30T15:59:59.999Z") },
        { ...base, ledgerId: main.id, amountFen: 777, occurredAt: new Date("2026-10-31T16:00:00Z") },
      ] });
    } else {
      foreignId = main.id;
      foreignMemberId = member.id;
      await db.transaction.create({ data: { ...base, ledgerId: main.id, amountFen: 555, occurredAt: new Date("2026-10-15T04:00:00Z"), note: "foreign-private-record" } });
    }
  }
  state.session = session;
}

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  if (process.env.NODE_ENV === "production" || !["127.0.0.1", "localhost"].includes(url.hostname) || !/dev|test/i.test(url.pathname)) throw new Error("Export tests require a local dev/test database");
  state.directory = await fs.mkdtemp(path.join(tmpdir(), "billboard-export-integration-"));
  ({ db } = await import("@/lib/db"));
  ({ generateRecordExport } = await import("@/lib/exports/service"));
  ({ parseRecordExportInput } = await import("@/lib/exports/input"));
  ({ POST } = await import("@/app/api/records/export/route"));
  categoryId = (await db.category.findFirstOrThrow({ where: { name: "Dining", type: "EXPENSE" } })).id;
});

beforeEach(async () => {
  await db.resourceLease.deleteMany({ where: { kind: "export" } });
  await db.resourceWindow.deleteMany({ where: { kind: "export" } });
  await fixture();
});

afterEach(async () => {
  state.unlinkFailure = "";
  vi.restoreAllMocks();
  vi.useRealTimers();
  await Promise.all(artifacts.splice(0).map((artifact) => artifact.dispose().catch(() => undefined)));
  state.session = undefined;
  await db.resourceLease.deleteMany({ where: { kind: "export" } });
  await db.resourceWindow.deleteMany({ where: { kind: "export" } });
  await db.transaction.deleteMany({ where: { householdId: { in: households } } });
  await db.appSession.deleteMany({ where: { userId: { in: users } } });
  await db.householdMember.deleteMany({ where: { householdId: { in: households } } });
  await db.household.deleteMany({ where: { id: { in: households.splice(0) } } });
  await db.user.deleteMany({ where: { id: { in: users.splice(0) } } });
});

afterAll(async () => {
  await (await startRecordExportCleanup())();
  await db?.$disconnect();
  await fs.rm(state.directory, { recursive: true, force: true });
});

describe("authorized consistent Excel export", () => {
  it("exports the family range including archived and historic members without soft-deleted or foreign rows", async () => {
    const artifact = await generate();
    expect(artifact.rowCount).toBe(3);
    const root = path.join(state.directory, "billboard-record-exports");
    const directories = await fs.readdir(root);
    expect(directories).toHaveLength(1);
    const stored = await fs.readFile(path.join(root, directories[0], "records.xlsx"));
    expect(stored.subarray(0, 6).toString()).toBe("BBEF1\n");
    expect(stored.subarray(0, 2).toString()).not.toBe("PK");
    expect(stored.includes(Buffer.from("xl/worksheets/sheet1.xml"))).toBe(false);
    expect(stored.includes(Buffer.from(plaintextCanary))).toBe(false);
    const sheet = await read(artifact);
    expect(sheet.rowCount).toBe(4);
    expect([2, 3, 4].map((index) => sheet.getRow(index).getCell(7).value).sort()).toEqual([1, 200, 300]);
    const historical = [2, 3, 4].map((index) => sheet.getRow(index)).find((row) => row.getCell(7).value === 300)!;
    expect(historical.getCell(1).text).toContain("归档");
    expect(historical.getCell(2).text).toContain("历史成员");
    expect(historical.getCell(8).text).toBe("2026-10-31 23:59:59.999");
    expect([2, 3, 4].map((index) => sheet.getRow(index)).find((row) => row.getCell(7).value === 200)!.getCell(9).value).toBe(plaintextCanary);
    expect(JSON.stringify(sheet.model)).not.toContain("hidden-source-fingerprint");
    expect(JSON.stringify(sheet.model)).not.toContain("foreign-private-record");
    expect(await temporaryFiles()).toEqual([]);
    expect(await db.resourceLease.count({ where: { kind: "export" } })).toBe(0);
  });

  it("supports a single archived ledger and rejects a foreign ledger before creating an artifact", async () => {
    const sheet = await read(await generate({ ledgerId: archivedId }));
    expect(sheet.rowCount).toBe(2);
    expect(sheet.getRow(2).getCell(7).value).toBe(300);
    await expect(generate({ ledgerId: foreignId })).rejects.toMatchObject({ code: "unauthorized" });
    expect(await temporaryFiles()).toEqual([]);
  });

  it("exports the selected historical actor and keeps current-actor totals independent", async () => {
    const historical = await read(await generate({ actorMemberId: historicalMemberId }));
    expect(historical.rowCount).toBe(2);
    expect(historical.getRow(2).getCell(7).value).toBe(300);
    expect(historical.getRow(2).getCell(2).text).toContain("历史成员");
    const current = await read(await generate({ actorMemberId: session.memberId }));
    expect(current.rowCount).toBe(3);
    expect([2, 3].map((index) => current.getRow(index).getCell(7).value).sort()).toEqual([1, 200]);
  });

  it("rejects foreign or missing actor identities before charging export resources", async () => {
    for (const actorMemberId of [foreignMemberId, randomUUID()]) {
      await expect(generate({ actorMemberId })).rejects.toMatchObject({ code: "unauthorized" });
    }
    expect(await temporaryFiles()).toEqual([]);
    expect(await db.resourceLease.count({ where: { kind: "export" } })).toBe(0);
    expect(await db.resourceWindow.count({ where: { kind: "export" } })).toBe(0);
  });

  it.each(["revoke", "expire", "leave", "deactivate", "close"] as const)("refuses an already generated file after %s and removes it", async (change) => {
    const artifact = await generate();
    expect(await temporaryFiles()).toEqual(["records.xlsx"]);
    if (change === "revoke") await db.appSession.update({ where: { id: session.appSessionId }, data: { revokedAt: new Date() } });
    if (change === "expire") await db.appSession.update({ where: { id: session.appSessionId }, data: { expiresAt: new Date(0) } });
    if (change === "leave") await db.householdMember.update({ where: { id: session.memberId }, data: { leftAt: new Date() } });
    if (change === "deactivate") await db.user.update({ where: { id: session.id }, data: { status: "DEACTIVATED" } });
    if (change === "close") await db.household.update({ where: { id: session.householdId }, data: { closedAt: new Date() } });
    await expect(artifact.claim(session)).rejects.toMatchObject({ code: "unauthorized" });
    expect(await temporaryFiles()).toEqual([]);
    expect(await db.transaction.count({ where: { householdId: session.householdId } })).toBe(6);
    expect(await db.resourceLease.count({ where: { kind: "export" } })).toBe(0);
  });

  it("binds a generated artifact to the original server session and identity", async () => {
    const artifact = await generate();
    const second = await db.appSession.create({ data: { sessionKey: randomUUID(), userId: session.id, memberId: session.memberId, expiresAt: new Date(Date.now() + 60_000) } });
    await expect(artifact.claim({ ...session, appSessionId: second.id })).rejects.toMatchObject({ code: "unauthorized" });
    expect(await temporaryFiles()).toEqual([]);
  });

  it("keeps its lease until body consumption or cancellation and rejects concurrent exports", async () => {
    const artifact = await generate();
    expect(await db.resourceLease.count({ where: { kind: "export" } })).toBe(1);
    await expect(generate()).rejects.toMatchObject({ code: "busy" });
    const download = await artifact.claim(session);
    await download.body.cancel();
    expect(await temporaryFiles()).toEqual([]);
    expect(await db.resourceLease.count({ where: { kind: "export" } })).toBe(0);
  });

  it("cleans an unclaimed expired artifact and fences a deleted resource lease", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const artifact = await generate();
    await vi.advanceTimersByTimeAsync(180_001);
    await artifact.dispose();
    await expect(artifact.claim(session)).rejects.toThrow();
    expect(await temporaryFiles()).toEqual([]);
  });

  it("does not claim a file whose resource lease was invalidated after generation", async () => {
    const artifact = await generate();
    await db.resourceLease.deleteMany({ where: { kind: "export" } });
    await expect(artifact.claim(session)).rejects.toMatchObject({ code: "timeout" });
    expect(await temporaryFiles()).toEqual([]);
  });

  it("releases a generated file when the original request aborts before claiming", async () => {
    const controller = new AbortController();
    const artifact = await generate({}, { signal: controller.signal });
    controller.abort();
    await artifact.dispose();
    expect(await temporaryFiles()).toEqual([]);
    expect(await db.resourceLease.count({ where: { kind: "export" } })).toBe(0);
  });

  it("retries failed private cleanup without another request and retains its lease until removal", async () => {
    const artifact = await generate();
    const root = path.join(state.directory, "billboard-record-exports");
    const [entry] = await fs.readdir(root);
    state.unlinkFailure = path.join(root, entry, "records.xlsx");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await expect(artifact.dispose()).rejects.toMatchObject({ code: "EPERM" });
    expect(await temporaryFiles()).toEqual(["records.xlsx"]);
    expect(await db.resourceLease.count({ where: { kind: "export" } })).toBe(1);
    await expect(generate()).rejects.toMatchObject({ code: "busy" });
    state.unlinkFailure = "";
    await vi.advanceTimersByTimeAsync(1_001);
    await vi.waitFor(async () => {
      expect(await temporaryFiles()).toEqual([]);
      expect(await db.resourceLease.count({ where: { kind: "export" } })).toBe(0);
    });
  });

  it("keeps all pages in one repeatable-read snapshot while records change concurrently", async () => {
    await db.transaction.createMany({ data: Array.from({ length: 510 }, (_, index) => ({
      householdId: session.householdId, ledgerId: otherId, actorMemberId: session.memberId,
      createdByMemberId: session.memberId, categoryId, type: "EXPENSE" as const,
      amountFen: 100, occurredAt: new Date("2026-10-15T04:00:00Z"), note: `snapshot-${index}`,
    })) });
    const originalTransaction = db.$transaction.bind(db);
    let mutated = false;
    vi.spyOn(db, "$transaction").mockImplementation(((callback: (tx: Prisma.TransactionClient) => Promise<unknown>, settings?: Parameters<typeof originalTransaction>[1]) =>
      originalTransaction(async (tx) => {
        const findMany = tx.transaction.findMany.bind(tx.transaction);
        tx.transaction.findMany = (async (args) => {
          const batch = await findMany(args);
          if (!mutated && args?.take === 500) {
            mutated = true;
            await db.transaction.updateMany({ where: { householdId: session.householdId, note: { startsWith: "snapshot-" } }, data: { amountFen: 900 } });
          }
          return batch;
        }) as typeof tx.transaction.findMany;
        return callback(tx);
      }, settings)) as typeof db.$transaction);
    const sheet = await read(await generate({ ledgerId: otherId, actorMemberId: session.memberId }));
    expect(mutated).toBe(true);
    expect(sheet.rowCount).toBe(512);
    const amounts: number[] = [];
    sheet.eachRow((row, index) => { if (index > 1 && row.getCell(9).text.startsWith("snapshot-")) amounts.push(Number(row.getCell(7).value)); });
    expect(amounts).toHaveLength(510);
    expect(new Set(amounts)).toEqual(new Set([100]));
    expect(await db.transaction.count({ where: { householdId: session.householdId, amountFen: 900 } })).toBe(510);
  });

  it("rejects cancelled and oversized work without leaving temporary financial files", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(generate({}, { signal: controller.signal })).rejects.toMatchObject({ code: "cancelled" });
    await db.transaction.updateMany({ where: { householdId: session.householdId, ledgerId: mainId }, data: { note: "x".repeat(32_768) } });
    await expect(generate()).rejects.toMatchObject({ code: "too_large" });
    expect(await temporaryFiles()).toEqual([]);
    expect(await db.resourceLease.count({ where: { kind: "export" } })).toBe(0);
  });

  it("generates and downloads a representative 20,000-row household export in bounded pages", async () => {
    for (let start = 0; start < 20_000; start += 1000) await db.transaction.createMany({ data: Array.from({ length: 1000 }, (_, offset) => ({
      householdId: session.householdId, ledgerId: otherId, actorMemberId: session.memberId,
      createdByMemberId: session.memberId, categoryId, type: "EXPENSE" as const,
      amountFen: 12345, occurredAt: new Date("2026-10-15T04:00:00Z"), note: `Large export row ${start + offset}`,
    })) });
    const startedAt = performance.now();
    const initialRss = process.memoryUsage().rss;
    let peakRss = initialRss;
    const sampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 20);
    try {
      const artifact = await generate({ ledgerId: otherId });
      expect(artifact.rowCount).toBe(20_001);
      const download = await artifact.claim(session);
      const bytes = new Uint8Array(await new Response(download.body).arrayBuffer());
      expect(bytes.byteLength).toBe(download.byteLength);
      expect([...bytes.slice(0, 2)]).toEqual([0x50, 0x4b]);
      expect(bytes.byteLength).toBeLessThan(32 * 1024 * 1024);
      expect(await temporaryFiles()).toEqual([]);
      expect(await db.resourceLease.count({ where: { kind: "export" } })).toBe(0);
      console.info(JSON.stringify({ check: "record-export-capacity", rows: artifact.rowCount, xlsxBytes: bytes.byteLength,
        elapsedMs: Math.round(performance.now() - startedAt), initialRssBytes: initialRss, peakRssBytes: peakRss, rssIncreaseBytes: peakRss - initialRss }));
    } finally { clearInterval(sampler); }
  }, 60_000);

  it("protects the actual POST entry, bounds its body and sends only no-store attachments", async () => {
    const request = (body: unknown, headers: Record<string, string> = {}, url = "http://localhost:2500/api/records/export") => new Request(url, {
      method: "POST", headers: { origin: "http://localhost:2500", "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body),
    });
    const value = { from: "2026-10-01", to: "2026-10-31", locale: "en-US" };
    expect((await POST(request(value, { origin: "https://other.example.test" }))).status).toBe(403);
    expect((await POST(request("x".repeat(5000)))).status).toBe(400);
    expect((await POST(request({ ...value, householdId: households[1] }))).status).toBe(400);
    expect((await POST(request(value, {}, "http://localhost:2500/api/records/export?token=example"))).status).toBe(400);
    const response = await POST(request(value));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="billboard-records_2026-10-01_2026-10-31.xlsx"');
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(Buffer.from(await response.arrayBuffer()));
    expect(workbook.worksheets[0].name).toBe("Records");
    expect(await temporaryFiles()).toEqual([]);
    state.session = undefined;
    expect((await POST(request(value))).status).toBe(401);
  });
});
