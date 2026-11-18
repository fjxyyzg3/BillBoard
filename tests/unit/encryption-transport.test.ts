import { expect, it, vi } from "vitest";
import { assertEncryptionTransport } from "@/lib/encryption/transport";
import { readEncryptionBody } from "@/lib/encryption/body";

it("accepts only the trusted HTTPS origin or a loopback development origin", () => {
  expect(() => assertEncryptionTransport(new Headers({ origin: "https://app.example", host: "app.example", "x-forwarded-proto": "https" }))).not.toThrow();
  expect(() => assertEncryptionTransport(new Headers({ origin: "http://127.0.0.1:2500", host: "127.0.0.1:2500", "x-forwarded-proto": "http" }))).not.toThrow();
  const cases: HeadersInit[] = [
    { origin: "http://app.example", host: "app.example", "x-forwarded-proto": "http" },
    { origin: "https://app.example", host: "app.example", "x-forwarded-proto": "http" },
    { origin: "https://other.example", host: "app.example", "x-forwarded-proto": "https" },
    { origin: "https://app.example", host: "app.example", "x-forwarded-proto": "https", "sec-fetch-site": "cross-site" },
  ];
  for (const headers of cases) expect(() => assertEncryptionTransport(new Headers(headers))).toThrow("Forbidden");
});

it("does not begin an unbounded first read for an already cancelled upload", async () => {
  const abort = new AbortController(); abort.abort();
  let cancelled = false;
  const request = new Request("https://app.example/api/household/view", { method: "POST", signal: abort.signal, body: new ReadableStream({ pull() { return new Promise<void>(() => undefined); }, cancel() { cancelled = true; } }), duplex: "half" } as RequestInit);
  await expect(readEncryptionBody(request, 1024)).rejects.toMatchObject({ code: "ENCRYPTION_EXPIRED" });
  expect(cancelled).toBe(true);
});

it.each(["oversized", "cancelled"])("waits for the %s upload reader to actually stop before releasing its caller", async (kind) => {
  const abort = new AbortController();
  let release!: () => void;
  const stopped = new Promise<void>((resolve) => { release = resolve; });
  const cancel = vi.fn(async () => { await stopped; });
  const request = new Request("https://app.example/api/voice/transcribe", {
    method: "POST", signal: abort.signal,
    body: new ReadableStream<Uint8Array>({ start(controller) { if (kind === "oversized") controller.enqueue(new Uint8Array(1025)); }, cancel }),
    duplex: "half",
  } as RequestInit);
  let settled = false;
  const reading = readEncryptionBody(request, 1024).finally(() => { settled = true; });
  const failed = expect(reading).rejects.toMatchObject({ code: kind === "oversized" ? "ENCRYPTION_BUDGET" : "ENCRYPTION_EXPIRED" });
  try {
    if (kind === "cancelled") abort.abort();
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
  } finally { release(); await failed; }
});
