import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { Uint8ArrayReader, TextWriter, ZipReader } from "@zip.js/zip.js";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { parseRecordExportInput } from "@/lib/exports/input";
import { MAX_RECORD_EXPORT_ROWS, writeRecordExportWorkbook, type RecordExportRow } from "@/lib/exports/workbook";
import { createRecordExportFile, RECORD_EXPORT_TTL_MS, startRecordExportCleanup } from "@/lib/exports/temp-file";

const state = vi.hoisted(() => ({ directory: "", unlinkFailure: "" }));
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

let directory: string;
beforeAll(async () => { directory = await fs.mkdtemp(path.join(tmpdir(), "billboard-export-test-")); state.directory = directory; });
afterAll(async () => { await fs.rm(directory, { recursive: true, force: true }); });
afterEach(async () => {
  state.unlinkFailure = "";
  await (await startRecordExportCleanup())();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

const row: RecordExportRow = {
  ledgerName: "Default", ledgerArchived: false,
  actorMemberName: "Former member", actorMemberInactive: true,
  createdByMemberName: "Current member", createdByMemberInactive: false,
  type: "EXPENSE", categoryName: "Dining", amountFen: 101,
  occurredAt: new Date("2026-10-20T16:00:00.123Z"), note: "Dinner", source: null,
};

async function workbook(rows: RecordExportRow[], locale: "zh-CN" | "en-US" = "zh-CN") {
  const filename = path.join(directory, `${randomUUID()}.xlsx`);
  async function* input() { yield* rows; }
  await writeRecordExportWorkbook(filename, input(), locale);
  const bytes = await fs.readFile(filename);
  const parsed = new ExcelJS.Workbook();
  await parsed.xlsx.load(bytes);
  return { parsed, bytes, filename };
}

describe("private accounting export", () => {
  it("validates exact Shanghai dates and rejects client identity or an invalid range", () => {
    const value = parseRecordExportInput({ from: "2026-10-01", to: "2026-10-31", locale: "zh-CN" });
    expect(value.range.from.toISOString()).toBe("2026-09-30T16:00:00.000Z");
    expect(value.range.to.toISOString()).toBe("2026-10-31T15:59:59.999Z");
    for (const extra of [
      { from: "2026-02-29" }, { from: "2026-11-01" }, { to: "2026-10-31T00:00:00Z" },
      { householdId: "foreign" }, { memberId: "foreign" }, { ledgerId: "" }, { locale: "en" },
    ]) expect(() => parseRecordExportInput({ from: "2026-10-01", to: "2026-10-31", locale: "zh-CN", ...extra })).toThrow();
  });

  it("accepts an explicit actor identity while rejecting an empty or overlong member filter", () => {
    const base = { from: "2026-10-01", to: "2026-10-31", locale: "zh-CN" };
    expect(parseRecordExportInput({ ...base, actorMemberId: "historical-member" }).actorMemberId).toBe("historical-member");
    for (const actorMemberId of ["", " ", "x".repeat(129)]) {
      expect(() => parseRecordExportInput({ ...base, actorMemberId })).toThrow();
    }
  });

  it("round-trips every integer fen without floating conversion and uses exact Shanghai timestamps", async () => {
    const { parsed } = await workbook([1, 101, 2_147_483_647].map((amountFen) => ({ ...row, amountFen })));
    const sheet = parsed.worksheets[0];
    expect(sheet.getRow(1).values).toEqual([undefined, "账本", "归属成员", "记录成员", "收支方向", "分类", "金额（元）", "金额（分）", "发生时间（Asia/Shanghai）", "备注", "来源"]);
    expect([2, 3, 4].map((index) => sheet.getRow(index).getCell(6).value)).toEqual(["0.01", "1.01", "21474836.47"]);
    expect([2, 3, 4].map((index) => sheet.getRow(index).getCell(7).value)).toEqual([1, 101, 2_147_483_647]);
    expect(sheet.getRow(2).getCell(8).value).toBe("2026-10-21 00:00:00.123");
    expect(sheet.getRow(2).getCell(2).text).toContain("Former member");
  });

  it("writes hostile names, notes and URLs as literal text without formulas or external relationships", async () => {
    const payloads = ["=HYPERLINK(\"https://example.test\",\"x\")", "+SUM(1,2)", "-1+1", "@SUM(A1)", "\t=1+1", "https://example.test/secret"];
    const { parsed, bytes } = await workbook(payloads.map((note) => ({ ...row, ledgerName: note, actorMemberName: note, note })));
    const sheet = parsed.worksheets[0];
    payloads.forEach((note, index) => {
      for (const column of [1, 2, 9]) {
        const cell = sheet.getRow(index + 2).getCell(column);
        expect(cell.type).toBe(ExcelJS.ValueType.String);
        expect(cell.value).toEqual(expect.stringContaining(note));
      }
    });
    const zip = new ZipReader(new Uint8ArrayReader(bytes), { useWebWorkers: false });
    try {
      for (const entry of await zip.getEntries()) {
        expect(entry.filename).not.toContain("externalLink");
        if (!entry.directory && /\.(?:xml|rels)$/.test(entry.filename)) {
          const xml = await entry.getData!(new TextWriter());
          expect(xml).not.toMatch(/<f(?:\s|>)/);
          expect(xml).not.toContain('TargetMode="External"');
        }
      }
    } finally { await zip.close(); }
  });

  it("exports only the financial field whitelist and supports the English workbook", async () => {
    const hidden = { email: "private-account@example.test", sourceFingerprint: "private-fingerprint", rawRow: "private-source-row", passwordHash: "private-hash" };
    const { parsed, bytes } = await workbook([{ ...row, ...hidden, ledgerArchived: true, source: "wechat_pay" }], "en-US");
    const sheet = parsed.worksheets[0];
    expect(sheet.name).toBe("Records");
    expect(sheet.columnCount).toBe(10);
    expect(sheet.getRow(2).getCell(1).text).toContain("Archived");
    expect(sheet.getRow(2).getCell(4).value).toBe("Expense");
    const zip = new ZipReader(new Uint8ArrayReader(bytes), { useWebWorkers: false });
    try {
      const contents = (await Promise.all((await zip.getEntries()).map((entry) => entry.directory || !entry.filename.endsWith(".xml") ? "" : entry.getData!(new TextWriter())))).join("\n");
      for (const value of Object.values(hidden)) expect(contents).not.toContain(value);
    } finally { await zip.close(); }
  });

  it("stops a cancelled export and does not silently truncate invalid Excel text or money", async () => {
    const controller = new AbortController();
    controller.abort();
    const filename = path.join(directory, `${randomUUID()}.xlsx`);
    async function* input() { yield row; }
    await expect(writeRecordExportWorkbook(filename, input(), "zh-CN", { signal: controller.signal })).rejects.toMatchObject({ code: "cancelled" });
    await expect(workbook([{ ...row, note: "x".repeat(32_768) }])).rejects.toMatchObject({ code: "too_large" });
    await expect(workbook([{ ...row, amountFen: 1.1 }])).rejects.toMatchObject({ code: "unavailable" });
  });

  it("cleans only expired owned temporary files and preserves unrelated or fresh paths", async () => {
    const root = path.join(directory, "billboard-record-exports");
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const old = path.join(root, `export-${Date.now() - RECORD_EXPORT_TTL_MS - 1000}-older1`);
    const fresh = path.join(root, `export-${Date.now()}-fresh1`);
    const unknown = path.join(root, "unrelated-directory");
    for (const folder of [old, fresh, unknown]) await fs.mkdir(folder, { mode: 0o700 });
    for (const folder of [old, fresh, unknown]) await fs.writeFile(path.join(folder, "records.xlsx"), "fixture");
    const artifact = await createRecordExportFile();
    await writeRecordExportWorkbook(artifact.filename, (async function* () { yield row; })(), "zh-CN");
    await expect(fs.access(old)).rejects.toThrow();
    await expect(fs.readFile(path.join(fresh, "records.xlsx"), "utf8")).resolves.toBe("fixture");
    await expect(fs.readFile(path.join(unknown, "records.xlsx"), "utf8")).resolves.toBe("fixture");
    expect(path.resolve(artifact.filename).startsWith(`${path.resolve(root)}${path.sep}`)).toBe(true);
    if (process.platform !== "win32") {
      expect((await fs.stat(path.dirname(artifact.filename))).mode & 0o777).toBe(0o700);
      expect((await fs.stat(artifact.filename)).mode & 0o777).toBe(0o600);
    }
    await artifact.dispose();
    await artifact.dispose();
    await expect(fs.access(artifact.filename)).rejects.toThrow();
  });

  it("cleans an expired artifact without another export after its owner has stopped", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const artifact = await createRecordExportFile();
    await fs.writeFile(artifact.filename, "private financial fixture", { mode: 0o600 });
    state.unlinkFailure = artifact.filename;
    await expect(artifact.dispose()).rejects.toMatchObject({ code: "EPERM" });
    state.unlinkFailure = "";
    vi.setSystemTime(Date.now() + RECORD_EXPORT_TTL_MS);
    await vi.advanceTimersByTimeAsync(10_001);
    await vi.waitFor(async () => { await expect(fs.access(artifact.filename)).rejects.toThrow(); });
    await artifact.dispose();
  });

  it("cleans crash leftovers at server startup without creating another export", async () => {
    const root = path.join(directory, "billboard-record-exports");
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const orphan = await fs.mkdtemp(path.join(root, `export-${Date.now() - RECORD_EXPORT_TTL_MS - 1000}-`));
    await fs.chmod(orphan, 0o700);
    await fs.writeFile(path.join(orphan, "records.xlsx"), "crashed financial fixture", { mode: 0o600 });
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    const { register } = await import("@/instrumentation");
    await register();
    await expect(fs.access(orphan)).rejects.toThrow();
  });

  it("preserves an active writer and does not follow an owned-name directory junction", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const artifact = await createRecordExportFile();
    await fs.writeFile(artifact.filename, "active financial fixture", { mode: 0o600 });
    await (await startRecordExportCleanup())();
    const target = await fs.mkdtemp(path.join(directory, "unrelated-private-"));
    await fs.writeFile(path.join(target, "records.xlsx"), "unrelated financial fixture", { mode: 0o600 });
    const junction = path.join(directory, "billboard-record-exports", `export-${Date.now()}-linked`);
    await fs.symlink(target, junction, process.platform === "win32" ? "junction" : "dir");
    vi.setSystemTime(Date.now() + RECORD_EXPORT_TTL_MS + 1);
    await startRecordExportCleanup();
    await expect(fs.readFile(artifact.filename, "utf8")).resolves.toBe("active financial fixture");
    await expect(fs.readFile(path.join(target, "records.xlsx"), "utf8")).resolves.toBe("unrelated financial fixture");
    expect((await fs.lstat(junction)).isSymbolicLink()).toBe(true);
    await artifact.dispose();
    await fs.unlink(junction);
  });

  it("continues bounded cleanup beyond fresh or unrelated entries without starving later orphans", async () => {
    const interval = globalThis.setInterval;
    vi.spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void) => interval(callback, 1)) as typeof setInterval);
    const root = path.join(directory, "billboard-record-exports");
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    for (let index = 0; index < 70; index++) await fs.mkdir(path.join(root, `unrelated-${index}`), { mode: 0o700 });
    const orphans: string[] = [];
    for (let index = 0; index < 130; index++) {
      const orphan = await fs.mkdtemp(path.join(root, `export-${Date.now() - RECORD_EXPORT_TTL_MS - 1000}-`));
      await fs.chmod(orphan, 0o700);
      await fs.writeFile(path.join(orphan, "records.xlsx"), "crashed financial fixture", { mode: 0o600 });
      orphans.push(orphan);
    }
    await startRecordExportCleanup();
    await vi.waitFor(async () => {
      for (const orphan of orphans) await expect(fs.access(orphan)).rejects.toThrow();
    }, { timeout: 3000 });
    await expect(fs.access(path.join(root, "unrelated-69"))).resolves.toBeUndefined();
  });

  it("bounds total rows and closes the writer when a large export reaches the limit", async () => {
    const filename = path.join(directory, `${randomUUID()}.xlsx`);
    let produced = 0;
    async function* rows() {
      for (let index = 0; index < MAX_RECORD_EXPORT_ROWS + 10; index++) { produced++; yield row; }
    }
    await expect(writeRecordExportWorkbook(filename, rows(), "zh-CN")).rejects.toMatchObject({ code: "too_large" });
    expect(produced).toBe(MAX_RECORD_EXPORT_ROWS + 1);
    await fs.unlink(filename);
  }, 30_000);
});
