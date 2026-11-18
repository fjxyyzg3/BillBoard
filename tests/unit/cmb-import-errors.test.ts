import { TransactionType } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const pdfMock = vi.hoisted(() => ({
  document: null as FakeDocument | null,
  error: null as Error | null,
  destroy: vi.fn(async () => undefined),
}));

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument: () => ({
    destroy: pdfMock.destroy,
    promise: pdfMock.error
      ? Promise.reject(pdfMock.error)
      : Promise.resolve(pdfMock.document),
  }),
}));

import { parseCmbPdf } from "@/lib/imports/sources/cmb";

type FakeTextItem = {
  str: string;
  transform: number[];
  width: number;
};

type FakePage = {
  getTextContent(): Promise<{ items: FakeTextItem[] }>;
  getViewport(): { height: number; width: number };
};

type FakeDocument = {
  getPage(pageNumber: number): Promise<FakePage>;
  numPages: number;
};

const headerX = [36, 100, 157, 235, 309, 418] as const;
const headers = ["记账日期", "货币", "交易金额", "联机余额", "交易摘要", "对手信息"] as const;

function text(str: string, x: number, y: number): FakeTextItem {
  return { str, transform: [1, 0, 0, 1, x, y], width: Math.max(str.length * 5, 5) };
}

function statementPage(input: {
  account?: string;
  amount?: string;
  amountX?: number;
  balanceX?: number;
  counterparty?: string;
  date?: string;
  headerShift?: number;
  headerY?: number;
  includeIdentity?: boolean;
  includeTitle?: boolean;
  officialDecorations?: boolean;
  owner?: string;
  rowItems?: FakeTextItem[];
  rowY?: number;
  summary?: string;
  summaryX?: number;
} = {}): FakePage {
  const owner = input.owner ?? "示例户名";
  const account = input.account ?? "6214********0000";
  const headerY = input.headerY ?? 624;
  const rowY = input.rowY ?? 581;
  const items = [
    ...(input.includeTitle === false ? [] : [text("招商银行交易流水", 250, 788)]),
    ...(input.includeIdentity === false
      ? []
      : [text(`户名：${owner} 账号：${account}`, 36, 716)]),
    ...headers.map((header, index) =>
      text(header, headerX[index] + (index === 2 ? (input.headerShift ?? 0) : 0), headerY),
    ),
  ];

  if (input.officialDecorations) {
    items.push(
      text("Date", 36, headerY - 21),
      text("Currency", 100, headerY - 21),
      text("Balance", 235, headerY - 21),
      text("Transaction Type", 309, headerY - 21),
      text("Counter Party", 418, headerY - 21),
      text("Amount", 170, headerY - 27),
    );
  }

  items.push(
    ...(input.rowItems ?? [
      text(input.date ?? "2026-07-04", 36, rowY),
      text("CNY", 100, rowY),
      text(input.amount ?? "-1,234.56", input.amountX ?? 190, rowY),
      text("8,765.44", input.balanceX ?? 260, rowY),
      text(input.summary ?? "快捷支付", input.summaryX ?? 309, rowY),
      text(input.counterparty ?? "示例商户", 418, rowY),
    ]),
  );

  if (input.officialDecorations) {
    items.push(
      text("Example footer copy one", 35, 80),
      text("Example footer copy two", 35, 70),
      text("Example footer copy three", 35, 60),
      text("Example footer copy four", 35, 50),
    );
  }

  return {
    async getTextContent() {
      return { items };
    },
    getViewport() {
      return { height: 842, width: 595 };
    },
  };
}

function documentWithPages(pages: FakePage[]): FakeDocument {
  return {
    async getPage(pageNumber) {
      return pages[pageNumber - 1];
    },
    numPages: pages.length,
  };
}

function rowAnchorItems(date: string, amount: string, y: number) {
  return [
    text(date, 36, y),
    text("CNY", 100, y),
    text(amount, 190, y),
    text("8,765.44", 260, y),
  ];
}

function statementPageWithRows(rowCount: number): FakePage {
  const items = [
    text("招商银行交易流水", 250, 788),
    text("户名：示例户名 账号：6214********0000", 36, 716),
    ...headers.map((header, index) => text(header, headerX[index], 624)),
  ];

  for (let index = 0; index < rowCount; index += 1) {
    const y = 581 - index * 4;
    items.push(
      text("2026-07-04", 36, y),
      text("CNY", 100, y),
      text("-1.00", 190, y),
      text("8,765.44", 260, y),
      text("快捷支付", 309, y),
      text("示例商户", 418, y),
    );
  }

  return {
    async getTextContent() {
      return { items };
    },
    getViewport() {
      return { height: 842, width: 595 };
    },
  };
}

describe("CMB import failure boundaries", () => {
  beforeEach(() => {
    pdfMock.document = null;
    pdfMock.error = null;
    pdfMock.destroy.mockReset().mockResolvedValue(undefined);
  });

  it("does not start PDF work for an already cancelled import", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(parseCmbPdf(Buffer.from("pdf"), controller.signal)).rejects.toThrow("xlsx-timeout");
    expect(pdfMock.destroy).not.toHaveBeenCalled();
  });

  it("destroys cancelled PDF work and waits for cleanup before settling", async () => {
    const controller = new AbortController();
    let releaseCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    let started!: () => void;
    const began = new Promise<void>((resolve) => { started = resolve; });
    pdfMock.destroy.mockImplementation(async () => { await cleanup; });
    pdfMock.document = documentWithPages([{
      getViewport: () => ({ height: 842, width: 595 }),
      getTextContent: () => new Promise((resolve) => {
        controller.signal.addEventListener("abort", () => resolve({ items: [] }), { once: true });
        started();
      }),
    }]);
    let settled = false;
    const result = parseCmbPdf(Buffer.from("pdf"), controller.signal).catch((error: Error) => error.message)
      .finally(() => { settled = true; });
    await began;
    controller.abort();
    await Promise.resolve();
    expect(pdfMock.destroy).toHaveBeenCalled();
    expect(settled).toBe(false);
    releaseCleanup();
    expect(await result).toBe("xlsx-timeout");
  });

  it("rejects encrypted or otherwise unreadable PDFs", async () => {
    pdfMock.error = new Error("PasswordException");

    await expect(parseCmbPdf(Buffer.from("pdf"))).rejects.toThrow(
      "无法识别招商银行流水格式",
    );
  });

  it("rejects PDFs without the supported text layer", async () => {
    pdfMock.document = documentWithPages([
      {
        async getTextContent() {
          return { items: [] };
        },
        getViewport() {
          return { height: 842, width: 595 };
        },
      },
    ]);

    await expect(parseCmbPdf(Buffer.from("pdf"))).rejects.toThrow(
      "无法识别招商银行流水格式",
    );
  });

  it("rejects statements with shifted column anchors", async () => {
    pdfMock.document = documentWithPages([statementPage({ headerShift: 12 })]);

    await expect(parseCmbPdf(Buffer.from("pdf"))).rejects.toThrow(
      "无法识别招商银行流水格式",
    );
  });

  it("accepts the official English subheaders and fixed footer copy", async () => {
    pdfMock.document = documentWithPages([
      statementPage({ officialDecorations: true }),
    ]);

    const result = await parseCmbPdf(Buffer.from("pdf"));

    expect(result.rows).toHaveLength(1);
    expect(result.invalidRows).toEqual([]);
  });

  it("accepts continuation pages with a raised table and no title or identity", async () => {
    pdfMock.document = documentWithPages([
      statementPage(),
      statementPage({
        date: "2026-07-05",
        headerY: 790,
        includeIdentity: false,
        includeTitle: false,
        officialDecorations: true,
        rowY: 747,
      }),
    ]);

    const result = await parseCmbPdf(Buffer.from("pdf"));

    expect(result.ownerName).toBe("示例户名");
    expect(result.rows).toMatchObject([
      { occurredAtDate: "2026-07-04", rowNumber: 1 },
      { occurredAtDate: "2026-07-05", rowNumber: 2 },
    ]);
    expect(result.invalidRows).toEqual([]);
  });

  it("rejects a missing first-page title even when a later page has the title", async () => {
    pdfMock.document = documentWithPages([
      statementPage({ includeTitle: false }),
      statementPage({ date: "2026-07-05" }),
    ]);

    await expect(parseCmbPdf(Buffer.from("pdf"))).rejects.toThrow(
      "无法识别招商银行流水格式",
    );
  });

  it("rejects shifted column anchors on a continuation page without a title", async () => {
    pdfMock.document = documentWithPages([
      statementPage(),
      statementPage({
        headerShift: 12,
        headerY: 790,
        includeIdentity: false,
        includeTitle: false,
        officialDecorations: true,
        rowY: 747,
      }),
    ]);

    await expect(parseCmbPdf(Buffer.from("pdf"))).rejects.toThrow(
      "无法识别招商银行流水格式",
    );
  });

  it("keeps centered multiline summaries and counterparties with their own transactions", async () => {
    pdfMock.document = documentWithPages([
      statementPage({
        rowItems: [
          ...rowAnchorItems("2026-07-04", "-10.00", 581),
          text("餐饮", 309, 587),
          text("消费", 309, 575),
          text("示例商户甲", 418, 587),
          text("示例门店甲", 418, 575),
          ...rowAnchorItems("2026-07-05", "+20.00", 553),
          text("工资", 309, 559),
          text("入账", 309, 547),
          text("示例公司乙", 418, 559),
          text("示例分部乙", 418, 547),
        ],
      }),
    ]);

    const result = await parseCmbPdf(Buffer.from("pdf"));

    expect(result.rows).toMatchObject([
      {
        amountFen: 1000,
        mappingKey: "cmb|EXPENSE|餐饮 消费|示例商户甲 示例门店甲",
        note: "招商银行：餐饮 消费；对手信息：示例商户甲 示例门店甲",
        occurredAtDate: "2026-07-04",
        primaryCategory: "餐饮 消费",
        rowNumber: 1,
        secondaryCategory: "示例商户甲 示例门店甲",
        transactionType: TransactionType.EXPENSE,
      },
      {
        amountFen: 2000,
        mappingKey: "cmb|INCOME|工资 入账|示例公司乙 示例分部乙",
        note: "招商银行：工资 入账；对手信息：示例公司乙 示例分部乙",
        occurredAtDate: "2026-07-05",
        primaryCategory: "工资 入账",
        rowNumber: 2,
        secondaryCategory: "示例公司乙 示例分部乙",
        transactionType: TransactionType.INCOME,
      },
    ]);
    expect(result.invalidRows).toEqual([]);
  });

  it("does not append the next transaction's upper counterparty line to the previous row", async () => {
    pdfMock.document = documentWithPages([
      statementPage({
        rowItems: [
          ...rowAnchorItems("2026-07-04", "-10.00", 581),
          text("快捷支付", 309, 581),
          text("示例商户甲", 418, 581),
          ...rowAnchorItems("2026-07-05", "-20.00", 553),
          text("快捷支付", 309, 553),
          text("示例商户乙", 418, 559),
          text("示例门店乙", 418, 547),
        ],
      }),
    ]);

    const result = await parseCmbPdf(Buffer.from("pdf"));

    expect(result.rows).toMatchObject([
      {
        amountFen: 1000,
        mappingKey: "cmb|EXPENSE|快捷支付|示例商户甲",
        note: "招商银行：快捷支付；对手信息：示例商户甲",
        occurredAtDate: "2026-07-04",
        secondaryCategory: "示例商户甲",
      },
      {
        amountFen: 2000,
        mappingKey: "cmb|EXPENSE|快捷支付|示例商户乙 示例门店乙",
        note: "招商银行：快捷支付；对手信息：示例商户乙 示例门店乙",
        occurredAtDate: "2026-07-05",
        secondaryCategory: "示例商户乙 示例门店乙",
      },
    ]);
    expect(result.invalidRows).toEqual([]);
  });

  it("joins fragmented visual lines left to right and preserves spaces between wrapped lines", async () => {
    pdfMock.document = documentWithPages([
      statementPage({
        rowItems: [
          ...rowAnchorItems("2026-07-04", "-10.00", 581),
          text("入账", 319, 575),
          text("商户", 428, 587),
          text("消费", 309, 575),
          text("门店", 428, 575),
          text("支付", 319, 587),
          text("示例", 418, 587),
          text("快捷", 309, 587),
          text("一号", 418, 575),
        ],
      }),
    ]);

    const result = await parseCmbPdf(Buffer.from("pdf"));

    expect(result.rows).toMatchObject([
      {
        mappingKey: "cmb|EXPENSE|快捷支付 消费入账|示例商户 一号门店",
        note: "招商银行：快捷支付 消费入账；对手信息：示例商户 一号门店",
        primaryCategory: "快捷支付 消费入账",
        secondaryCategory: "示例商户 一号门店",
      },
    ]);
    expect(result.invalidRows).toEqual([]);
  });

  it.each([
    ["summary", 309],
    ["counterparty", 418],
  ])("rejects a %s continuation equidistant from two transactions", async (_label, x) => {
    pdfMock.document = documentWithPages([
      statementPage({
        rowItems: [
          ...rowAnchorItems("2026-07-04", "-10.00", 581),
          text("快捷支付", 309, 581),
          text("示例商户甲", 418, 581),
          text("归属不明", x, 567),
          ...rowAnchorItems("2026-07-05", "-20.00", 553),
          text("快捷支付", 309, 553),
          text("示例商户乙", 418, 553),
        ],
      }),
    ]);

    await expect(parseCmbPdf(Buffer.from("pdf"))).rejects.toThrow(
      "无法识别招商银行流水格式",
    );
  });

  it("rejects transaction-like rows inside the fixed footer region", async () => {
    pdfMock.document = documentWithPages([statementPage({ rowY: 90 })]);

    await expect(parseCmbPdf(Buffer.from("pdf"))).rejects.toThrow(
      "无法识别招商银行流水格式",
    );
  });

  it.each([
    ["amount", { amountX: 240 }],
    ["balance", { balanceX: 310 }],
    ["summary", { summaryX: 420 }],
  ])("rejects statements with shifted %s data cells", async (_label, input) => {
    pdfMock.document = documentWithPages([statementPage(input)]);

    await expect(parseCmbPdf(Buffer.from("pdf"))).rejects.toThrow(
      "无法识别招商银行流水格式",
    );
  });

  it("rejects statements that combine different page identities", async () => {
    pdfMock.document = documentWithPages([
      statementPage(),
      statementPage({ account: "6214********9999", owner: "另一示例户名" }),
    ]);

    await expect(parseCmbPdf(Buffer.from("pdf"))).rejects.toThrow(
      "无法识别招商银行流水格式",
    );
  });

  it("rejects a malformed first transaction instead of importing later pages", async () => {
    pdfMock.document = documentWithPages([
      statementPage({ date: "2026/07/04" }),
      statementPage({ date: "2026-07-05" }),
    ]);

    await expect(parseCmbPdf(Buffer.from("pdf"))).rejects.toThrow(
      "无法识别招商银行流水格式",
    );
  });

  it("rejects statements above the page limit before reading pages", async () => {
    pdfMock.document = {
      async getPage() {
        throw new Error("Pages must not be read");
      },
      numPages: 501,
    };

    await expect(parseCmbPdf(Buffer.from("pdf"))).rejects.toThrow(
      "Import file is too large",
    );
  });

  it(
    "rejects statements above the transaction row limit",
    async () => {
      const page = statementPageWithRows(50);
      pdfMock.document = documentWithPages(Array.from({ length: 401 }, () => page));

      await expect(parseCmbPdf(Buffer.from("pdf"))).rejects.toThrow(
        "Import file is too large",
      );
    },
    15_000,
  );

  it("marks zero amounts and invalid calendar dates as invalid rows", async () => {
    pdfMock.document = documentWithPages([
      statementPage({ amount: "0.00" }),
      statementPage({ date: "2026-02-30" }),
    ]);

    const result = await parseCmbPdf(Buffer.from("pdf"));

    expect(result.rows).toEqual([]);
    expect(result.invalidRows.map((row) => row.reason)).toEqual([
      "Invalid amount",
      "Invalid date",
    ]);
  });

  it("normalizes equivalent signed amounts and mapping separators", async () => {
    pdfMock.document = documentWithPages([
      statementPage({
        amount: "−1,234.56",
        counterparty: "示例|商户",
        summary: "快捷|支付",
      }),
    ]);
    const unicodeResult = await parseCmbPdf(Buffer.from("pdf"));
    pdfMock.document = documentWithPages([
      statementPage({
        amount: "-1234.56",
        counterparty: "示例|商户",
        summary: "快捷|支付",
      }),
    ]);
    const asciiResult = await parseCmbPdf(Buffer.from("pdf"));

    expect(unicodeResult.rows[0]).toMatchObject({
      amountFen: 123456,
      mappingKey: "cmb|EXPENSE|快捷｜支付|示例｜商户",
      transactionType: TransactionType.EXPENSE,
    });
    expect(unicodeResult.rows[0].sourceFingerprint).toBe(
      asciiResult.rows[0].sourceFingerprint,
    );
  });
});
