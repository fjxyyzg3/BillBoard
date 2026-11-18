import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isCurrentNaturalLanguageSuccessResult } from "@/lib/transactions/natural-language-types";

const mixed = { status: "success", requestId: randomUUID(), resultVersion: 2, count: 2,
  incomeCount: 1, expenseCount: 1, incomeAmountFen: 800000, expenseAmountFen: 3500 };

describe("natural-language success capability", () => {
  it.each([
    mixed,
    { ...mixed, incomeCount: 0, expenseCount: 2, incomeAmountFen: 0, expenseAmountFen: 5700 },
    { ...mixed, count: 1, incomeCount: 1, expenseCount: 0, incomeAmountFen: 2550, expenseAmountFen: 0 },
    { ...mixed, count: 20, incomeCount: 20, expenseCount: 0, incomeAmountFen: 20 * 2147483647, expenseAmountFen: 0 },
  ])("accepts separate and bounded type totals %#", (result) => {
    expect(isCurrentNaturalLanguageSuccessResult(result)).toBe(true);
  });

  it.each([
    { status: "success", requestId: mixed.requestId, count: 2, totalAmountFen: 803500 },
    { ...mixed, resultVersion: 1 },
    { ...mixed, resultVersion: undefined },
    { ...mixed, requestId: "invalid" },
    { ...mixed, count: 3 },
    { ...mixed, count: 21, incomeCount: 20 },
    { ...mixed, incomeCount: 0, expenseCount: 2 },
    { ...mixed, incomeCount: -1, expenseCount: 3 },
    { ...mixed, incomeAmountFen: 0 },
    { ...mixed, incomeAmountFen: 0.5 },
    { ...mixed, incomeAmountFen: 2147483648 },
    { ...mixed, expenseAmountFen: undefined },
    { ...mixed, totalAmountFen: 803500 },
    { ...mixed, transactionIds: [randomUUID(), randomUUID()] },
    null,
  ])("refuses incompatible or inconsistent success data %#", (result) => {
    expect(isCurrentNaturalLanguageSuccessResult(result)).toBe(false);
  });
});
