import ExcelJS from "exceljs";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader, ZipWriter } from "@zip.js/zip.js";
import { describe, expect, it } from "vitest";

import { parseSuiShouJiWorkbook } from "@/lib/imports/sources/sui-shou-ji";
import { parseWechatPayWorkbook } from "@/lib/imports/sources/wechat-pay";

async function workbookWithLargeUnusedEntry() {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet("支出").addRow([
    "交易类型", "日期", "一级分类", "二级分类", "账户币种", "金额", "成员", "记账人", "备注",
  ]);
  workbook.addWorksheet("微信").addRow([
    "交易时间", "交易类型", "交易对方", "商品", "收/支", "金额(元)", "支付方式",
    "当前状态", "交易单号", "商户单号", "备注",
  ]);
  const original = await workbook.xlsx.writeBuffer();
  const reader = new ZipReader(new Uint8ArrayReader(new Uint8Array(original)), { useWebWorkers: false });
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
  for (const entry of await reader.getEntries()) {
    if (!entry.directory) {
      await writer.add(entry.filename, new Uint8ArrayReader(await entry.getData!(new Uint8ArrayWriter())));
    }
  }
  await reader.close();
  await writer.add("xl/media/unused.bin", new Uint8ArrayReader(new Uint8Array(33 * 1024 * 1024)));
  return Buffer.from(await writer.close());
}

describe("XLSX resource limits", () => {
  it("rejects oversized expanded data even in an unused ZIP entry for both XLSX sources", async () => {
    const buffer = await workbookWithLargeUnusedEntry();
    expect(buffer.length).toBeLessThan(100_000);
    await expect(parseSuiShouJiWorkbook(buffer)).rejects.toThrow("xlsx-resource-limit");
    await expect(parseWechatPayWorkbook(buffer)).rejects.toThrow("xlsx-resource-limit");
  }, 20_000);

  it("rejects actual expanded bytes even when the ZIP directory claims a small size", async () => {
    const buffer = await workbookWithLargeUnusedEntry();
    for (let index = 0; index < buffer.length - 46; index += 1) {
      if (buffer.readUInt32LE(index) !== 0x02014b50) continue;
      const nameLength = buffer.readUInt16LE(index + 28);
      if (buffer.subarray(index + 46, index + 46 + nameLength).toString() === "xl/media/unused.bin") {
        buffer.writeUInt32LE(1, index + 24);
        break;
      }
    }
    await expect(parseWechatPayWorkbook(buffer)).rejects.toThrow(/xlsx-resource-limit|unreadable-xlsx-file/);
  }, 20_000);

  it("bounds the total inflated archive and entry count", async () => {
    const oversized = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
    for (let index = 0; index < 3; index += 1) {
      await oversized.add(`${index}.bin`, new Uint8ArrayReader(new Uint8Array(22 * 1024 * 1024)));
    }
    await expect(parseWechatPayWorkbook(Buffer.from(await oversized.close()))).rejects.toThrow("xlsx-resource-limit");
    const crowded = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
    for (let index = 0; index < 2049; index += 1) {
      await crowded.add(`${index}.bin`, new Uint8ArrayReader(new Uint8Array()));
    }
    await expect(parseWechatPayWorkbook(Buffer.from(await crowded.close()))).rejects.toThrow("xlsx-resource-limit");
  }, 20_000);

  it("does not trust conflicting directory flags to bypass expansion limits", async () => {
    const buffer = await workbookWithLargeUnusedEntry();
    for (let index = 0; index < buffer.length - 46; index += 1) {
      if (buffer.readUInt32LE(index) !== 0x02014b50) continue;
      const nameLength = buffer.readUInt16LE(index + 28);
      if (buffer.subarray(index + 46, index + 46 + nameLength).toString() === "xl/media/unused.bin") {
        buffer.writeUInt16LE(20, index + 4);
        buffer.writeUInt32LE(0x40000000, index + 38);
        break;
      }
    }
    await expect(parseWechatPayWorkbook(buffer)).rejects.toThrow("xlsx-resource-limit");
  }, 20_000);

  it("still reads a normal 20,000-row bill at the supported row limit", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("支出");
    sheet.addRow(["交易类型", "日期", "一级分类", "二级分类", "账户币种", "金额", "成员", "记账人", "备注"]);
    for (let index = 0; index < 20_000; index += 1) {
      sheet.addRow(["支出", "2026-05-02 12:00:00", "餐饮", "三餐", "CNY", "1.20", "老公", "老公", `row ${index}`]);
    }
    const result = await parseSuiShouJiWorkbook(Buffer.from(await workbook.xlsx.writeBuffer()));
    expect(result.rows).toHaveLength(20_000);
    expect(result.invalidRows).toEqual([]);
    expect(result.rows[19_999].amountFen).toBe(120);
  }, 30_000);
});
