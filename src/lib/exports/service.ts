import { constants, type Stats } from "node:fs";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import { Prisma } from "@prisma/client";
import type { HouseholdSession } from "@/lib/auth/household-context";
import { authorizeLedgerReadScope } from "@/lib/ledgers/server";
import { authorizeMemberReadScope } from "@/lib/records/member-filter";
import { db } from "@/lib/db";
import { acquireResourceLease, assertResourceLease, releaseResourceLease, ResourceBusyError, ResourceExpiredError } from "@/lib/resources/admission";
import { RecordExportError, type RecordExportInput } from "./input";
import { createRecordExportFile, RECORD_EXPORT_TTL_MS } from "./temp-file";
import { writeRecordExportWorkbook, type RecordExportRow } from "./workbook";
import { isEncryptedRequest } from "@/lib/encryption/request-context";
import { decryptExportFile, ENCRYPTED_EXPORT_OVERHEAD } from "./encrypted-file";

type ExportSession = HouseholdSession & { id: string; appSessionId: string };
const BATCH_SIZE = 500;
const GENERATION_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 110_000;

export function recordExportError(error: unknown): RecordExportError {
  if (error instanceof RecordExportError) return error;
  if (error instanceof ResourceBusyError) return new RecordExportError("busy");
  if (error instanceof ResourceExpiredError) return new RecordExportError("timeout");
  if (error instanceof Error && ["Unauthorized", "Ledger is unavailable"].includes(error.message)) return new RecordExportError("unauthorized");
  return new RecordExportError("unavailable");
}

function sameSession(left: ExportSession, right: ExportSession) {
  return left.id === right.id && left.appSessionId === right.appSessionId
    && left.householdId === right.householdId && left.memberId === right.memberId;
}

function sameFile(left: Stats, right: Stats) { return left.dev === right.dev && left.ino === right.ino && left.size === right.size; }

export async function generateRecordExport(session: ExportSession, input: RecordExportInput, options: { signal?: AbortSignal } = {}) {
  if (!session.id || !session.appSessionId) throw new RecordExportError("unauthorized");
  if (options.signal?.aborted) throw new RecordExportError("cancelled");
  const lease = await db.$transaction(async (tx) => {
    await authorizeLedgerReadScope(tx, session, input.ledgerId);
    await authorizeMemberReadScope(tx, session.householdId, input.actorMemberId);
    return acquireResourceLease(tx, session, "export");
  }, { maxWait: 10_000, timeout: 15_000 }).catch((error) => { throw recordExportError(error); });
  const startedAt = Date.now();
  const generationDeadline = AbortSignal.timeout(GENERATION_TIMEOUT_MS);
  const cancelled = new AbortController();
  const signal = AbortSignal.any([lease.signal, cancelled.signal, ...(options.signal ? [options.signal] : [])]);
  const generationSignal = AbortSignal.any([signal, generationDeadline]);
  let temporary: Awaited<ReturnType<typeof createRecordExportFile>> | undefined;
  let handle: fs.FileHandle | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let downloadTimer: ReturnType<typeof setTimeout> | undefined;
  let cleanupRetryTimer: ReturnType<typeof setTimeout> | undefined;
  let disposal: Promise<void> | undefined;
  let claimed = false;
  let reading: Promise<unknown> = Promise.resolve();
  const encrypted = isEncryptedRequest();
  const fileKey = randomBytes(32);
  let openedBytes: Buffer | undefined;
  const abortDownload = () => { void dispose().catch(() => undefined); };

  function checkSignal() {
    if (options.signal?.aborted || cancelled.signal.aborted) throw new RecordExportError("cancelled");
    if (lease.signal.aborted || Date.now() - startedAt >= RECORD_EXPORT_TTL_MS) throw new RecordExportError("timeout");
  }

  async function recheck() {
    checkSignal();
    await db.$transaction(async (tx) => {
      await authorizeLedgerReadScope(tx, session, input.ledgerId);
      await authorizeMemberReadScope(tx, session.householdId, input.actorMemberId);
      await assertResourceLease(tx, lease);
    });
  }

  async function dispose() {
    signal.removeEventListener("abort", abortDownload);
    cancelled.abort();
    disposal ??= (async () => {
      clearTimeout(expiryTimer);
      clearTimeout(downloadTimer);
      clearTimeout(cleanupRetryTimer);
      await reading.catch(() => undefined);
      await handle?.close();
      handle = undefined;
      openedBytes?.fill(0); openedBytes = undefined; fileKey.fill(0);
      // Keep the resource occupied if private cleanup fails; its lease still expires.
      await temporary?.dispose();
      await releaseResourceLease(lease);
    })().catch((error) => {
      disposal = undefined;
      const remaining = RECORD_EXPORT_TTL_MS - (Date.now() - startedAt);
      if (remaining > 0 && !lease.signal.aborted) {
        cleanupRetryTimer = setTimeout(() => { void dispose().catch(() => undefined); }, Math.min(1000, remaining));
        cleanupRetryTimer.unref?.();
      }
      throw error;
    });
    return disposal;
  }

  try {
    temporary = await createRecordExportFile();
    const filename = temporary.filename;
    const result = await db.$transaction(async (tx) => {
      async function* rows(): AsyncGenerator<RecordExportRow> {
        let cursor: string | undefined;
        while (true) {
          if (generationSignal.aborted) throw new RecordExportError(options.signal?.aborted ? "cancelled" : "timeout");
          await recheck();
          const batch = await tx.transaction.findMany({
            where: {
              householdId: session.householdId, deletedAt: null,
              ...(input.ledgerId ? { ledgerId: input.ledgerId } : {}),
              ...(input.actorMemberId ? { actorMemberId: input.actorMemberId } : {}),
              ...(!encrypted ? { occurredAt: { gte: input.range.from, lte: input.range.to } } : {}),
              ...(cursor ? { id: { gt: cursor } } : {}),
            },
            orderBy: { id: "asc" }, take: BATCH_SIZE,
            select: {
              id: true, amountFen: true, occurredAt: true, note: true, type: true, source: true,
              ledger: { select: { name: true, archivedAt: true } },
              category: { select: { name: true } },
              actorMember: { select: { memberName: true, leftAt: true, user: { select: { status: true } } } },
              createdByMember: { select: { memberName: true, leftAt: true, user: { select: { status: true } } } },
            },
          });
          for (const row of batch) {
            if (encrypted && (row.occurredAt < input.range.from || row.occurredAt > input.range.to)) continue;
            yield {
            ledgerName: row.ledger.name, ledgerArchived: row.ledger.archivedAt !== null,
            actorMemberName: row.actorMember.memberName, actorMemberInactive: row.actorMember.leftAt !== null || row.actorMember.user.status !== "ACTIVE",
            createdByMemberName: row.createdByMember.memberName, createdByMemberInactive: row.createdByMember.leftAt !== null || row.createdByMember.user.status !== "ACTIVE",
            type: row.type, categoryName: row.category.name, amountFen: row.amountFen,
            occurredAt: row.occurredAt, note: row.note, source: row.source,
            };
          }
          if (batch.length < BATCH_SIZE) break;
          cursor = batch[batch.length - 1].id;
        }
      }
      return writeRecordExportWorkbook(filename, rows(), input.locale, { signal: generationSignal, encryptionKey: fileKey });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 5_000, timeout: GENERATION_TIMEOUT_MS + 5_000 });
    await recheck();
    await temporary.check();
    const generatedStat = await fs.lstat(filename);
    if (!generatedStat.isFile() || generatedStat.isSymbolicLink() || generatedStat.size !== result.byteLength + ENCRYPTED_EXPORT_OVERHEAD) throw new RecordExportError("unavailable");
    expiryTimer = setTimeout(() => { void dispose().catch(() => undefined); }, Math.max(1, RECORD_EXPORT_TTL_MS - (Date.now() - startedAt)));
    expiryTimer.unref?.();
    signal.addEventListener("abort", abortDownload, { once: true });

    return {
      rowCount: result.rowCount,
      filename: `billboard-records_${input.from}_${input.to}.xlsx`,
      dispose,
      async claim(current: ExportSession) {
        try {
          if (claimed || !sameSession(session, current)) throw new RecordExportError("unauthorized");
          checkSignal();
          claimed = true;
          await recheck();
          await temporary!.check();
          handle = await fs.open(/* turbopackIgnore: true */ filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
          if (!sameFile(generatedStat, await handle.stat())) throw new RecordExportError("unavailable");
          openedBytes = decryptExportFile(await handle.readFile(), fileKey);
          if (openedBytes.length !== result.byteLength) throw new RecordExportError("unavailable");
          downloadTimer = setTimeout(() => { void dispose().catch(() => undefined); }, DOWNLOAD_TIMEOUT_MS);
          downloadTimer.unref?.();
          let offset = 0;
          const body = new ReadableStream<Uint8Array>({
            async pull(controller) {
              let bytes: Buffer | undefined;
              try {
                reading = (async () => {
                  await recheck();
                  if (!handle || !openedBytes) throw new RecordExportError("timeout");
                  const length = Math.min(128 * 1024, result.byteLength - offset);
                  bytes = Buffer.from(openedBytes.subarray(offset, offset + length)); offset += length;
                })();
                await reading;
                if (offset >= result.byteLength) await dispose();
                if (bytes?.length) controller.enqueue(bytes);
                if (offset >= result.byteLength) controller.close();
              } catch (error) {
                controller.error(recordExportError(error));
                await dispose().catch(() => undefined);
              }
            },
            async cancel() { await dispose(); },
          });
          return { body, byteLength: result.byteLength };
        } catch (error) {
          await dispose().catch(() => undefined);
          throw recordExportError(error);
        }
      },
    };
  } catch (error) {
    const timedOut = (generationDeadline.aborted || lease.signal.aborted) && !options.signal?.aborted;
    await dispose().catch(() => undefined);
    if (timedOut) throw new RecordExportError("timeout");
    throw recordExportError(error);
  }
}
