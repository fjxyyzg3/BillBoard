import { expect, it } from "vitest";
import { holdEncryptionResponse } from "@/lib/encryption/response";
import { getEncryptionContext, runEncryptionContext } from "@/lib/encryption/request-context";
import { createHouseholdCode, createKeyRing } from "@/lib/encryption/crypto";

it("keeps only the admitted request context through stream consumption and clears it after cancellation settles", async () => {
  const ctx = { session: { id: "response-user", householdId: "response-family", memberId: "response-member", appSessionId: "response-session", role: "OWNER" as const }, mode: "ENCRYPTED" as const, configMode: "ENCRYPTED" as const, revision: 1, ring: createKeyRing(createHouseholdCode("response-family")), disposed: false, readOnly: true, expiresAt: Date.now() + 60000 };
  let respond!: (response: Response) => void;
  const ready = new Promise<Response>((resolve) => { respond = resolve; });
  let cancelled = false;
  const execution = runEncryptionContext(ctx, async () => {
    const held = holdEncryptionResponse(new Response(new ReadableStream({ pull(controller) { expect(getEncryptionContext()?.session.householdId).toBe("response-family"); controller.enqueue(new Uint8Array([1])); }, async cancel() { await Promise.resolve(); cancelled = true; } })));
    respond(held.response);
    await held.completion;
  });
  const response = await ready, reader = response.body!.getReader();
  expect(getEncryptionContext()).toBeUndefined();
  expect((await reader.read()).value).toEqual(new Uint8Array([1]));
  expect(ctx.disposed).toBe(false);
  await reader.cancel(); await execution;
  expect(cancelled).toBe(true); expect(ctx.disposed).toBe(true); expect(ctx.ring).toBeNull();
});

it("waits for asynchronous cancellation cleanup before clearing the key context", async () => {
  const ctx = { session: { id: "response-user", householdId: "response-family", memberId: "response-member", appSessionId: "response-session", role: "OWNER" as const }, mode: "ENCRYPTED" as const, configMode: "ENCRYPTED" as const, revision: 1, ring: createKeyRing(createHouseholdCode("response-family")), disposed: false, readOnly: true, expiresAt: Date.now() + 60000 };
  let release!: () => void, respond!: (response: Response) => void, started!: () => void;
  const cleanup = new Promise<void>((resolve) => { release = resolve; });
  const cancelling = new Promise<void>((resolve) => { started = resolve; });
  const ready = new Promise<Response>((resolve) => { respond = resolve; });
  const execution = runEncryptionContext(ctx, async () => {
    const held = holdEncryptionResponse(new Response(new ReadableStream({ pull() { return new Promise<void>(() => undefined); }, async cancel() { started(); await cleanup; } })));
    respond(held.response); await held.completion;
  });
  const reader = (await ready).body!.getReader();
  const pendingRead = reader.read();
  const cancelled = reader.cancel();
  await cancelling;
  await new Promise((resolve) => setImmediate(resolve));
  const disposedBeforeCleanup = ctx.disposed;
  release(); await cancelled; await pendingRead; await execution;
  expect(disposedBeforeCleanup).toBe(false);
  expect(ctx.disposed).toBe(true);
});
