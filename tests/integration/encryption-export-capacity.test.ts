import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { PrismaClient, type Prisma } from "@prisma/client";
import ExcelJS from "exceljs";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createHouseholdCode, createKeyRing, sealKeyRing, type KeyRing } from "@/lib/encryption/crypto";
import { encryptRow } from "@/lib/encryption/protected-models";
import { runEncryptionContext } from "@/lib/encryption/request-context";
import { ENCRYPTED_EXPORT_OVERHEAD } from "@/lib/exports/encrypted-file";
import { parseRecordExportInput } from "@/lib/exports/input";
import { MAX_RECORD_EXPORT_BYTES, MAX_RECORD_EXPORT_ROWS } from "@/lib/exports/workbook";
import { getMessages } from "@/lib/i18n";

const state = vi.hoisted(() => ({ directory: "", parentDirectory: "" }));
vi.mock("server-only", () => ({}));
vi.mock("node:os", async (original) => {
  const actual = await original<typeof import("node:os")>();
  return { ...actual, tmpdir: () => state.directory || actual.tmpdir() };
});

if (existsSync(".env.example")) process.loadEnvFile(".env.example");

let raw: PrismaClient;
let db: typeof import("@/lib/db").db;
let generateRecordExport: typeof import("@/lib/exports/service").generateRecordExport;
let stopCleanup: (() => Promise<void>) | undefined;
const householdIds: string[] = [];
const userIds: string[] = [];
const memberIds: string[] = [];
const categoryIds: string[] = [];
const artifacts: Array<Awaited<ReturnType<typeof generateRecordExport>>> = [];
const input = parseRecordExportInput({ from: "2026-10-01", to: "2026-10-31", locale: "zh-CN" });
const timestamp = new Date("2026-10-15T04:00:00.123Z");
const generationLimitMs = 60_000;
const visibleRows = 100_000;
const batchSize = 500;
const encryptionConcurrency = 32;

type Fixture = {
  session: { id: string; householdId: string; memberId: string; appSessionId: string; role: "OWNER" };
  ledgerId: string; archivedLedgerId: string; historicalMemberId: string;
  expenseId: string; incomeId: string; expenseName: string; incomeName: string; ring: KeyRing;
};
type Stage = "seed" | "generate" | "download" | "parse" | "tooLarge";
type Memory = { rss: number; heapUsed: number; external: number; arrayBuffers: number };

beforeAll(async () => {
  if (!process.env.DATABASE_URL || process.env.NODE_ENV === "production") throw new Error("A local development database is required for encrypted export capacity tests");
  const url = new URL(process.env.DATABASE_URL);
  if (!["localhost", "127.0.0.1"].includes(url.hostname) || !/_(dev|test)$/.test(url.pathname)) {
    throw new Error("Refusing a non-local or non-development encrypted export database");
  }
  const actualOs = await vi.importActual<typeof import("node:os")>("node:os");
  state.parentDirectory = actualOs.tmpdir();
  state.directory = await fs.mkdtemp(path.join(state.parentDirectory, "billboard-encrypted-export-capacity-"));
  raw = new PrismaClient();
  ({ db } = await import("@/lib/db"));
  ({ generateRecordExport } = await import("@/lib/exports/service"));
  const { startRecordExportCleanup } = await import("@/lib/exports/temp-file");
  stopCleanup = await startRecordExportCleanup();
});

afterAll(async () => {
  await Promise.all(artifacts.map((artifact) => artifact.dispose().catch(() => undefined)));
  await stopCleanup?.();
  if (raw) {
    await raw.transaction.deleteMany({ where: { householdId: { in: householdIds } } });
    await raw.resourceWindow.deleteMany({ where: { kind: "export", OR: [
      { scope: "household", subjectId: { in: householdIds } },
      { scope: "member", subjectId: { in: memberIds } },
    ] } });
    await raw.household.deleteMany({ where: { id: { in: householdIds } } });
    await raw.user.deleteMany({ where: { id: { in: userIds } } });
    await raw.category.deleteMany({ where: { id: { in: categoryIds } } });
    await raw.$disconnect();
  }
  await db?.$disconnect();
  if (state.directory) {
    const directory = path.resolve(state.directory);
    if (path.dirname(directory) !== path.resolve(state.parentDirectory) || !path.basename(directory).startsWith("billboard-encrypted-export-capacity-")) {
      throw new Error("Refusing to remove an unowned export capacity directory");
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
}, 30_000);

async function fixture(): Promise<Fixture> {
  const suffix = randomUUID();
  const household = await raw.household.create({ data: { name: "Encrypted export capacity fixture" } });
  householdIds.push(household.id);
  const owner = await raw.user.create({ data: { email: `export-capacity-owner-${suffix}@example.test`, displayName: "U", passwordHash: "not-used" } });
  userIds.push(owner.id);
  const former = await raw.user.create({ data: { email: `export-capacity-former-${suffix}@example.test`, displayName: "H", passwordHash: "not-used" } });
  userIds.push(former.id);
  const member = await raw.householdMember.create({ data: { householdId: household.id, userId: owner.id, memberName: "U", role: "OWNER" } });
  memberIds.push(member.id);
  const historical = await raw.householdMember.create({ data: { householdId: household.id, userId: former.id, memberName: "H", role: "MEMBER", leftAt: new Date("2026-09-01T00:00:00Z") } });
  memberIds.push(historical.id);
  const appSession = await raw.appSession.create({ data: { userId: owner.id, memberId: member.id, sessionKey: randomUUID(), expiresAt: new Date(Date.now() + 900_000) } });
  const expenseName = `CapacityE-${suffix.slice(0, 8)}`;
  const incomeName = `CapacityI-${suffix.slice(0, 8)}`;
  const expense = await raw.category.create({ data: { name: expenseName, type: "EXPENSE", sortOrder: 0 } });
  categoryIds.push(expense.id);
  const income = await raw.category.create({ data: { name: incomeName, type: "INCOME", sortOrder: 0 } });
  categoryIds.push(income.id);
  const code = createHouseholdCode(household.id);
  const ring = createKeyRing(code);
  await raw.householdEncryption.create({ data: {
    householdId: household.id, mode: "ENCRYPTED", revision: 1,
    generation: ring.generation, keyVersion: ring.currentKeyVersion, sealedKeyRing: await sealKeyRing(code, ring),
  } });
  const ledgerId = randomUUID();
  const archivedLedgerId = randomUUID();
  for (const [id, name, archivedAt] of [[ledgerId, "L", null], [archivedLedgerId, "A", timestamp]] as const) {
    const encrypted = await encryptRow("ledger", {
      id, householdId: household.id, name, isDefault: id === ledgerId,
      acceptsLegacyDrafts: false, archivedAt, createdAt: timestamp, updatedAt: timestamp,
    }, ring, household.id, expense.id);
    await raw.ledger.create({ data: encrypted as Prisma.LedgerUncheckedCreateInput });
  }
  return {
    session: { id: owner.id, householdId: household.id, memberId: member.id, appSessionId: appSession.id, role: "OWNER" },
    ledgerId, archivedLedgerId, historicalMemberId: historical.id,
    expenseId: expense.id, incomeId: income.id, expenseName, incomeName, ring,
  };
}

function amountAt(index: number) { return index === visibleRows - 1 ? 2_147_483_647 : index + 1; }
function noteAt(index: number) { return `CAP-${String(index).padStart(6, "0")}`; }
function occurredAt(index: number) { return index === 0 ? input.range.from : index === 1 ? input.range.to : timestamp; }

function transaction(f: Fixture, index: number): Prisma.TransactionUncheckedCreateInput {
  const imported = index % 5 === 0;
  return {
    id: randomUUID(), householdId: f.session.householdId,
    ledgerId: index % 3 === 0 ? f.archivedLedgerId : f.ledgerId,
    actorMemberId: index % 4 === 0 ? f.historicalMemberId : f.session.memberId,
    createdByMemberId: index % 7 === 0 ? f.historicalMemberId : f.session.memberId,
    clientRequestId: null, categoryId: index % 2 === 0 ? f.expenseId : f.incomeId,
    type: index % 2 === 0 ? "EXPENSE" : "INCOME", amountFen: amountAt(index),
    occurredAt: occurredAt(index), note: noteAt(index),
    source: imported ? "wechat_pay" : null,
    sourceFingerprint: imported ? `PRIVATE-FINGERPRINT-${index}` : null,
    sourceImportedAt: imported ? timestamp : null, createdAt: timestamp, updatedAt: timestamp, deletedAt: null,
  };
}

async function insertEncrypted(f: Fixture, originals: Prisma.TransactionUncheckedCreateInput[]) {
  const encrypted: Prisma.TransactionCreateManyInput[] = [];
  for (let offset = 0; offset < originals.length; offset += encryptionConcurrency) {
    encrypted.push(...await Promise.all(originals.slice(offset, offset + encryptionConcurrency).map(async (original) =>
      await encryptRow("transaction", original, f.ring, f.session.householdId, f.expenseId) as Prisma.TransactionCreateManyInput,
    )));
  }
  await raw.transaction.createMany({ data: encrypted });
}

async function inFixture<T>(f: Fixture, work: () => Promise<T>) {
  return runEncryptionContext({
    session: f.session, mode: "ENCRYPTED", configMode: "ENCRYPTED", revision: 1,
    ring: structuredClone(f.ring), expiresAt: Date.now() + 180_000, disposed: false, readOnly: false,
  }, work);
}

async function temporaryFiles() {
  const root = path.join(state.directory, "billboard-record-exports");
  const directories = await fs.readdir(root);
  const files: string[] = [];
  for (const directory of directories) for (const file of await fs.readdir(path.join(root, directory))) {
    files.push(path.join(root, directory, file));
  }
  return files;
}

async function verifyWorkbook(bytes: Buffer, f: Fixture) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes);
  expect(workbook.worksheets).toHaveLength(1);
  const sheet = workbook.worksheets[0];
  expect(sheet.rowCount).toBe(visibleRows + 1);
  expect(sheet.actualColumnCount).toBe(10);
  const messages = getMessages("zh-CN");
  const labels = messages.safeguards.exports;
  const seen = new Uint8Array(visibleRows);
  let totalFen = 0;
  let archivedCount = 0;
  let historicalCount = 0;
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber++) {
    const row = sheet.getRow(rowNumber);
    const note = row.getCell(9).value;
    if (typeof note !== "string" || !/^CAP-\d{6}$/.test(note)) throw new Error(`Unexpected export note at row ${rowNumber}`);
    const index = Number(note.slice(4));
    if (index >= visibleRows || seen[index]) throw new Error(`Duplicate or invalid export row index ${index}`);
    seen[index] = 1;
    const amount = amountAt(index);
    const yuan = `${Math.floor(amount / 100)}.${String(amount % 100).padStart(2, "0")}`;
    const archived = index % 3 === 0;
    const historical = index % 4 === 0;
    const expected = [
      archived ? `A · ${messages.ledgers.archived}` : "L",
      historical ? `H${messages.common.formerMember}` : "U",
      index % 7 === 0 ? `H${messages.common.formerMember}` : "U",
      index % 2 === 0 ? labels.expense : labels.income,
      index % 2 === 0 ? f.expenseName : f.incomeName,
      yuan, amount,
      index === 0 ? "2026-10-01 00:00:00.000" : index === 1 ? "2026-10-31 23:59:59.999" : "2026-10-15 12:00:00.123",
      noteAt(index), index % 5 === 0 ? "wechat_pay" : labels.manual,
    ];
    for (let column = 1; column <= expected.length; column++) {
      if (row.getCell(column).value !== expected[column - 1]) throw new Error(`Export mismatch at record ${index}, column ${column}`);
    }
    totalFen += amount;
    if (archived) archivedCount++;
    if (historical) historicalCount++;
  }
  expect(seen.reduce((sum, value) => sum + value, 0)).toBe(visibleRows);
  expect(totalFen).toBe((visibleRows - 1) * visibleRows / 2 + 2_147_483_647);
  expect(archivedCount).toBe(33_334);
  expect(historicalCount).toBe(25_000);
}

it("exports 100000 authenticated encrypted records within existing limits and rejects the next visible record", async () => {
  expect(MAX_RECORD_EXPORT_ROWS).toBe(visibleRows);
  expect(MAX_RECORD_EXPORT_BYTES).toBe(32 * 1024 * 1024);
  const peaks: Partial<Record<Stage, Memory>> = {};
  let stage: Stage = "seed";
  const sample = () => {
    const current = process.memoryUsage();
    const previous = peaks[stage];
    peaks[stage] = {
      rss: Math.max(previous?.rss ?? 0, current.rss), heapUsed: Math.max(previous?.heapUsed ?? 0, current.heapUsed),
      external: Math.max(previous?.external ?? 0, current.external), arrayBuffers: Math.max(previous?.arrayBuffers ?? 0, current.arrayBuffers),
    };
  };
  const baseline = process.memoryUsage();
  const sampler = setInterval(sample, 100);
  const durations: Partial<Record<Stage, number>> = {};
  let plaintextBytes = 0;
  let encryptedBytes = 0;
  const started = performance.now();
  sample();
  try {
    const f = await fixture();
    for (let offset = 0; offset < visibleRows; offset += batchSize) {
      await insertEncrypted(f, Array.from({ length: Math.min(batchSize, visibleRows - offset) }, (_, index) => transaction(f, offset + index)));
      if ((offset + batchSize) % 25_000 === 0) console.info("Encrypted export capacity seed", { rows: offset + batchSize, elapsedMs: Math.round(performance.now() - started) });
    }
    await insertEncrypted(f, [
      { ...transaction(f, 1), note: "EXCLUDED_SOFT_DELETE", deletedAt: timestamp },
      { ...transaction(f, 1), note: "EXCLUDED_BEFORE_SHANGHAI_RANGE", occurredAt: new Date(input.range.from.getTime() - 1) },
      { ...transaction(f, 1), note: "EXCLUDED_AFTER_SHANGHAI_RANGE", occurredAt: new Date(input.range.to.getTime() + 1) },
    ]);
    expect(await raw.transaction.count({ where: { householdId: f.session.householdId, encryptedPayload: { not: null } } })).toBe(visibleRows + 3);
    durations.seed = Math.round(performance.now() - started);
    sample();
    const bytes = await inFixture(f, async () => {
      stage = "generate";
      const generationStarted = performance.now();
      const artifact = await generateRecordExport(f.session, input);
      artifacts.push(artifact);
      durations.generate = Math.round(performance.now() - generationStarted);
      sample();
      expect(durations.generate).toBeLessThan(generationLimitMs);
      expect(artifact.rowCount).toBe(visibleRows);
      const files = await temporaryFiles();
      expect(files).toHaveLength(1);
      const ciphertext = await fs.readFile(files[0]);
      encryptedBytes = ciphertext.length;
      expect(ciphertext.subarray(0, 6).toString()).toBe("BBEF1\n");
      expect(ciphertext.subarray(0, 2).toString()).not.toBe("PK");
      expect(ciphertext.includes(Buffer.from("xl/worksheets/sheet1.xml"))).toBe(false);
      expect(ciphertext.includes(Buffer.from(noteAt(0)))).toBe(false);
      stage = "download";
      const downloadStarted = performance.now();
      const download = await artifact.claim(f.session);
      const opened = Buffer.from(await new Response(download.body).arrayBuffer());
      durations.download = Math.round(performance.now() - downloadStarted);
      plaintextBytes = opened.length;
      expect(plaintextBytes).toBe(download.byteLength);
      expect(plaintextBytes).toBeLessThanOrEqual(MAX_RECORD_EXPORT_BYTES);
      expect(encryptedBytes).toBe(plaintextBytes + ENCRYPTED_EXPORT_OVERHEAD);
      expect(opened.subarray(0, 2).toString()).toBe("PK");
      expect(await temporaryFiles()).toEqual([]);
      expect(await raw.resourceLease.count({ where: { kind: "export", householdId: f.session.householdId } })).toBe(0);
      sample();
      return opened;
    });
    stage = "parse";
    const parseStarted = performance.now();
    await verifyWorkbook(bytes, f);
    durations.parse = Math.round(performance.now() - parseStarted);
    sample();
    await insertEncrypted(f, [{ ...transaction(f, visibleRows), note: "EXCEEDS_100000_VISIBLE_ROWS" }]);
    stage = "tooLarge";
    const rejectionStarted = performance.now();
    await inFixture(f, async () => {
      await expect(generateRecordExport(f.session, input)).rejects.toMatchObject({ code: "too_large" });
    });
    durations.tooLarge = Math.round(performance.now() - rejectionStarted);
    expect(durations.tooLarge).toBeLessThan(generationLimitMs);
    expect(await temporaryFiles()).toEqual([]);
    expect(await raw.resourceLease.count({ where: { kind: "export", householdId: f.session.householdId } })).toBe(0);
    sample();
  } finally {
    clearInterval(sampler);
    sample();
    const toMiB = (value: number) => Math.round(value / 1024 / 1024 * 100) / 100;
    process.stderr.write(`Encrypted export capacity evidence ${JSON.stringify({
      visibleRows, batchSize, encryptionConcurrency, plaintextBytes, encryptedBytes,
      durationsMs: durations, baselineRssMiB: toMiB(baseline.rss), baselineHeapMiB: toMiB(baseline.heapUsed),
      sampledPeakMiB: Object.fromEntries(Object.entries(peaks).map(([key, value]) => [key, Object.fromEntries(Object.entries(value).map(([field, amount]) => [field, toMiB(amount)]))])),
    })}\n`);
  }
}, 600_000);
