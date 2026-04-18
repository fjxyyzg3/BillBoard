import { describe, expect, it } from "vitest";
import { formatFen, parseAmountInput } from "@/lib/money";

describe("parseAmountInput", () => {
  it("converts a yuan string into fen", () => {
    expect(parseAmountInput("12.34")).toBe(1234);
  });

  it("rejects zero or negative values", () => {
    expect(() => parseAmountInput("0")).toThrow("Amount must be greater than zero");
    expect(() => parseAmountInput("-1")).toThrow("Amount must be greater than zero");
  });
});

describe("formatFen", () => {
  it("renders fen as yuan", () => {
    expect(formatFen(1234)).toBe("12.34");
  });
});
