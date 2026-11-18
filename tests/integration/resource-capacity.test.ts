import { randomUUID } from "node:crypto";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ExcelJS from "exceljs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

type ParserProbe = { child: ChildProcess; started: Promise<void>; receivedInput: boolean; maxRssKiB?: number };
const telemetry = vi.hoisted(() => ({ preload: "", parsers: [] as ParserProbe[] }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: (command: string, args: readonly string[] = [], options: SpawnOptions = {}) => {
    if (!args.some((argument) => argument.endsWith("xlsx-reader.mjs"))) return actual.spawn(command, args, options);
    // Preserve the production parser, heap cap and sanitized env; add only progress/RSS telemetry.
    const child = actual.spawn(command, ["--import", telemetry.preload, ...args], { ...options, stdio: ["pipe", "pipe", "pipe"] });
    let began!: () => void;
    const probe: ParserProbe = { child, started: new Promise<void>((resolve) => { began = resolve; }), receivedInput: false };
    telemetry.parsers.push(probe);
    let metrics = "";
    child.stderr.on("data", (chunk: Buffer) => {
      metrics = (metrics + chunk.toString("utf8")).slice(-4096);
      if (metrics.includes("BILLBOARD_CAPACITY_STARTED\n")) { probe.receivedInput = true; began(); }
      const maximum = /BILLBOARD_CAPACITY_RSS:(\d+)\n/.exec(metrics);
      if (maximum) probe.maxRssKiB = Number(maximum[1]);
    });
    child.once("close", () => began());
    return child;
  } };
});

process.loadEnvFile(".env.example");
let db: typeof import("@/lib/db").db;
let admission: typeof import("@/lib/resources/admission");
let loadXlsxWorkbook: typeof import("@/lib/imports/xlsx").loadXlsxWorkbook;
let parseAlipayCsv: typeof import("@/lib/imports/sources/alipay").parseAlipayCsv;
let createTransaction: typeof import("@/lib/transactions/create-transaction").createTransaction;
let listRecords: typeof import("@/lib/records/list-records").listRecords;
let temporary: string;
let workbook: Buffer;
let categoryId: string;
const households: string[] = [];
const users: string[] = [];
const rowsPerParser = 20_000;

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  if (process.env.NODE_ENV === "production" || !["127.0.0.1", "localhost"].includes(url.hostname) || !/_(?:dev|test)$/.test(url.pathname)) {
    throw new Error("Resource capacity tests require a local development/test database");
  }
  ({ db } = await import("@/lib/db"));
  admission = await import("@/lib/resources/admission");
  ({ loadXlsxWorkbook } = await import("@/lib/imports/xlsx"));
  ({ parseAlipayCsv } = await import("@/lib/imports/sources/alipay"));
  ({ createTransaction } = await import("@/lib/transactions/create-transaction"));
  ({ listRecords } = await import("@/lib/records/list-records"));
  await db.resourceLease.deleteMany();
  await db.resourceWindow.deleteMany();
  const category = await db.category.create({ data: { name: `Capacity fixture ${randomUUID()}`, type: "EXPENSE", sortOrder: 9999 } });
  categoryId = category.id;
  temporary = await mkdtemp(path.join(tmpdir(), "billboard-resource-capacity-"));
  const preload = path.join(temporary, "parser-metrics.mjs");
  await writeFile(preload, [
    "process.stdin.once('end', () => process.stderr.write('BILLBOARD_CAPACITY_STARTED\\n'));",
    "process.once('beforeExit', () => process.stderr.write('BILLBOARD_CAPACITY_RSS:' + process.resourceUsage().maxRSS + '\\n'));",
  ].join("\n"));
  telemetry.preload = pathToFileURL(preload).href;
  const filename = path.join(temporary, "synthetic.xlsx");
  const writer = new ExcelJS.stream.xlsx.WorkbookWriter({ filename, useSharedStrings: false, useStyles: false });
  const sheet = writer.addWorksheet("支出");
  sheet.addRow(["交易类型", "日期", "一级分类", "二级分类", "账户1", "账户币种", "金额", "成员", "商家", "记账人", "备注"]).commit();
  for (let index = 0; index < rowsPerParser; index += 1) {
    sheet.addRow(["支出", "2026-10-21 12:00:00", "餐饮", "三餐", "银行卡", "CNY", "10.01", "Example", "", "Example", `Synthetic row ${index}`]).commit();
  }
  sheet.commit();
  await writer.commit();
  workbook = await readFile(filename);
}, 30_000);

afterAll(async () => {
  for (const { child } of telemetry.parsers) {
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => { child.once("close", () => resolve()); child.kill("SIGKILL"); });
    }
  }
  if (db) {
    await db.resourceLease.deleteMany();
    await db.resourceWindow.deleteMany();
    await db.household.deleteMany({ where: { id: { in: households } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
    if (categoryId) await db.category.delete({ where: { id: categoryId } });
    await db.$disconnect();
  }
  if (temporary) {
    const resolved = path.resolve(temporary);
    if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith("billboard-resource-capacity-")) {
      throw new Error("Unexpected capacity fixture directory");
    }
    await rm(resolved, { recursive: true, force: true });
  }
});

async function fixture() {
  const household = await db.household.create({ data: { name: "Capacity fixture" } });
  households.push(household.id);
  const ledger = await db.ledger.create({ data: { householdId: household.id, name: "Daily", isDefault: true } });
  const user = await db.user.create({ data: { email: `capacity-${randomUUID()}@example.com`, displayName: "Example", passwordHash: "test-only" } });
  users.push(user.id);
  const member = await db.householdMember.create({ data: { householdId: household.id, userId: user.id, memberName: "Example", role: "OWNER" } });
  const session = await db.appSession.create({ data: { userId: user.id, memberId: member.id, sessionKey: randomUUID(), expiresAt: new Date(Date.now() + 60 * 60_000) } });
  return { id: user.id, householdId: household.id, memberId: member.id, appSessionId: session.id, ledgerId: ledger.id };
}

function round(value: number) { return Math.round(value * 100) / 100; }

describe("representative shared parser capacity", () => {
  it("keeps another household responsive during two 20MiB Alipay parses and releases cancelled work only after it stops", async () => {
    const sessions = await Promise.all([fixture(), fixture(), fixture()]);
    const headers = ["交易时间", "交易分类", "交易对方", "对方账号", "商品说明", "收/支", "金额", "收/付款方式", "交易状态", "交易订单号", "商家订单号", "备注"];
    const data = Array.from({ length: rowsPerParser }, (_, index) => [
      index % 2 ? "2026-10-21 18:00:00" : "2026-10-21 12:00:00", index % 2 ? "退款" : "餐饮美食", "Synthetic", "/", "Synthetic product",
      index % 2 ? "不计收支" : "支出", index % 2 ? "1.15" : "22.85", "Synthetic account", index % 2 ? "退款成功" : "交易成功", `order-${index}`, `merchant-${Math.floor(index / 2)}`, "/",
    ]);
    const serialize = () => Buffer.from(["导出信息：", "姓名：Synthetic", headers.join(","), ...data.map((row) => row.join(","))].join("\n"));
    let input = serialize();
    const targetBytes = 20 * 1024 * 1024;
    const padding = "x".repeat(Math.floor((targetBytes - input.length) / rowsPerParser));
    data.forEach((row) => { row[4] += padding; });
    input = serialize();
    data[0][4] += "x".repeat(targetBytes - input.length);
    input = serialize();
    expect(input.length).toBe(targetBytes);
    let start!: () => void;
    const startGate = new Promise<void>((resolve) => { start = resolve; });
    const began: Promise<void>[] = [];
    let completedParsers = 0;
    const parserElapsedMs: number[] = [];
    const work = sessions.slice(0, 2).map((session, index) => {
      let admitted!: () => void;
      began.push(new Promise<void>((resolve) => { admitted = resolve; }));
      return admission.withResourceLease(session, "import", async (lease) => {
        admitted();
        await startGate;
        const started = performance.now();
        const result = await parseAlipayCsv(input, lease.signal);
        parserElapsedMs[index] = round(performance.now() - started);
        expect(result.invalidRows).toEqual([]);
        expect(result.rows).toHaveLength(rowsPerParser / 2);
        expect(result.rows.every(({ amountFen, refundHandling }) => amountFen === 2170 && refundHandling === "ALIPAY_PARTIAL")).toBe(true);
        await db.$transaction((tx) => admission.assertResourceLease(tx, lease));
        completedParsers += 1;
      });
    });
    const settled = Promise.allSettled(work);
    let maximumHeartbeatGapMs = 0;
    let previousHeartbeat = performance.now();
    let heartbeatTicks = 0;
    const heartbeat = setInterval(() => {
      const now = performance.now();
      maximumHeartbeatGapMs = Math.max(maximumHeartbeatGapMs, now - previousHeartbeat);
      previousHeartbeat = now;
      heartbeatTicks += 1;
    }, 0);
    let manualElapsedMs = 0;
    try {
      await Promise.all(began);
      expect(await db.resourceLease.count({ where: { kind: "import" } })).toBe(2);
      const extraWork = vi.fn(async () => undefined);
      await expect(admission.withResourceLease(sessions[2], "import", extraWork)).rejects.toMatchObject({ code: "BUSY" });
      expect(extraWork).not.toHaveBeenCalled();
      start();
      const beganManual = performance.now();
      const manual = sessions[2];
      expect(await createTransaction({
        clientRequestId: randomUUID(), context: { householdId: manual.householdId, memberId: manual.memberId, ledgerId: manual.ledgerId },
        type: "expense", amount: "1.23", categoryId, actorMemberId: manual.memberId, occurredAt: "2026-10-21T12:00",
      }, manual)).toMatchObject({ amountFen: 123, wasCreated: true });
      const records = await listRecords({
        householdId: manual.householdId, currentMemberId: manual.memberId,
        rangeBounds: { from: new Date("2026-10-20T16:00:00.000Z"), to: new Date("2026-10-21T15:59:59.999Z") },
      });
      expect(records).toHaveLength(1);
      expect(records[0].amountFen).toBe(123);
      manualElapsedMs = round(performance.now() - beganManual);
      expect(completedParsers).toBe(0);
      expect(manualElapsedMs).toBeLessThan(1000);
    } finally {
      start();
      const results = await settled;
      clearInterval(heartbeat);
      expect(results.map(({ status }) => status)).toEqual(["fulfilled", "fulfilled"]);
    }
    expect(heartbeatTicks).toBeGreaterThan(5);
    expect(maximumHeartbeatGapMs).toBeLessThan(250);
    expect(await db.resourceLease.count()).toBe(0);
    const controller = new AbortController();
    let parserStopped = false;
    const cancelled = admission.withResourceLease(sessions[2], "import", async (lease) => {
      const timer = setTimeout(() => controller.abort(), 20);
      try { await parseAlipayCsv(input, lease.signal); }
      finally { clearTimeout(timer); parserStopped = true; }
    }, { signal: controller.signal }).then(() => "unexpected-success", (error: Error) => error.message);
    expect(await cancelled).toBe("xlsx-timeout");
    expect(parserStopped).toBe(true);
    expect(await db.resourceLease.count()).toBe(0);
    const evidenceDirectory = path.join(process.cwd(), "tmp", "validation", "four-phase-gaps", "processing");
    await mkdir(evidenceDirectory, { recursive: true });
    const summary = { inputBytesPerParser: input.length, rowsPerParser, parserElapsedMs, manualElapsedMs,
      manualDuringProcessing: true, maximumHeartbeatGapMs: round(maximumHeartbeatGapMs), heartbeatTicks,
      cancelledParserActuallyStopped: parserStopped, remainingLeases: 0 };
    await writeFile(path.join(evidenceDirectory, "csv-shared-capacity.json"), `${JSON.stringify(summary, null, 2)}\n`);
    console.info("csv-shared-capacity", JSON.stringify(summary));
  }, 30_000);

  it("processes two real 20,000-row workbooks while another household records and reads manually", async () => {
    const sessions = await Promise.all([fixture(), fixture(), fixture()]);
    const startedAt = performance.now();
    const elapsed: number[] = [];
    const work = sessions.slice(0, 2).map((session, index) => admission.withResourceLease(session, "import", async (lease) => {
      const began = performance.now();
      const parsed = await loadXlsxWorkbook(workbook, lease.signal);
      expect(parsed.worksheets).toHaveLength(1);
      expect(parsed.worksheets[0].rows).toHaveLength(rowsPerParser + 1);
      await db.$transaction((tx) => admission.assertResourceLease(tx, lease));
      elapsed[index] = round(performance.now() - began);
    }));
    const settled = Promise.allSettled(work);
    let manualElapsedMs = 0;
    let manualDuringProcessing = false;
    try {
      await vi.waitFor(() => expect(telemetry.parsers).toHaveLength(2), { timeout: 10_000 });
      await Promise.all(telemetry.parsers.map((probe) => probe.started));
      expect(telemetry.parsers.every(({ child, receivedInput }) => receivedInput && child.exitCode === null && child.signalCode === null)).toBe(true);
      expect(await db.resourceLease.count({ where: { kind: "import" } })).toBe(2);
      const extraWork = vi.fn(async () => undefined);
      await expect(admission.withResourceLease(sessions[2], "import", extraWork)).rejects.toMatchObject({ code: "BUSY" });
      expect(extraWork).not.toHaveBeenCalled();
      const beganManual = performance.now();
      const manual = sessions[2];
      expect(await createTransaction({
        clientRequestId: randomUUID(), context: { householdId: manual.householdId, memberId: manual.memberId, ledgerId: manual.ledgerId },
        type: "expense", amount: "1.23", categoryId, actorMemberId: manual.memberId, occurredAt: "2026-10-21T12:00",
      }, manual)).toMatchObject({ amountFen: 123, wasCreated: true });
      const records = await listRecords({
        householdId: manual.householdId, currentMemberId: manual.memberId,
        rangeBounds: { from: new Date("2026-10-20T16:00:00.000Z"), to: new Date("2026-10-21T15:59:59.999Z") },
      });
      expect(records).toHaveLength(1);
      expect(records[0].amountFen).toBe(123);
      manualElapsedMs = round(performance.now() - beganManual);
      manualDuringProcessing = telemetry.parsers.every(({ child }) => child.exitCode === null && child.signalCode === null);
      expect(manualDuringProcessing).toBe(true);
    } finally {
      const results = await settled;
      expect(results.map((result) => result.status === "fulfilled" ? "completed" :
        result.reason instanceof Error && ["xlsx-timeout", "xlsx-resource-limit", "xlsx-busy", "unreadable-xlsx-file"].includes(result.reason.message)
          ? result.reason.message : "failed")).toEqual(["completed", "completed"]);
    }
    expect(await db.resourceLease.count()).toBe(0);
    expect(telemetry.parsers).toHaveLength(2);
    expect(new Set(telemetry.parsers.map(({ child }) => child.pid)).size).toBe(2);
    expect(telemetry.parsers.every(({ maxRssKiB }) => Number.isFinite(maxRssKiB) && maxRssKiB! > 0)).toBe(true);
    const parserPeakRssKiB = telemetry.parsers.map(({ maxRssKiB }) => maxRssKiB!);
    const controller = new AbortController();
    const cancelled = admission.withResourceLease(sessions[2], "import", async (lease) => {
      await loadXlsxWorkbook(workbook, lease.signal);
    }, { signal: controller.signal }).then(() => "unexpected-success", (error: Error) => error.message);
    await vi.waitFor(() => expect(telemetry.parsers).toHaveLength(3), { timeout: 10_000 });
    await telemetry.parsers[2].started;
    controller.abort();
    expect(await cancelled).toBe("xlsx-timeout");
    expect(telemetry.parsers[2].child.exitCode !== null || telemetry.parsers[2].child.signalCode !== null).toBe(true);
    expect(await db.resourceLease.count()).toBe(0);
    const applicationPeakRssKiB = process.resourceUsage().maxRSS;
    // Per-process peaks can occur at different moments; their sum is an upper bound.
    const summary = {
      rowsPerParser, totalParsedRows: rowsPerParser * 2, parserElapsedMs: elapsed,
      manualElapsedMs, manualDuringProcessing, parserPeakRssKiB, applicationPeakRssKiB,
      combinedPeakRssUpperBoundKiB: applicationPeakRssKiB + parserPeakRssKiB.reduce((sum, rss) => sum + rss, 0),
      elapsedMs: round(performance.now() - startedAt), cancelledParsers: 1, remainingLeases: 0,
    };
    const evidenceDirectory = path.join(process.cwd(), "tmp", "validation", "phase-four");
    await mkdir(evidenceDirectory, { recursive: true });
    await writeFile(path.join(evidenceDirectory, "resource-capacity.json"), `${JSON.stringify(summary, null, 2)}\n`);
    console.info("resource-capacity", JSON.stringify(summary));
  }, 60_000);
});
