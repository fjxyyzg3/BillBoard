import { describe, expect, it } from "vitest";

import {
  IMPORT_AGENT_SCHEMA_VERSION,
  MAX_AGENT_GROUPS,
  validateAgentRequest,
  validateAgentResponse,
} from "@/lib/imports/agent-protocol";

const request = {
  schemaVersion: IMPORT_AGENT_SCHEMA_VERSION,
  groups: [
    { id: "g0", source: "wechat_pay", transactionType: "EXPENSE", primaryCategory: "商户消费", secondaryCategory: "餐厅", products: ["午餐"] },
    { id: "g1", source: "alipay", transactionType: "INCOME", primaryCategory: "转账", secondaryCategory: "", products: [] },
  ],
  categories: [
    { id: "c0", name: "Dining", displayName: "餐饮", type: "EXPENSE" },
    { id: "c1", name: "Salary", displayName: "工资", type: "INCOME" },
  ],
};
const response = (suggestions: unknown[]) => ({ schemaVersion: IMPORT_AGENT_SCHEMA_VERSION, suggestions });

describe("import agent protocol", () => {
  it("distinguishes a valid category, explicit ignore and uncertainty", () => {
    const validated = validateAgentRequest(request);
    expect(validateAgentResponse(validated, response([
      { groupId: "g0", action: "map", categoryId: "c0" },
      { groupId: "g1", action: "ignore" },
    ])).suggestions).toHaveLength(2);
    expect(validateAgentResponse(validated, response([{ groupId: "g0", action: "uncertain" }])).suggestions)
      .toEqual([{ groupId: "g0", action: "uncertain" }]);
    expect(validateAgentResponse(validated, response([])).suggestions).toEqual([]);
  });

  it.each([
    [{ groupId: "g0", categoryId: null }],
    [{ groupId: "g0", action: "map" }],
    [{ groupId: "g0", action: "ignore", categoryId: null }],
    [{ groupId: "g0", action: "uncertain", categoryId: "c0" }],
    [{ groupId: "g0", action: "map", categoryId: "c1" }],
    [{ groupId: "g0", action: "map", categoryId: "c99" }],
    [{ groupId: "g99", action: "ignore" }],
    [{ groupId: "g0", action: "ignore" }, { groupId: "g0", action: "uncertain" }],
  ])("rejects invalid or ambiguous suggestions: %j", (...suggestions) => {
    expect(() => validateAgentResponse(validateAgentRequest(request), response(suggestions))).toThrow();
  });

  it("rejects extra data, identifiers, oversized batches and fields", () => {
    const invalid = [
      { ...request, householdId: "private-household" },
      { ...request, groups: [{ ...request.groups[0], note: "private raw note" }] },
      { ...request, groups: [{ ...request.groups[0], amountFen: 100 }] },
      { ...request, groups: [{ ...request.groups[0], id: "real-draft-id" }] },
      { ...request, groups: [request.groups[0], request.groups[0]] },
      { ...request, categories: [request.categories[0], request.categories[0]] },
      { ...request, groups: [{ ...request.groups[0], primaryCategory: "x".repeat(201) }] },
      { ...request, groups: [{ ...request.groups[0], products: ["a", "b", "c", "d"] }] },
      { ...request, groups: Array.from({ length: MAX_AGENT_GROUPS + 1 }, (_, i) => ({ ...request.groups[0], id: `g${i}` })) },
    ];
    for (const input of invalid) expect(() => validateAgentRequest(input)).toThrow();
  });
});
