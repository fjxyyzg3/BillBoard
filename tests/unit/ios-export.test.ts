import { afterEach, expect, it, vi } from "vitest";
import { saveIosExport } from "@/lib/ios-export";

afterEach(() => vi.unstubAllGlobals());

it("waits for the native save result and sends a bounded copy of the existing workbook", async () => {
  const workbook = Buffer.alloc(80 * 1024, 31);
  const pieces: Buffer[] = [];
  const bridge = vi.fn(async (message: Record<string, string | number>) => {
    if (message.action === "begin") return "transfer";
    if (message.action === "append") {
      pieces.push(Buffer.from(String(message.bytes), "base64"));
      expect(pieces.at(-1)?.length).toBeLessThanOrEqual(32 * 1024);
      return true;
    }
    return "cancelled";
  });
  vi.stubGlobal("window", { webkit: { messageHandlers: { billboardExport: { postMessage: bridge } } } });
  expect(await saveIosExport(new Blob([workbook]), "billboard-records_2026-01-01_2026-01-02.xlsx", new AbortController().signal)).toBe("cancelled");
  expect(Buffer.concat(pieces)).toEqual(workbook);
  expect(bridge.mock.calls.at(-1)?.[0]).toEqual({ action: "save", id: "transfer" });
});

it("cancels the native transfer when the original page operation ends", async () => {
  const controller = new AbortController();
  const bridge = vi.fn(async (message: Record<string, string | number>) => {
    if (message.action === "begin") return "transfer";
    if (message.action === "append") controller.abort();
    return true;
  });
  vi.stubGlobal("window", { webkit: { messageHandlers: { billboardExport: { postMessage: bridge } } } });
  await expect(saveIosExport(new Blob(["workbook"]), "export.xlsx", controller.signal)).rejects.toThrow();
  expect(bridge.mock.calls.map(([message]) => message.action)).toContain("cancel");
  expect(bridge.mock.calls.map(([message]) => message.action)).not.toContain("save");
});
