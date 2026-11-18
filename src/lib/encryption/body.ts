import { EncryptionRequestError } from "./types";

export async function readEncryptionBody(request: Request, maxBytes: number, signal = request.signal): Promise<Buffer> {
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) throw new EncryptionRequestError("ENCRYPTION_BUDGET");
  if (!request.body) throw new EncryptionRequestError("ENCRYPTION_INVALID");
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
  let stopping: Promise<void> | undefined;
  const cancel = () => { stopping ??= reader.cancel().catch(() => undefined); return stopping; };
  const onAbort = () => { void cancel(); };
  bounded.addEventListener("abort", onAbort, { once: true });
  let bytes = 0;
  try {
    while (true) {
      if (bounded.aborted) throw new EncryptionRequestError("ENCRYPTION_EXPIRED");
      const { value, done } = await reader.read();
      if (bounded.aborted) throw new EncryptionRequestError("ENCRYPTION_EXPIRED");
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new EncryptionRequestError("ENCRYPTION_BUDGET");
      chunks.push(value);
    }
    return Buffer.concat(chunks, bytes);
  } finally { bounded.removeEventListener("abort", onAbort); await cancel(); reader.releaseLock(); }
}
