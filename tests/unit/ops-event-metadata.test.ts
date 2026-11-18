import { describe, expect, it } from "vitest";
import {
  sanitizeAppEventMetadata,
  sanitizeAppEventPath,
  sanitizeAppEventSummary,
} from "@/lib/ops/event-metadata";

const allowedAppEventPathnames = [
  "/login",
  "/home",
  "/add",
  "/records",
  "/records/import",
] as const;

const allowedAppEventSummaries = [
  "登录成功",
  "登录失败",
  "登录被临时锁定",
  "访问 首页",
  "访问 记一笔",
  "访问 记录",
  "访问 导入记录",
  "新增收入记录",
  "新增支出记录",
  "编辑收入记录",
  "编辑支出记录",
  "删除收入记录",
  "删除支出记录",
  "上传导入草稿",
] as const;

describe("sanitizeAppEventMetadata", () => {
  it("keeps only allowed non-sensitive metadata", () => {
    expect(
      sanitizeAppEventMetadata({
        count: 24,
        source: "alipay",
        transactionType: "expense",
      }),
    ).toEqual({
      count: 24,
      source: "alipay",
      transactionType: "expense",
    });
  });

  it("allows income transaction type metadata", () => {
    expect(sanitizeAppEventMetadata({ transactionType: "income" })).toEqual({
      transactionType: "income",
    });
  });

  it("rejects unknown transaction type metadata values", () => {
    expect(() =>
      sanitizeAppEventMetadata({ transactionType: "transfer" }),
    ).toThrow("Unsupported app event metadata");
  });

  it("allows known import sources", () => {
    expect(sanitizeAppEventMetadata({ source: "sui_shou_ji" })).toEqual({
      source: "sui_shou_ji",
    });
    expect(sanitizeAppEventMetadata({ source: "wechat_pay" })).toEqual({
      source: "wechat_pay",
    });
    expect(sanitizeAppEventMetadata({ source: "alipay" })).toEqual({
      source: "alipay",
    });
    expect(sanitizeAppEventMetadata({ source: "cmb" })).toEqual({
      source: "cmb",
    });
  });

  it("rejects unknown source metadata values", () => {
    expect(() => sanitizeAppEventMetadata({ source: "account-123" })).toThrow(
      "Unsupported app event metadata",
    );
  });

  it("returns undefined for empty metadata", () => {
    expect(sanitizeAppEventMetadata({})).toBeUndefined();
  });

  it("rejects sensitive or unknown metadata keys", () => {
    expect(() =>
      sanitizeAppEventMetadata({
        amountFen: 1234,
        note: "private note",
      }),
    ).toThrow("Unsupported app event metadata");
  });

  it("rejects unsafe count values", () => {
    expect(() => sanitizeAppEventMetadata({ count: -1 })).toThrow(
      "Unsupported app event metadata",
    );
  });

  it("rejects decimal and too large count values", () => {
    expect(() => sanitizeAppEventMetadata({ count: 1.5 })).toThrow(
      "Unsupported app event metadata",
    );
    expect(() => sanitizeAppEventMetadata({ count: 100001 })).toThrow(
      "Unsupported app event metadata",
    );
  });
});

describe("sanitizeAppEventPath", () => {
  it("allows all fixed app event pathnames", () => {
    for (const pathname of allowedAppEventPathnames) {
      expect(sanitizeAppEventPath(pathname)).toBe(pathname);
    }
  });

  it("strips query and origin before returning allowed pathnames", () => {
    expect(sanitizeAppEventPath("/records?record=abc")).toBe("/records");
    expect(
      sanitizeAppEventPath("https://example.invalid/records?record=abc"),
    ).toBe("/records");
    expect(sanitizeAppEventPath("/records/import?draft=secret")).toBe(
      "/records/import",
    );
  });

  it("rejects unknown pathnames", () => {
    expect(() => sanitizeAppEventPath("/unsafe?token=secret")).toThrow(
      "Unsupported app event path",
    );
  });
});

describe("sanitizeAppEventSummary", () => {
  it("accepts all allowed fixed summaries", () => {
    for (const summary of allowedAppEventSummaries) {
      expect(sanitizeAppEventSummary(summary)).toBe(summary);
    }
  });

  it("accepts allowed bounded import confirmation summaries", () => {
    expect(sanitizeAppEventSummary("确认导入 24 笔")).toBe("确认导入 24 笔");
  });

  it("rejects import confirmation summaries outside the bounded format", () => {
    expect(() => sanitizeAppEventSummary("确认导入 1000000 笔")).toThrow(
      "Unsupported app event summary",
    );
    expect(() => sanitizeAppEventSummary("确认导入 24笔")).toThrow(
      "Unsupported app event summary",
    );
    expect(() => sanitizeAppEventSummary("确认导入 24 条")).toThrow(
      "Unsupported app event summary",
    );
  });

  it("rejects unknown summaries", () => {
    expect(() => sanitizeAppEventSummary("备注 private note")).toThrow(
      "Unsupported app event summary",
    );
  });
});
