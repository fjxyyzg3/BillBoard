import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ImportAgentRequest, ImportAgentResponse } from "../../../src/lib/imports/agent-protocol";
import type { NaturalLanguageRequest, NaturalLanguageResponse } from "../../../src/lib/transactions/natural-language-protocol";

export const baseUrl = "https://hub.example.com/v1";
export const apiKey = "synthetic-wheelmaker-key";
export const importRequest: ImportAgentRequest = {
  schemaVersion: "import-category-agent.v1",
  groups: [0, 1, 2].map((index) => ({
    id: `g${index}`, source: "wechat_pay", transactionType: "EXPENSE",
    primaryCategory: "Dining", secondaryCategory: "", products: ["Lunch"],
  })),
  categories: [{ id: "c0", name: "Food", displayName: "餐饮", type: "EXPENSE" }],
};
export const importResponse: ImportAgentResponse = {
  schemaVersion: importRequest.schemaVersion,
  suggestions: [
    { groupId: "g0", action: "map", categoryId: "c0" },
    { groupId: "g1", action: "ignore" },
    { groupId: "g2", action: "uncertain" },
  ],
};
export const naturalRequest: NaturalLanguageRequest = {
  schemaVersion: "natural-language-entry.v2", text: "午饭 35 元", referenceDateTime: "2026-10-13T12:00",
  categories: importRequest.categories, members: [{ id: "m0", displayName: "成员一" }], currentMemberId: "m0",
};
export const naturalResponse: NaturalLanguageResponse = {
  schemaVersion: naturalRequest.schemaVersion, outcome: "success",
  transactions: [{ start: 0, end: naturalRequest.text.length, type: "EXPENSE", amountFen: 3500,
    occurredAt: null, memberId: "m0", categoryId: "c0", note: "午饭" }],
};

export function completion(value: unknown, model = "gpt-6-luna") {
  return {
    id: "resp_fixture", object: "response", status: "completed", model, error: null, incomplete_details: null,
    output: [{ type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(value) }] }],
  };
}

export function sendJson(response: ServerResponse, body: unknown, status = 200) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

export async function closeServer(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

export interface CapturedRequest {
  method?: string;
  path?: string;
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
}

type FixtureReply = (request: CapturedRequest, response: ServerResponse) => void | Promise<void>;

export async function createWheelMakerFixture(reply: FixtureReply) {
  const requests: CapturedRequest[] = [];
  const targets: URL[] = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const captured = { method: request.method, path: request.url, headers: request.headers,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> };
      requests.push(captured);
      await reply(captured, response);
    } catch {
      response.destroy();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // Keep production HTTPS validation intact; only the test transport maps to loopback.
  const fetchImpl: typeof fetch = (input, init) => {
    const target = new URL(input instanceof Request ? input.url : String(input));
    targets.push(target);
    return fetch(new URL(target.pathname + target.search, origin), init);
  };
  return { requests, targets, fetchImpl, close: () => closeServer(server) };
}
