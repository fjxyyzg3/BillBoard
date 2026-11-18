import { describe, expect, it } from "vitest";
import { formatFen, getAmountExpressionPreviewFen, parseAmountInput } from "@/lib/money";

describe("parseAmountInput", () => {
  it("converts a yuan string into fen", () => {
    expect(parseAmountInput("12.34")).toBe(1234);
  });

  it("keeps plain amount input strict to two decimal places", () => {
    expect(() => parseAmountInput("1.999")).toThrow(
      "Enter a valid amount with up to two decimals",
    );
  });

  it("calculates arithmetic expressions and stores the rounded fen result", () => {
    expect(parseAmountInput("12+8/2")).toBe(1600);
    expect(parseAmountInput("(18.6 + 7.4) * 2")).toBe(5200);
    expect(parseAmountInput("10/3")).toBe(333);
    expect(parseAmountInput("-5 + 20")).toBe(1500);
  });

  it("normalizes common full-width and calculator operators in expressions", () => {
    expect(parseAmountInput("12＋8÷2")).toBe(1600);
    expect(parseAmountInput("（18.60＋1.40）×2")).toBe(4000);
    expect(parseAmountInput("12。34")).toBe(1234);
  });

  it("rejects malformed expressions and unsupported syntax", () => {
    expect(() => parseAmountInput("12+")).toThrow(
      "Enter a valid amount with up to two decimals",
    );
    expect(() => parseAmountInput("1/0")).toThrow(
      "Enter a valid amount with up to two decimals",
    );
    expect(() => parseAmountInput("2(3+4)")).toThrow(
      "Enter a valid amount with up to two decimals",
    );
    expect(() => parseAmountInput("12 34")).toThrow(
      "Enter a valid amount with up to two decimals",
    );
    expect(() => parseAmountInput("1.999+0")).toThrow(
      "Enter a valid amount with up to two decimals",
    );
  });

  it("rejects amounts that exceed the integer fen storage limit", () => {
    expect(parseAmountInput("21474836.47")).toBe(2147483647);
    expect(() => parseAmountInput("21474836.48")).toThrow(
      "Enter a valid amount with up to two decimals",
    );
    expect(() => parseAmountInput("21474836.47+0.01")).toThrow(
      "Enter a valid amount with up to two decimals",
    );
  });

  it("rejects zero or negative values", () => {
    expect(() => parseAmountInput("0")).toThrow("Amount must be greater than zero");
    expect(() => parseAmountInput("-1")).toThrow("Amount must be greater than zero");
    expect(() => parseAmountInput("5-20")).toThrow("Amount must be greater than zero");
  });
});

describe("getAmountExpressionPreviewFen", () => {
  it("returns rounded fen for valid expression inputs only", () => {
    expect(getAmountExpressionPreviewFen("12+8/2")).toBe(1600);
    expect(getAmountExpressionPreviewFen("10/3")).toBe(333);
    expect(getAmountExpressionPreviewFen("12.34")).toBeNull();
    expect(getAmountExpressionPreviewFen("12+")).toBeNull();
    expect(getAmountExpressionPreviewFen("5-20")).toBeNull();
  });
});

describe("formatFen", () => {
  it("renders fen as yuan", () => {
    expect(formatFen(1234)).toBe("12.34");
  });
});
