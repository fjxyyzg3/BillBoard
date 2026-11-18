import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentRuntimes } from "../../agent/provider";

const env = { WHEELMAKER_BASE_URL: "https://hub.example.com/v1", WHEELMAKER_API_KEY: "synthetic-private-key" };
const categories = [{ id: "c0", name: "Food", displayName: "餐饮", type: "EXPENSE" as const }];
const importRequest = {
  schemaVersion: "import-category-agent.v1" as const,
  groups: [{ id: "g0", source: "wechat_pay" as const, transactionType: "EXPENSE" as const,
    primaryCategory: "Dining", secondaryCategory: "", products: ["Lunch"] }], categories,
};
const importResponse = { schemaVersion: importRequest.schemaVersion,
  suggestions: [{ groupId: "g0", action: "map" as const, categoryId: "c0" }] };
const naturalRequest = {
  schemaVersion: "natural-language-entry.v2" as const, text: "午饭 35 元", referenceDateTime: "2026-10-15T12:00",
  categories, members: [{ id: "m0", displayName: "成员一" }], currentMemberId: "m0",
};
const naturalResponse = { schemaVersion: naturalRequest.schemaVersion, outcome: "success" as const,
  transactions: [{ start: 0, end: naturalRequest.text.length, type: "EXPENSE" as const, amountFen: 3500,
    occurredAt: null, memberId: "m0", categoryId: "c0", note: "午饭" }] };

function stubResponse(content: unknown) {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
    object: "response", status: "completed", model: "gpt-6-luna", error: null,
    output: [{ type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(content) }] }],
  })));
  vi.stubGlobal("fetch", fetchImpl);
  return fetchImpl;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("shared WheelMaker provider configuration", () => {
  it("requires private endpoint and key before serving", () => {
    expect(() => createAgentRuntimes({})).toThrow("WHEELMAKER_BASE_URL");
    expect(() => createAgentRuntimes({ WHEELMAKER_BASE_URL: env.WHEELMAKER_BASE_URL })).toThrow("WHEELMAKER_API_KEY");
  });

  it("uses the same Responses service for both tasks without CLI authentication", async () => {
    const classifyFetch = stubResponse(importResponse);
    const runtime = createAgentRuntimes(env);
    expect(runtime.provider).toBe("wheelmaker");
    await expect(runtime.classify(importRequest)).resolves.toEqual(importResponse);
    expect(classifyFetch).toHaveBeenCalledWith(new URL(env.WHEELMAKER_BASE_URL + "/responses"), expect.objectContaining({ redirect: "error" }));
    const parseFetch = stubResponse(naturalResponse);
    await expect(createAgentRuntimes(env).parseExpenses(naturalRequest)).resolves.toEqual(naturalResponse);
    expect(parseFetch).toHaveBeenCalledOnce();
  });

  it("ignores retired provider and fallback settings and never retries a failed request", async () => {
    const fetchImpl = vi.fn(async () => new Response("private-upstream-error", { status: 503 }));
    vi.stubGlobal("fetch", fetchImpl);
    const runtime = createAgentRuntimes({ ...env, IMPORT_AGENT_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "retired-private-key" });
    await expect(runtime.classify(importRequest)).rejects.toMatchObject({ code: "unavailable", message: "unavailable" });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("does not send invalid input or pre-cancelled work upstream", async () => {
    const fetchImpl = stubResponse(importResponse);
    const runtime = createAgentRuntimes(env);
    await expect(runtime.classify({ ...importRequest, categories: [] })).rejects.toThrow();
    await expect(runtime.parseExpenses(naturalRequest, AbortSignal.abort())).rejects.toMatchObject({ code: "cancelled" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
