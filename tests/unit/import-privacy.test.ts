import { TransactionType } from "@prisma/client";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import ExcelJS from "exceljs";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { parseAlipayCsv } from "@/lib/imports/sources/alipay";
import { parseCmbPdf } from "@/lib/imports/sources/cmb";
import { parseCmbZip } from "@/lib/imports/sources/cmb-zip";
import { parseSuiShouJiWorkbook } from "@/lib/imports/sources/sui-shou-ji";
import { parseWechatPayWorkbook } from "@/lib/imports/sources/wechat-pay";

async function workbookBuffer(sheets: Record<string, unknown[][]>) {
  const workbook = new ExcelJS.Workbook();

  for (const [sheetName, rows] of Object.entries(sheets)) {
    workbook.addWorksheet(sheetName).addRows(rows);
  }

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

describe("import privacy", () => {
  it("does not expose raw Sui Shou Ji remarks, account, or merchant values in parsed notes", async () => {
    const buffer = await workbookBuffer({
      支出: [
        ["交易类型", "日期", "一级分类", "二级分类", "账户1", "账户币种", "金额", "成员", "商家", "记账人", "备注"],
        ["支出", "2026-05-06 13:23:02", "餐饮", "三餐", "示例账户", "CNY", "176", "老婆", "示例商户", "老婆", "示例备注"],
      ],
    });

    const result = await parseSuiShouJiWorkbook(buffer);

    expect(result.rows[0]).toMatchObject({
      mappingKey: "sui_shou_ji|EXPENSE|餐饮|三餐",
      note: null,
      transactionType: TransactionType.EXPENSE,
    });
  });

  it("limits WeChat Pay parsed notes to counterparty and product", async () => {
    const buffer = await workbookBuffer({
      Sheet1: [
        ["微信支付账单明细"],
        ["微信昵称：[老公]"],
        [],
        ["----------------------微信支付账单明细列表--------------------"],
        ["交易时间", "交易类型", "交易对方", "商品", "收/支", "金额(元)", "支付方式", "当前状态", "交易单号", "商户单号", "备注"],
        [
          "2026-05-02 17:22:40",
          "扫二维码付款",
          "示例商户",
          "示例商品",
          "支出",
          "30",
          "示例支付方式",
          "支付成功",
          "wechat-order-example",
          "wechat-merchant-order-example",
          "示例备注",
        ],
      ],
    });

    const result = await parseWechatPayWorkbook(buffer);

    expect(result.rows[0]).toMatchObject({
      mappingKey: "wechat_pay|EXPENSE|扫二维码付款|示例商户",
      note: "交易对方：示例商户；商品：示例商品",
      transactionType: TransactionType.EXPENSE,
    });
    expect(result.rows[0]?.note).not.toContain("示例支付方式");
    expect(result.rows[0]?.note).not.toContain("wechat-order-example");
    expect(result.rows[0]?.note).not.toContain("示例备注");
  });

  it("limits Alipay parsed notes to counterparty and product", async () => {
    const csv = [
      "导出信息：",
      "姓名：老公",
      "支付宝账户：example-alipay-account",
      ["交易时间", "交易分类", "交易对方", "对方账号", "商品说明", "收/支", "金额", "收/付款方式", "交易状态", "交易订单号", "商家订单号", "备注", ""].join(","),
      [
        "2026-05-07 12:17:13",
        "餐饮美食",
        "示例商户",
        "/",
        "示例商品",
        "支出",
        "22.85",
        "示例支付方式",
        "交易成功",
        "alipay-order-example",
        "alipay-merchant-order-example",
        "示例备注",
        "",
      ].join(","),
    ].join("\n");

    const result = await parseAlipayCsv(Buffer.from(csv, "utf8"));

    expect(result.rows[0]).toMatchObject({
      mappingKey: "alipay|EXPENSE|餐饮美食|",
      note: "交易对方：示例商户；商品：示例商品",
      transactionType: TransactionType.EXPENSE,
    });
    expect(result.rows[0]?.note).not.toContain("示例支付方式");
    expect(result.rows[0]?.note).not.toContain("alipay-order-example");
    expect(result.rows[0]?.note).not.toContain("示例备注");
  });

  it("keeps only the approved CMB summary and counterparty in parsed notes", async () => {
    const buffer = readFileSync(
      path.join(
        process.cwd(),
        "tests",
        "fixtures",
        "imports",
        "cmb",
        "statement-single-page.pdf",
      ),
    );
    const result = await parseCmbPdf(buffer);

    expect(result.rows[0]?.note).toBe(
      "招商银行：快捷支付；对手信息：示例商户 示例门店",
    );
    expect(result.rows[0]?.note).not.toContain("6214");
    expect(result.rows[0]?.note).not.toContain("8,765.44");
    expect(result.rows[0]?.note).not.toContain("EXAMPLE1");
  });

  it("keeps the same CMB note privacy boundary through the ZIP path", async () => {
    const buffer = readFileSync(
      path.join(
        process.cwd(),
        "tests",
        "fixtures",
        "imports",
        "cmb",
        "statement-single-page.pdf",
      ),
    );
    const writer = new Uint8ArrayWriter();
    const zipWriter = new ZipWriter(writer, {
      password: "privacy-password",
      useWebWorkers: false,
      zipCrypto: true,
    });
    await zipWriter.add("statement.pdf", new Uint8ArrayReader(buffer));

    const result = await parseCmbZip(
      Buffer.from(await zipWriter.close()),
      "privacy-password",
    );

    expect(result.rows[0]?.note).toBe(
      "招商银行：快捷支付；对手信息：示例商户 示例门店",
    );
    expect(result.rows[0]?.note).not.toContain("privacy-password");
    expect(result.rows[0]?.note).not.toContain("6214");
    expect(result.rows[0]?.note).not.toContain("8,765.44");
  });
});
