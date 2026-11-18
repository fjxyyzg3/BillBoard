import { AsyncLocalStorage } from "node:async_hooks";
import type { AppSessionUser } from "@/auth";
import { getEncryptionContext } from "./request-context";
import { withHouseholdEncryption } from "./request";
import type { EncryptionInput } from "./types";

export function holdEncryptionResponse(original: Response) {
  const context = getEncryptionContext();
  if (!context || !original.body) return { response: original, completion: Promise.resolve() };
  const enter = AsyncLocalStorage.snapshot();
  const reader = original.body.getReader();
  let settle!: () => void;
  const completion = new Promise<void>((resolve) => { settle = resolve; });
  let timer: ReturnType<typeof setTimeout>;
  let finished = false;
  let stopping: Promise<void> | undefined;
  const finish = () => { if (!finished) { finished = true; clearTimeout(timer); settle(); } };
  const stop = (reason?: unknown) => {
    stopping ??= Promise.resolve().then(() => reader.cancel(reason)).finally(finish);
    return stopping;
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      timer = setTimeout(() => {
        void enter(async () => {
          await stop().catch(() => undefined);
          try { controller.error(new Error("ENCRYPTION_EXPIRED")); } catch { /* A settled stream already has its terminal state. */ }
        });
      }, Math.max(1, context.expiresAt - Date.now()));
      timer.unref?.();
    },
    pull(controller) {
      return enter(async () => {
        try {
          getEncryptionContext();
          const { value, done } = await reader.read();
          if (value) controller.enqueue(value);
          if (done) {
            if (stopping) await stopping;
            else finish();
            try { controller.close(); } catch { /* Cancellation may already have closed the stream. */ }
          }
        } catch {
          try { controller.error(new Error("ENCRYPTION_UNAVAILABLE")); } catch { /* Cancellation may already have settled the controller. */ }
          await stop().catch(() => undefined);
        }
      });
    },
    cancel(reason) { return enter(() => stop(reason)); },
  });
  return { response: new Response(stream, { status: original.status, statusText: original.statusText, headers: original.headers }), completion };
}

export function withHouseholdEncryptionResponse(input: EncryptionInput | undefined, work: (session: AppSessionUser) => Promise<Response>): Promise<Response> {
  let ready!: (response: Response) => void, reject!: (error: unknown) => void;
  const output = new Promise<Response>((resolve, fail) => { ready = resolve; reject = fail; });
  void withHouseholdEncryption(input, async (session) => {
    const held = holdEncryptionResponse(await work(session));
    ready(held.response);
    await held.completion;
  }).catch(reject);
  return output;
}
