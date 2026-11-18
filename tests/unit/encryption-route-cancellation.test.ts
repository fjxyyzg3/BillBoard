import { beforeEach, expect, it, vi } from "vitest";
import { POST as changeEncryption } from "@/app/api/household/encryption/route";
import { POST as submitEntry } from "@/app/api/voice/entry/route";
import { POST as exportRecords } from "@/app/api/records/export/route";

const { accept } = vi.hoisted(() => ({ accept: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ requireAppSession: vi.fn(async () => ({ id: "user", appSessionId: "original-session", householdId: "household", memberId: "member" })) }));
vi.mock("@/lib/encryption/service", () => ({ abortEncryption: accept, batchEncryption: accept, commitEncryption: accept, encryptionMaterials: accept, prepareEncryption: accept, queryEncryption: accept }));
vi.mock("@/lib/encryption/request", () => ({ getHouseholdEncryptionStatus: accept, parseEncryptionInput: accept, withHouseholdEncryption: accept }));
vi.mock("@/lib/encryption/response", () => ({ withHouseholdEncryptionResponse: accept }));
vi.mock("@/lib/transactions/natural-language-service", () => ({ queryNaturalLanguageEntryForSession: accept, submitNaturalLanguageEntryForSession: accept }));
vi.mock("@/lib/exports/service", async () => {
  const { RecordExportError } = await import("@/lib/exports/input");
  return { generateRecordExport: accept, recordExportError: (error: unknown) => error instanceof RecordExportError ? error : new RecordExportError("unavailable") };
});

beforeEach(() => { accept.mockClear(); });

const routes = [
  { name: "encryption", path: "/api/household/encryption", post: changeEncryption, limit: 7 * 1024 * 1024, overflowStatus: 413, abortedStatus: 409 },
  { name: "entry", path: "/api/voice/entry", post: submitEntry, limit: 16 * 1024, overflowStatus: 413, abortedStatus: 499 },
  { name: "export", path: "/api/records/export", post: exportRecords, limit: 4096, overflowStatus: 400, abortedStatus: 499 },
];

for (const route of routes) it.each(["overflow", "declared", "abort"])(`waits for the original %s body cancellation before returning from ${route.name}`, async (kind) => {
  const abort = new AbortController();
  let release!: () => void;
  const stopped = new Promise<void>((resolve) => { release = resolve; });
  const cancel = vi.fn(async () => { await stopped; });
  const request = new Request(`https://app.example${route.path}`, {
    method: "POST", signal: abort.signal,
    headers: { host: "app.example", origin: "https://app.example", "content-type": "application/json", ...(kind === "declared" ? { "content-length": String(route.limit + 1) } : {}) },
    body: new ReadableStream<Uint8Array>({ start(controller) { if (kind === "overflow") controller.enqueue(new Uint8Array(route.limit + 1)); }, cancel }),
    duplex: "half",
  } as RequestInit);
  let settled = false;
  const pending = route.post(request).finally(() => { settled = true; });
  try {
    if (kind === "abort") { await vi.waitFor(() => expect(request.body?.locked).toBe(true)); abort.abort(); }
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(accept).not.toHaveBeenCalled();
  } finally { release(); }
  expect((await pending).status).toBe(kind === "abort" ? route.abortedStatus : route.overflowStatus);
  expect(cancel).toHaveBeenCalledOnce();
});
