type ExportBridge = { postMessage(message: Record<string, string | number>): Promise<unknown> };
const chunkSize = 32 * 1024;

export async function saveIosExport(blob: Blob, filename: string, signal: AbortSignal) {
  const bridge = (window as Window & { webkit?: { messageHandlers?: { billboardExport?: ExportBridge } } })
    .webkit?.messageHandlers?.billboardExport;
  if (!bridge) return null;
  signal.throwIfAborted();
  const id = await bridge.postMessage({ action: "begin", filename, size: blob.size });
  if (typeof id !== "string") throw new Error("Export could not start");
  const cancel = () => { void bridge.postMessage({ action: "cancel", id }).catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  let finished = false;
  try {
    for (let offset = 0; offset < blob.size; offset += chunkSize) {
      signal.throwIfAborted();
      const bytes = new Uint8Array(await blob.slice(offset, offset + chunkSize).arrayBuffer());
      signal.throwIfAborted();
      const result = await bridge.postMessage({ action: "append", id, bytes: btoa(String.fromCharCode(...bytes)) });
      if (result !== true) throw new Error("Export file could not be written");
    }
    signal.throwIfAborted();
    const result = await bridge.postMessage({ action: "save", id });
    signal.throwIfAborted();
    if (result !== "saved" && result !== "cancelled") throw new Error("Export file could not be saved");
    finished = true;
    return result;
  } finally {
    signal.removeEventListener("abort", cancel);
    if (!finished) cancel();
  }
}
