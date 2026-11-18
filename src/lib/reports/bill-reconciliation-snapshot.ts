import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { physicalDb } from "@/lib/db";
import { encryptionDatabase } from "@/lib/encryption/database";
import { getEncryptionContext } from "@/lib/encryption/request-context";
import { MAX_FINANCIAL_SCAN_BYTES } from "@/lib/encryption/financial-queries";
import { authorizeLedgerReadScope } from "@/lib/ledgers/server";
import { authorizeMemberReadScope } from "@/lib/records/member-filter";
import { CMB_SOURCE, WECHAT_PAY_SOURCE, ALIPAY_SOURCE } from "@/lib/imports/types";
import { getCategoryDisplayName, getMemberDisplayName, type Locale } from "@/lib/i18n";
import { BillAnalysisPreparationError } from "./bill-analysis-prepare";
import { resolveBillAnalysisRange } from "./bill-analysis-snapshot";
import type { BillAnalysisScope } from "./bill-analysis-types";
import type { BillAnalysisSession } from "./bill-analysis-store";
import type { BillReconciliationSnapshot, ReconciliationSourceRow } from "./bill-reconciliation-types";

const MAX_ROWS = 10_000;
const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_EVIDENCE_BYTES = 8 * 1024 * 1024;
const MAX_CIPHER_ROW_BYTES = Math.ceil(48 * 1024 * 1024 * 4 / 3) + 16;
const transactionSelection = {
  id: true, ledgerId: true, actorMemberId: true, createdByMemberId: true, clientRequestId: true,
  categoryId: true, type: true, amountFen: true, occurredAt: true, createdAt: true, updatedAt: true,
  note: true, source: true, sourceFingerprint: true, sourceImportedAt: true,
  category: { select: { name: true } }, ledger: { select: { name: true, archivedAt: true } },
  actorMember: { select: { memberName: true, leftAt: true, user: { select: { status: true } } } },
} satisfies Prisma.TransactionSelect;
type Row = Prisma.TransactionGetPayload<{ select: typeof transactionSelection }>;
type Filter = { householdId: string; ids?: string[]; ledgerId?: string; actorMemberId?: string; from?: Date; to?: Date };
const tooLarge = () => new BillAnalysisPreparationError("TOO_LARGE");
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

async function boundedRows(tx: Prisma.TransactionClient, filter: Filter, signal?: AbortSignal, metadata: Prisma.TransactionClient = tx): Promise<Row[]> {
  if (filter.ids?.length === 0) return [];
  if (filter.ids && filter.ids.length > MAX_ROWS) throw tooLarge();
  const encrypted = getEncryptionContext()?.mode === "ENCRYPTED";
  const where = { householdId: filter.householdId, deletedAt: null,
    ...(filter.ids ? { id: { in: filter.ids } } : {}), ...(filter.ledgerId ? { ledgerId: filter.ledgerId } : {}),
    ...(filter.actorMemberId ? { actorMemberId: filter.actorMemberId } : {}),
    ...(!encrypted && filter.from && filter.to ? { occurredAt: { gte: filter.from, lte: filter.to } } : {}),
  };
  const conditions = Prisma.sql`household_id=${filter.householdId} AND deleted_at IS NULL
    ${filter.ids ? Prisma.sql`AND id IN (${Prisma.join(filter.ids)})` : Prisma.empty}
    ${filter.ledgerId ? Prisma.sql`AND ledger_id=${filter.ledgerId}` : Prisma.empty}
    ${filter.actorMemberId ? Prisma.sql`AND actor_member_id=${filter.actorMemberId}` : Prisma.empty}
    ${!encrypted && filter.from && filter.to ? Prisma.sql`AND occurred_at>=${filter.from} AND occurred_at<=${filter.to}` : Prisma.empty}`;
  if (!encrypted) {
    const [budget] = await metadata.$queryRaw<Array<{ count: bigint; bytes: bigint; maxNote: bigint }>>(Prisma.sql`
      SELECT count(*)::bigint AS count, COALESCE(sum(octet_length(note)),0)::bigint AS bytes,
        COALESCE(max(octet_length(note)),0)::bigint AS "maxNote" FROM "Transaction" WHERE ${conditions}`);
    if (budget.count > BigInt(MAX_ROWS) || budget.bytes > BigInt(MAX_INPUT_BYTES) || budget.maxNote > 256n * 1024n) throw tooLarge();
  }
  const result: Row[] = [];
  let cursor: string | undefined, scannedBytes = 0, retainedBytes = 0;
  while (true) {
    signal?.throwIfAborted();
    const pageMetadata = await metadata.$queryRaw<Array<{ id: string; bytes: bigint }>>(Prisma.sql`
      SELECT id, COALESCE(octet_length(encrypted_payload),0)::bigint AS bytes FROM "Transaction"
      WHERE ${conditions} ${cursor ? Prisma.sql`AND id>${cursor}` : Prisma.empty} ORDER BY id ASC LIMIT 500`);
    if (!pageMetadata.length) break;
    let ids: string[] = [], pageBytes = 0;
    const flush = async () => {
      if (!ids.length) return;
      signal?.throwIfAborted();
      const rows = await tx.transaction.findMany({ where: { ...where, id: { in: ids } }, orderBy: { id: "asc" }, take: ids.length, select: transactionSelection });
      for (const row of rows) {
        if (filter.from && filter.to && (row.occurredAt < filter.from || row.occurredAt > filter.to)) continue;
        retainedBytes += Buffer.byteLength(JSON.stringify(row));
        if (result.length >= MAX_ROWS || retainedBytes > 16 * 1024 * 1024 || Buffer.byteLength(row.note ?? "") > 256 * 1024) throw tooLarge();
        result.push(row);
      }
      ids = []; pageBytes = 0;
    };
    for (const item of pageMetadata) {
      if (item.bytes < 0n || item.bytes > BigInt(MAX_CIPHER_ROW_BYTES)) throw tooLarge();
      const bytes = Number(item.bytes);
      scannedBytes += bytes;
      if (scannedBytes > MAX_FINANCIAL_SCAN_BYTES) throw tooLarge();
      if (ids.length && pageBytes + bytes > 4 * 1024 * 1024) await flush();
      ids.push(item.id); pageBytes += bytes;
      if (pageBytes >= 4 * 1024 * 1024) await flush();
    }
    await flush();
    cursor = pageMetadata.at(-1)!.id;
    if (pageMetadata.length < 500) break;
  }
  return result;
}

async function enrichRows(tx: Prisma.TransactionClient, householdId: string, rows: Row[], locale: Locale = "en-US", signal?: AbortSignal, metadata: Prisma.TransactionClient = tx): Promise<ReconciliationSourceRow[]> {
  if (!rows.length) return [];
  const fingerprints = new Set(rows.flatMap((row) => row.sourceFingerprint ? [row.sourceFingerprint] : []));
  const relevantIds = new Set(rows.map((row) => row.id));
  type ImportEvidence = { id: string; sourceFingerprint: string | null; amountFen: number | null; refundOriginalAmountFen: number | null; refundSourceFingerprints: string[]; rawAmount: string | null; skipReason: string | null; updatedAt: Date; status: string; userDecision: string };
  const imports: ImportEvidence[] = [];
  let bytes = 0, cipherBytes = 0, cursor: string | undefined;
  const boundMetadata = (items: Array<{ id: string; bytes: bigint }>) => {
    const chunks: string[][] = [];
    let chunk: string[] = [], chunkBytes = 0;
    for (const item of items) {
      if (item.bytes < 0n || item.bytes > BigInt(MAX_EVIDENCE_BYTES)) throw tooLarge();
      const size = Number(item.bytes);
      cipherBytes += size;
      if (cipherBytes > MAX_EVIDENCE_BYTES) throw tooLarge();
      if (chunk.length && chunkBytes + size > 4 * 1024 * 1024) { chunks.push(chunk); chunk = []; chunkBytes = 0; }
      chunk.push(item.id); chunkBytes += size;
    }
    if (chunk.length) chunks.push(chunk);
    return chunks;
  };
  // Related financial predicates are not metadata pagination in encrypted mode.
  // Resolve completed draft IDs first, then bound payloads before any decryption.
  if (fingerprints.size) {
    let draftCursor: string | undefined;
    while (true) {
      signal?.throwIfAborted();
      const drafts: Array<{ id: string }> = await metadata.importDraft.findMany({ where: { householdId, status: "COMPLETED", ...(draftCursor ? { id: { gt: draftCursor } } : {}) }, orderBy: { id: "asc" }, take: 500, select: { id: true } });
      bytes += Buffer.byteLength(JSON.stringify(drafts));
      if (bytes > MAX_EVIDENCE_BYTES) throw tooLarge();
      if (!drafts.length) break;
      const draftIds = drafts.map((draft) => draft.id);
      let rowCursor: string | undefined;
      while (true) {
        signal?.throwIfAborted();
        const pageMetadata: Array<{ id: string; bytes: bigint }> = await metadata.$queryRaw(Prisma.sql`
          SELECT id, COALESCE(octet_length(encrypted_payload),0)::bigint AS bytes FROM "ImportDraftRow"
          WHERE draft_id IN (${Prisma.join(draftIds)}) ${rowCursor ? Prisma.sql`AND id>${rowCursor}` : Prisma.empty}
          ORDER BY id ASC LIMIT 500`);
        for (const ids of boundMetadata(pageMetadata)) {
          const page = await tx.importDraftRow.findMany({ where: { draftId: { in: draftIds }, id: { in: ids } }, orderBy: { id: "asc" }, take: ids.length,
            select: { id: true, sourceFingerprint: true, amountFen: true, refundOriginalAmountFen: true, refundSourceFingerprints: true, rawAmount: true, skipReason: true, updatedAt: true, status: true, userDecision: true } });
          bytes += Buffer.byteLength(JSON.stringify(page));
          if (bytes > MAX_EVIDENCE_BYTES) throw tooLarge();
          imports.push(...page.filter((row) => (row.sourceFingerprint && fingerprints.has(row.sourceFingerprint)) || row.refundSourceFingerprints.some((value) => fingerprints.has(value))));
        }
        if (pageMetadata.length < 500) break;
        rowCursor = pageMetadata.at(-1)!.id;
      }
      if (drafts.length < 500) break;
      draftCursor = drafts.at(-1)!.id;
    }
  }
  const facts: Array<{ id: string; createdAt: string; definition: unknown }> = [];
  cursor = undefined;
  while (true) {
    signal?.throwIfAborted();
    const pageMetadata: Array<{ id: string; bytes: bigint }> = await metadata.$queryRaw(Prisma.sql`
      SELECT id, COALESCE(octet_length(encrypted_payload),0)::bigint AS bytes FROM "BillReconciliationApplication"
      WHERE household_id=${householdId} AND status='SUCCEEDED' ${cursor ? Prisma.sql`AND id>${cursor}` : Prisma.empty}
      ORDER BY id ASC LIMIT 500`);
    for (const ids of boundMetadata(pageMetadata)) {
      const page = await tx.billReconciliationApplication.findMany({ where: { householdId, status: "SUCCEEDED", id: { in: ids } }, orderBy: { id: "asc" }, take: ids.length, select: { id: true, createdAt: true, definition: true } });
      bytes += Buffer.byteLength(JSON.stringify(page));
      if (bytes > MAX_EVIDENCE_BYTES) throw tooLarge();
      for (const receipt of page) {
        const definition = receipt.definition;
        if (object(definition) && Array.isArray(definition.transactionIds) && definition.transactionIds.some((id) => typeof id === "string" && relevantIds.has(id))) facts.push({ id: receipt.id, createdAt: receipt.createdAt.toISOString(), definition });
      }
    }
    if (pageMetadata.length < 500) break;
    cursor = pageMetadata.at(-1)!.id;
  }
  const requestIds = [...new Set(rows.flatMap((row) => row.clientRequestId ? [row.clientRequestId] : []))];
  const naturalLanguage = new Set<string>();
  for (let offset = 0; offset < requestIds.length; offset += 500) {
    const requests = await metadata.naturalLanguageRequest.findMany({ where: { householdId, clientRequestId: { in: requestIds.slice(offset, offset + 500) } }, select: { clientRequestId: true } });
    for (const request of requests) naturalLanguage.add(request.clientRequestId);
  }
  const importsByFingerprint = new Map<string, ImportEvidence[]>();
  for (const item of imports) for (const fingerprint of new Set([item.sourceFingerprint, ...item.refundSourceFingerprints])) if (fingerprint) {
    const group = importsByFingerprint.get(fingerprint) ?? []; group.push(item); importsByFingerprint.set(fingerprint, group);
  }
  const factsById = new Map<string, typeof facts>();
  for (const item of facts) if (object(item.definition) && Array.isArray(item.definition.transactionIds)) for (const id of item.definition.transactionIds) if (typeof id === "string" && relevantIds.has(id)) {
    const group = factsById.get(id) ?? []; group.push(item); factsById.set(id, group);
  }
  return rows.map((row): ReconciliationSourceRow => {
    const evidence = row.sourceFingerprint ? importsByFingerprint.get(row.sourceFingerprint) ?? [] : [];
    const previous = factsById.get(row.id) ?? [];
    const consumed = evidence.some((item) => !!row.sourceFingerprint && item.refundSourceFingerprints.includes(row.sourceFingerprint))
      || previous.some((item) => object(item.definition) && Array.isArray(item.definition.consumedIncomeIds) && item.definition.consumedIncomeIds.includes(row.id));
    // Importers do not retain a complete proof of every original/refund relation.
    // Missing metadata is never treated as proof that an imported amount is gross.
    const offsetEvidence = consumed ? "consumed" : row.source || (row.clientRequestId && naturalLanguage.has(row.clientRequestId)) ? "unknown" : "unconsumed";
    const aggregated = row.source === WECHAT_PAY_SOURCE && evidence.some((item) => item.skipReason?.includes("REFUND") && item.refundOriginalAmountFen === null);
    const dateOnly = row.source === CMB_SOURCE;
    return {
      id: row.id, ledgerId: row.ledgerId, actorMemberId: row.actorMemberId, createdByMemberId: row.createdByMemberId, clientRequestId: row.clientRequestId,
      categoryId: row.categoryId, categoryName: getCategoryDisplayName(row.category.name, locale),
      ledgerLabel: row.ledger.name, memberLabel: getMemberDisplayName(row.actorMember.memberName, !!row.actorMember.leftAt || row.actorMember.user.status !== "ACTIVE", locale),
      type: row.type, amountFen: row.amountFen, occurredAt: row.occurredAt.toISOString(), createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
      note: row.note, source: row.source, sourceFingerprint: row.sourceFingerprint, sourceImportedAt: row.sourceImportedAt?.toISOString() ?? null,
      archivedAt: row.ledger.archivedAt?.toISOString() ?? null,
      // Existing rows lack immutable per-row original time precision, including edited imports.
      timePrecision: dateOnly ? "day" : "unknown", timeSupplemented: dateOnly, aggregated,
      offsetEvidence, dependencyHash: hash({ imports: evidence, applications: previous, naturalLanguage: !!row.clientRequestId && naturalLanguage.has(row.clientRequestId), sourceKind: row.source === ALIPAY_SOURCE ? "net-capable" : row.source }),
    };
  });
}

export async function loadReconciliationRows(tx: Prisma.TransactionClient, householdId: string, ids: string[], physical?: Prisma.TransactionClient): Promise<ReconciliationSourceRow[]> {
  return enrichRows(tx, householdId, await boundedRows(tx, { householdId, ids }, undefined, physical ?? tx), "en-US", undefined, physical ?? tx);
}

export async function queryBillReconciliationSnapshot(session: BillAnalysisSession, scope: BillAnalysisScope, locale: Locale, now = new Date(), signal?: AbortSignal): Promise<BillReconciliationSnapshot> {
  const periods = resolveBillAnalysisRange(scope, now);
  signal?.throwIfAborted();
  return physicalDb.$transaction(async (physical) => {
    const tx = encryptionDatabase(physical, true);
    await authorizeLedgerReadScope(tx, session, scope.ledgerId ?? undefined);
    await authorizeMemberReadScope(tx, session.householdId, scope.actorMemberId ?? undefined);
    const household = await tx.household.findUniqueOrThrow({ where: { id: session.householdId }, select: { timezone: true } });
    if (household.timezone !== "Asia/Shanghai") throw new BillAnalysisPreparationError("INVALID");
    const [{ captured }] = await tx.$queryRaw<Array<{ captured: Date }>>`SELECT transaction_timestamp() AS captured`;
    const rows = await boundedRows(tx, { householdId: session.householdId, ledgerId: scope.ledgerId ?? undefined, actorMemberId: scope.actorMemberId ?? undefined, from: periods.bounds.from, to: periods.bounds.to }, signal, physical);
    const enriched = await enrichRows(tx, session.householdId, rows, locale, signal, physical);
    signal?.throwIfAborted();
    return { scope, locale, range: periods.range, snapshotAt: captured.toISOString(), rows: enriched };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 10_000, timeout: 120_000 });
}
