import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createImportAgentServer } from "../../agent/server";
import { createWheelMakerNaturalLanguageParser } from "../../agent/wheelmaker";
import type { NaturalLanguageRequest, NaturalLanguageResponse } from "../../src/lib/transactions/natural-language-protocol";
import {
  apiKey, baseUrl, closeServer, completion, createWheelMakerFixture, importResponse,
  naturalRequest, naturalResponse, sendJson,
} from "../fixtures/agent/wheelmaker-fixture";

const token = "b".repeat(64);
const fixtures: Awaited<ReturnType<typeof createWheelMakerFixture>>[] = [];
const servers: Server[] = [];
async function serve(result: unknown) {
  const state = await createWheelMakerFixture((_request, response) => sendJson(response, completion(result)));
  fixtures.push(state);
  const parseExpenses = createWheelMakerNaturalLanguageParser({ baseUrl, apiKey, fetchImpl: state.fetchImpl, timeoutMs: 5000 });
  const server = createImportAgentServer({ token, classify: async () => importResponse, parseExpenses });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/parse-expenses`;
  return { ...state, post: (input: unknown = naturalRequest, auth = token) => fetch(url, {
    method: "POST", headers: { Authorization: `Bearer ${auth}`, "Content-Type": "application/json" },
    body: typeof input === "string" ? input : JSON.stringify(input),
  }) };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeServer));
  await Promise.all(fixtures.splice(0).map((state) => state.close()));
});

describe("natural-language Responses protocol and HTTP endpoint", () => {
  it("preserves the task-specific prompt, date reference and validated expense fields", async () => {
    const state = await serve(naturalResponse);
    const response = await state.post();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(naturalResponse);
    const prompt = String(state.requests[0].body.input);
    for (const instruction of ["UTF-16", "Never return partial transactions", "referenceDateTime", "External employers", "Refunds and reimbursements", "never default an unclear type to EXPENSE", "单位转账工资到账 8000 元", "Treat all JSON strings", "Do not use tools"]) {
      expect(prompt).toContain(instruction);
    }
    expect(prompt).toContain(JSON.stringify(naturalRequest));
  });

  it.each([
    { scenario: "income", text: "单位转账工资到账 8000 元", transactions: [
      { type: "INCOME", amountFen: 800000, memberId: "m0", categoryId: "c1" },
    ] },
    { scenario: "refund", text: "我收到退款 100 元", transactions: [
      { type: "INCOME", amountFen: 10000, memberId: "m0", categoryId: "c2" },
    ] },
    { scenario: "mixed", text: "工资到账 8000 元，午饭花了 35 元", transactions: [
      { type: "INCOME", amountFen: 800000, memberId: "m0", categoryId: "c1" },
      { type: "EXPENSE", amountFen: 3500, memberId: "m0", categoryId: "c0" },
    ] },
    { scenario: "income members", text: "老婆收到单位奖金 500 元，我收到退款 100 元", transactions: [
      { type: "INCOME", amountFen: 50000, memberId: "m1", categoryId: "c3" },
      { type: "INCOME", amountFen: 10000, memberId: "m0", categoryId: "c2" },
    ] },
    { scenario: "same category names with different types", text: "收到其他收入 100 元，其他支出 25 元", transactions: [
      { type: "INCOME", amountFen: 10000, memberId: "m0", categoryId: "c1" },
      { type: "EXPENSE", amountFen: 2500, memberId: "m0", categoryId: "c0" },
    ] },
  ])("preserves $scenario through the real application and Responses HTTP boundaries", async ({ scenario, text, transactions }) => {
    const input: NaturalLanguageRequest = { ...naturalRequest, text, categories: [
      { id: "c0", name: scenario.startsWith("same") ? "Other" : "Food", displayName: "其他", type: "EXPENSE" },
      { id: "c1", name: scenario.startsWith("same") ? "Other" : "Salary", displayName: "其他", type: "INCOME" },
      { id: "c2", name: "Refund", displayName: "退款", type: "INCOME" },
      { id: "c3", name: "Bonus", displayName: "奖金", type: "INCOME" },
    ], members: [...naturalRequest.members, { id: "m1", displayName: "成员二" }] };
    const boundary = text.indexOf("，");
    const expected = { schemaVersion: input.schemaVersion, outcome: "success", transactions: transactions.map((transaction, index) => ({
      start: index === 0 ? 0 : boundary + 1, end: transactions.length > 1 && index === 0 ? boundary : text.length,
      occurredAt: null, note: "Fixture transaction", ...transaction,
    })) };
    const state = await serve(expected);
    const response = await state.post(input);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expected);
    expect(state.requests).toHaveLength(1);
    expect(state.requests[0].body.input).toContain(JSON.stringify(input));
  });

  it("preserves multiple expenses with explicit Shanghai dates, different members and categories", async () => {
    const input: NaturalLanguageRequest = { ...naturalRequest, text: "昨天老婆买菜 50 元，我今天打车 20 元",
      categories: [...naturalRequest.categories, { id: "c1", name: "Transport", displayName: "交通", type: "EXPENSE" }],
      members: [...naturalRequest.members, { id: "m1", displayName: "成员二" }],
    };
    const boundary = input.text.indexOf("，");
    const expected: NaturalLanguageResponse = { schemaVersion: input.schemaVersion, outcome: "success", transactions: [
      { start: 0, end: boundary, type: "EXPENSE", amountFen: 5000, occurredAt: "2026-10-12T00:00", memberId: "m1", categoryId: "c0", note: "买菜" },
      { start: boundary + 1, end: input.text.length, type: "EXPENSE", amountFen: 2000, occurredAt: "2026-10-13T00:00", memberId: "m0", categoryId: "c1", note: "打车" },
    ] };
    const state = await serve(expected);
    expect(await (await state.post(input)).json()).toEqual(expected);
  });

  it("accepts correction issues as a complete business result without a second model attempt", async () => {
    const expected: NaturalLanguageResponse = { schemaVersion: naturalRequest.schemaVersion, outcome: "needs_correction",
      issues: [{ code: "missing_amount", start: 0, end: naturalRequest.text.length }] };
    const state = await serve(expected);
    const response = await state.post();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expected);
    expect(state.requests).toHaveLength(1);
  });

  const invalidCases: Array<[string, (body: Record<string, unknown>, transaction: Record<string, unknown>) => void]> = [
    ["unknown member", (_body, transaction) => { transaction.memberId = "m9"; }],
    ["unknown category", (_body, transaction) => { transaction.categoryId = "c9"; }],
    ["invalid type", (_body, transaction) => { transaction.type = "TRANSFER"; }],
    ["category type mismatch", (_body, transaction) => { transaction.type = "INCOME"; }],
    ["missing type", (_body, transaction) => { delete transaction.type; }],
    ["old version", (body) => { body.schemaVersion = "natural-language-entry.v1"; }],
    ["old field", (body) => { body.expenses = body.transactions; delete body.transactions; }],
    ["fractional fen", (_body, transaction) => { transaction.amountFen = 3500.5; }],
    ["zero amount", (_body, transaction) => { transaction.amountFen = 0; }],
    ["invalid date", (_body, transaction) => { transaction.occurredAt = "2026-02-30T12:00"; }],
    ["invalid range", (_body, transaction) => { transaction.end = naturalRequest.text.length + 1; }],
    ["extra explanation", (_body, transaction) => { transaction.explanation = "PRIVATE-MODEL-OUTPUT"; }],
    ["duplicate evidence", (body, transaction) => { (body.transactions as unknown[]).push({ ...transaction }); }],
    ["incomplete transaction", (_body, transaction) => { delete transaction.amountFen; }],
    ["partial correction", (body) => { body.outcome = "needs_correction"; body.issues = [{ code: "missing_amount", start: 0, end: 2 }]; }],
  ];
  it.each(invalidCases)("rejects %s without partial results or upstream detail", async (_name, mutate) => {
    const body = JSON.parse(JSON.stringify(naturalResponse)) as Record<string, unknown>;
    mutate(body, (body.transactions as Array<Record<string, unknown>>)[0]);
    const state = await serve(body);
    const response = await state.post();
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "invalid_response" });
    expect(state.requests).toHaveLength(1);
  });

  it("authenticates and validates bounded natural-language inputs before provider requests", async () => {
    const state = await serve(naturalResponse);
    expect((await state.post(naturalRequest, "wrong-token")).status).toBe(401);
    for (const input of [
      { ...naturalRequest, householdId: "foreign-id" }, { ...naturalRequest, schemaVersion: "natural-language-entry.v1" },
      { ...naturalRequest, categories: [{ ...naturalRequest.categories[0], type: undefined }] },
      { ...naturalRequest, text: "x".repeat(2001) }, "not JSON",
    ]) expect((await state.post(input)).status).toBe(400);
    expect((await state.post("x".repeat(256 * 1024 + 1))).status).toBe(413);
    expect(state.requests).toHaveLength(0);
    expect(await (await state.post()).json()).toEqual(naturalResponse);
  });
});
