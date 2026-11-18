import { describe, expect, it } from "vitest";
import {
  NATURAL_LANGUAGE_SCHEMA_VERSION,
  normalizeNaturalLanguageText,
  validateNaturalLanguageRequest,
  validateNaturalLanguageResponse,
  type NaturalLanguageRequest,
} from "../../src/lib/transactions/natural-language-protocol";

const request: NaturalLanguageRequest = {
  schemaVersion: NATURAL_LANGUAGE_SCHEMA_VERSION,
  text: "昨天老婆买菜 50 元，我今天打车 20 元",
  referenceDateTime: "2026-10-13T12:34",
  categories: [{ id: "c0", name: "Food", displayName: "餐饮", type: "EXPENSE" }, { id: "c1", name: "Transport", displayName: "交通", type: "EXPENSE" }],
  members: [{ id: "m0", displayName: "成员一" }, { id: "m1", displayName: "成员二" }],
  currentMemberId: "m0",
};
const expense = { start: 0, end: 11, type: "EXPENSE", amountFen: 5000, occurredAt: "2026-10-12T00:00", memberId: "m1", categoryId: "c0", note: "买菜" };
const success = { schemaVersion: NATURAL_LANGUAGE_SCHEMA_VERSION, outcome: "success", transactions: [expense] };
const correction = {
  schemaVersion: NATURAL_LANGUAGE_SCHEMA_VERSION,
  outcome: "needs_correction",
  issues: [{ code: "missing_amount", start: 12, end: request.text.length }],
};

describe("natural language entry protocol", () => {
  it("accepts v2 income and mixed transactions bound by category types", () => {
    const mixedRequest = validateNaturalLanguageRequest({
      ...request,
      schemaVersion: "natural-language-entry.v2",
      text: "工资到账 8000 元，午饭花了 35 元",
      categories: [
        { id: "c0", name: "Salary", displayName: "工资", type: "INCOME" },
        { id: "c1", name: "Food", displayName: "餐饮", type: "EXPENSE" },
      ],
    });
    const boundary = mixedRequest.text.indexOf("，");
    const result = {
      schemaVersion: "natural-language-entry.v2",
      outcome: "success",
      transactions: [
        { ...expense, start: 0, end: boundary, type: "INCOME", amountFen: 800000, occurredAt: null, memberId: "m0", categoryId: "c0", note: "工资" },
        { ...expense, start: boundary + 1, end: mixedRequest.text.length, type: "EXPENSE", amountFen: 3500, occurredAt: null, memberId: "m0", categoryId: "c1", note: "午饭" },
      ],
    };
    expect(validateNaturalLanguageResponse(mixedRequest, result)).toEqual(result);
  });

  it("normalizes text once with shared UTF-16 offsets and retains interior whitespace", () => {
    expect(normalizeNaturalLanguageText(" \r\n 午饭 35 元\r打车 20 元\r\n ")).toBe("午饭 35 元\n打车 20 元");
    const result = validateNaturalLanguageRequest({ ...request, text: "  咖啡☕ 18 元\r\n午饭 35 元  " });
    expect(result.text).toBe("咖啡☕ 18 元\n午饭 35 元");
    expect(validateNaturalLanguageRequest(request)).toEqual(request);
  });

  it.each([
    { ...request, schemaVersion: "other" },
    { ...request, schemaVersion: "natural-language-entry.v1" },
    { ...request, text: "  \n " },
    { ...request, text: "字".repeat(2001) },
    { ...request, householdId: "private-id" },
    { ...request, model: "arbitrary-model" },
    { ...request, referenceDateTime: "2026-02-30T00:00" },
    { ...request, referenceDateTime: "2026-10-13T24:00" },
    { ...request, categories: [] },
    { ...request, categories: [request.categories[0], request.categories[0]] },
    { ...request, categories: [{ ...request.categories[0], type: undefined }] },
    { ...request, categories: [{ ...request.categories[0], type: "TRANSFER" }] },
    { ...request, categories: [{ ...request.categories[0], enabled: true }] },
    { ...request, members: [request.members[0], request.members[0]] },
    { ...request, members: [{ id: "actual-database-id", displayName: "Member" }] },
    { ...request, members: [{ ...request.members[0], email: "member@example.com" }] },
    { ...request, currentMemberId: "m9" },
  ])("rejects invalid, oversized, or expanded request data", (input) => {
    expect(() => validateNaturalLanguageRequest(input)).toThrow();
  });

  it("accepts complete success and fixed issues without partial entries", () => {
    expect(validateNaturalLanguageResponse(request, success)).toEqual(success);
    expect(validateNaturalLanguageResponse(request, correction)).toEqual(correction);
    expect(validateNaturalLanguageResponse(request, { ...success, transactions: [{ ...expense, occurredAt: null, note: "" }] })).toMatchObject({ outcome: "success" });
  });

  it("binds identical category names to their distinct transaction types", () => {
    const input: NaturalLanguageRequest = {
      ...request,
      text: "收到其他收入 100 元，其他支出 25 元",
      categories: [
        { id: "c0", name: "Other", displayName: "其他", type: "INCOME" },
        { id: "c1", name: "Other", displayName: "其他", type: "EXPENSE" },
      ],
    };
    const boundary = input.text.indexOf("，");
    const income = { ...expense, start: 0, end: boundary, type: "INCOME", amountFen: 10000, categoryId: "c0", occurredAt: null };
    const outgoing = { ...expense, start: boundary + 1, end: input.text.length, amountFen: 2500, categoryId: "c1", occurredAt: null };
    const result = { ...success, transactions: [income, outgoing] };
    expect(validateNaturalLanguageResponse(input, result)).toEqual(result);
    expect(() => validateNaturalLanguageResponse(input, { ...result, transactions: [{ ...income, categoryId: "c1" }, outgoing] })).toThrow("category type mismatch");
    expect(() => validateNaturalLanguageResponse(input, { ...result, transactions: [income, { ...outgoing, categoryId: "c0" }] })).toThrow("category type mismatch");
  });

  it("retains the complete issue-code whitelist for terminal result replay", () => {
    for (const code of ["missing_amount", "ambiguous_amount", "ambiguous_date", "ambiguous_member", "unsupported_transaction", "unclear_expense", "too_many_expenses"]) {
      const result = { ...correction, issues: [{ ...correction.issues[0], code }] };
      expect(validateNaturalLanguageResponse(request, result)).toEqual(result);
    }
  });

  it("applies the 20-transaction limit to the complete mixed batch", () => {
    const fragments = Array.from({ length: 21 }, (_, index) => index % 2 ? "收入 1 元" : "支出 1 元");
    const input: NaturalLanguageRequest = {
      ...request,
      text: fragments.join("，"),
      categories: [
        request.categories[0],
        { id: "c1", name: "Other", displayName: "其他收入", type: "INCOME" },
      ],
    };
    let start = 0;
    const transactions = fragments.map((fragment, index) => {
      const row = { ...expense, start, end: start + fragment.length, type: index % 2 ? "INCOME" : "EXPENSE", categoryId: index % 2 ? "c1" : "c0", memberId: "m0", amountFen: 100, occurredAt: null, note: "" };
      start += fragment.length + 1;
      return row;
    });
    const accepted = { ...input, text: fragments.slice(0, 20).join("，") };
    expect(validateNaturalLanguageResponse(accepted, { ...success, transactions: transactions.slice(0, 20) })).toMatchObject({ outcome: "success" });
    expect(() => validateNaturalLanguageResponse(input, { ...success, transactions })).toThrow();
  });

  it.each([
    { ...success, schemaVersion: "other" },
    { ...success, schemaVersion: "natural-language-entry.v1" },
    { ...success, commentary: "raw output" },
    { ...success, issues: correction.issues },
    { ...success, expenses: [expense] },
    { schemaVersion: NATURAL_LANGUAGE_SCHEMA_VERSION, outcome: "success", expenses: [expense] },
    { ...success, transactions: [] },
    { ...success, transactions: Array(21).fill(expense) },
    { ...success, transactions: [expense, expense] },
    ...[
      { amountFen: 0 }, { amountFen: -1 }, { amountFen: 12.3 }, { amountFen: 2147483648 },
      { type: undefined }, { type: "TRANSFER" }, { type: "INCOME" },
      { categoryId: "c9" }, { memberId: "m9" }, { start: -1 }, { start: 0.5 },
      { end: 0 }, { end: request.text.length + 1 }, { occurredAt: "2026-02-29T00:00" },
      { occurredAt: "2026-10-13T12:00:00Z" }, { occurredAt: "2026-10-13T12:60" },
      { note: "x".repeat(201) }, { createdByMemberId: "m1" },
    ].map((invalid) => ({ ...success, transactions: [{ ...expense, ...invalid }] })),
    { ...success, transactions: [{ ...expense, amountFen: undefined }] },
    { ...success, transactions: [{ ...expense, occurredAt: undefined }] },
    { ...correction, transactions: [expense] },
    { ...correction, issues: [] },
    { ...correction, issues: Array(21).fill(correction.issues[0]) },
    { ...correction, issues: [{ ...correction.issues[0], explanation: "raw model output" }] },
    { ...correction, issues: [{ ...correction.issues[0], code: "invented_code" }] },
    { ...correction, issues: [{ ...correction.issues[0], end: request.text.length + 1 }] },
  ])("rejects incomplete, unbound, or invalid model results", (input) => {
    expect(() => validateNaturalLanguageResponse(request, input)).toThrow();
  });

  it("rejects whitespace-only evidence and offsets splitting UTF-16 surrogate pairs", () => {
    const unicode = { ...request, text: "🍚 午饭 35 元" };
    expect(() => validateNaturalLanguageResponse(unicode, { ...success, transactions: [{ ...expense, start: 1, end: 4 }] })).toThrow();
    expect(() => validateNaturalLanguageResponse(unicode, { ...success, transactions: [{ ...expense, start: 2, end: 3 }] })).toThrow();
    expect(validateNaturalLanguageResponse(unicode, { ...success, transactions: [{ ...expense, start: 0, end: unicode.text.length }] })).toMatchObject({ outcome: "success" });
  });
});
