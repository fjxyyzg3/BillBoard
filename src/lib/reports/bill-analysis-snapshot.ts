import { Prisma } from "@prisma/client";
import type { Locale } from "@/lib/i18n";
import { encryptionDatabase } from "@/lib/encryption/database";
import { getEncryptionContext } from "@/lib/encryption/request-context";
import { MAX_FINANCIAL_SCAN_BYTES } from "@/lib/encryption/financial-queries";
import { authorizeLedgerReadScope } from "@/lib/ledgers/server";
import { authorizeMemberReadScope } from "@/lib/records/member-filter";
import { billAnalysisScopeSchema, MAX_BILL_ANALYSIS_BODY_BYTES, MAX_BILL_ANALYSIS_INPUT_BYTES, MAX_BILL_ANALYSIS_ROWS } from "./bill-analysis-protocol";
import { BillAnalysisPreparationError, type BillAnalysisSourceRow, type BillAnalysisSourceSnapshot } from "./bill-analysis-prepare";
import { getReportComparisonBounds, getReportRangeBounds, type ReportRange } from "./report-range";
import type { BillAnalysisScope } from "./bill-analysis-types";
import type { BillAnalysisSession } from "./bill-analysis-store";

function shanghaiDate(value: Date) { return new Date(value.getTime() + 8 * 3_600_000).toISOString().slice(0, 10); }
const serialize = (value: { from: Date; to: Date }) => ({ from: shanghaiDate(value.from), to: shanghaiDate(value.to) });
const MAX_SOURCE_BYTES = 16 * 1024 * 1024;
const CIPHER_PAGE_BYTES = 4 * 1024 * 1024;
// BBE1 framing base64-encodes the existing 48 MiB maximum entity envelope.
const MAX_CIPHER_ROW_BYTES = Math.ceil(48 * 1024 * 1024 * 4 / 3) + 16;
const rowSelection = { id: true, ledgerId: true, actorMemberId: true, occurredAt: true, type: true, amountFen: true,
  categoryId: true, category: { select: { name: true } } } satisfies Prisma.TransactionSelect;
type SnapshotRow = Prisma.TransactionGetPayload<{ select: typeof rowSelection }> & { note?: string | null };

export function resolveBillAnalysisRange(scope: BillAnalysisScope, now: Date) {
  billAnalysisScopeSchema.parse(scope);
  const selection = { mode: scope.mode, month: scope.mode === "month" ? scope.period : `${scope.period}-01`, year: scope.period.slice(0, 4) };
  const bounds = getReportRangeBounds(selection, now, null, "Asia/Shanghai");
  if (bounds.from > bounds.to) throw new BillAnalysisPreparationError("INVALID");
  const range: ReportRange = { ...selection, ...bounds };
  const previous = getReportComparisonBounds(range, "previous", now);
  const yearAgo = scope.mode === "month" ? getReportComparisonBounds(range, "yearAgo", now) : null;
  return { range: serialize(bounds), bounds, previous: previous ? { ...previous, range: serialize(previous) } : null, yearAgo: yearAgo ? { ...yearAgo, range: serialize(yearAgo) } : null };
}

export async function queryBillAnalysisSnapshot(
  session: BillAnalysisSession, scope: BillAnalysisScope, locale: Locale, now = new Date(), signal?: AbortSignal,
): Promise<BillAnalysisSourceSnapshot> {
  const { physicalDb } = await import("@/lib/db");
  const periods = resolveBillAnalysisRange(scope, now);
  signal?.throwIfAborted();
  return physicalDb.$transaction(async (physical) => {
    const tx = encryptionDatabase(physical, true);
    await authorizeLedgerReadScope(tx, session, scope.ledgerId ?? undefined);
    await authorizeMemberReadScope(tx, session.householdId, scope.actorMemberId ?? undefined);
    const household = await tx.household.findUniqueOrThrow({ where: { id: session.householdId }, select: { timezone: true } });
    if (household.timezone !== "Asia/Shanghai") throw new BillAnalysisPreparationError("INVALID");
    const [{ captured }] = await tx.$queryRaw<Array<{ captured: Date }>>`SELECT transaction_timestamp() AS captured`;
    const common = { householdId: session.householdId, deletedAt: null,
      ...(scope.ledgerId ? { ledgerId: scope.ledgerId } : {}), ...(scope.actorMemberId ? { actorMemberId: scope.actorMemberId } : {}),
    };
    const current: BillAnalysisSourceRow[] = [];
    const previous = periods.previous ? { range: periods.previous.range, rows: [] as BillAnalysisSourceRow[] } : null;
    const yearAgo = periods.yearAgo ? { range: periods.yearAgo.range, rows: [] as BillAnalysisSourceRow[] } : null;
    let firstOccurredAt: Date | null = null;
    let sourceBytes = 0;
    const retain = (rows: SnapshotRow[]) => {
      for (const row of rows) {
        signal?.throwIfAborted();
        if (row.occurredAt <= periods.bounds.to && (!firstOccurredAt || row.occurredAt < firstOccurredAt)) firstOccurredAt = row.occurredAt;
        const source = (note: string | null): BillAnalysisSourceRow => ({ id: row.id, ledgerId: row.ledgerId, actorMemberId: row.actorMemberId, occurredAt: row.occurredAt,
          type: row.type, amountFen: row.amountFen, categoryId: row.categoryId, categoryName: row.category.name, note });
        const append = (target: BillAnalysisSourceRow[], item: BillAnalysisSourceRow) => {
          sourceBytes += Buffer.byteLength(JSON.stringify(item));
          if (sourceBytes > MAX_SOURCE_BYTES) throw new BillAnalysisPreparationError("TOO_LARGE");
          target.push(item);
        };
        if (row.occurredAt >= periods.bounds.from && row.occurredAt <= periods.bounds.to) {
          if (current.length >= MAX_BILL_ANALYSIS_ROWS || Buffer.byteLength(row.note ?? "") > MAX_BILL_ANALYSIS_BODY_BYTES) throw new BillAnalysisPreparationError("TOO_LARGE");
          append(current, source(row.note ?? null));
        }
        if (previous && periods.previous && row.occurredAt >= periods.previous.from && row.occurredAt <= periods.previous.to) append(previous.rows, source(null));
        if (yearAgo && periods.yearAgo && row.occurredAt >= periods.yearAgo.from && row.occurredAt <= periods.yearAgo.to) append(yearAgo.rows, source(null));
      }
    };

    if (getEncryptionContext()?.mode === "ENCRYPTED") {
      // Encrypted financial predicates cannot be pushed to SQL. Page only metadata,
      // cap ciphertext before fetching it, and decrypt each selected row once.
      let afterId: string | undefined;
      let scannedBytes = 0;
      while (true) {
        signal?.throwIfAborted();
        const metadata = await physical.$queryRaw<Array<{ id: string; bytes: bigint }>>(Prisma.sql`
          SELECT id, COALESCE(octet_length(encrypted_payload), 0)::bigint AS bytes
          FROM "Transaction" WHERE household_id=${session.householdId} AND deleted_at IS NULL
          ${scope.ledgerId ? Prisma.sql`AND ledger_id=${scope.ledgerId}` : Prisma.empty}
          ${scope.actorMemberId ? Prisma.sql`AND actor_member_id=${scope.actorMemberId}` : Prisma.empty}
          ${afterId ? Prisma.sql`AND id>${afterId}` : Prisma.empty}
          ORDER BY id ASC LIMIT 500
        `);
        if (!metadata.length) break;
        let ids: string[] = [], pageBytes = 0;
        const flush = async () => {
          if (!ids.length) return;
          signal?.throwIfAborted();
          const rows = await tx.transaction.findMany({ where: { ...common, id: { in: ids } }, orderBy: { id: "asc" }, take: ids.length, select: { ...rowSelection, note: true } });
          retain(rows);
          ids = []; pageBytes = 0;
        };
        for (const item of metadata) {
          signal?.throwIfAborted();
          if (item.bytes < 0n || item.bytes > BigInt(MAX_CIPHER_ROW_BYTES)) throw new BillAnalysisPreparationError("TOO_LARGE");
          const bytes = Number(item.bytes);
          scannedBytes += bytes;
          if (scannedBytes > MAX_FINANCIAL_SCAN_BYTES) throw new BillAnalysisPreparationError("TOO_LARGE");
          if (ids.length && pageBytes + bytes > CIPHER_PAGE_BYTES) await flush();
          ids.push(item.id); pageBytes += bytes;
          // A valid large entity is processed alone under the crypto envelope bound.
          if (pageBytes >= CIPHER_PAGE_BYTES) await flush();
        }
        await flush();
        afterId = metadata[metadata.length - 1].id;
        if (metadata.length < 500) break;
      }
    } else {
      // Inspect only server-side lengths before any current-period note is fetched.
      const [budget] = await physical.$queryRaw<Array<{ count: bigint; noteBytes: bigint; maxNoteBytes: bigint }>>(Prisma.sql`
        SELECT COUNT(*)::bigint AS count, COALESCE(SUM(octet_length(note)), 0)::bigint AS "noteBytes",
          COALESCE(MAX(octet_length(note)), 0)::bigint AS "maxNoteBytes"
        FROM "Transaction" WHERE household_id=${session.householdId} AND deleted_at IS NULL
          AND occurred_at>=${periods.bounds.from} AND occurred_at<=${periods.bounds.to}
          ${scope.ledgerId ? Prisma.sql`AND ledger_id=${scope.ledgerId}` : Prisma.empty}
          ${scope.actorMemberId ? Prisma.sql`AND actor_member_id=${scope.actorMemberId}` : Prisma.empty}
      `);
      if (budget.count > BigInt(MAX_BILL_ANALYSIS_ROWS) || budget.noteBytes > BigInt(MAX_BILL_ANALYSIS_INPUT_BYTES) || budget.maxNoteBytes > BigInt(MAX_BILL_ANALYSIS_BODY_BYTES)) throw new BillAnalysisPreparationError("TOO_LARGE");
      const first = await tx.transaction.findFirst({ where: { ...common, occurredAt: { lte: periods.bounds.to } }, orderBy: { occurredAt: "asc" }, select: { occurredAt: true } });
      firstOccurredAt = first?.occurredAt ?? null;
      for (const [bounds, includeNote] of [[periods.bounds, true], ...(periods.previous ? [[periods.previous, false] as const] : []), ...(periods.yearAgo ? [[periods.yearAgo, false] as const] : [])] as const) {
        let afterId: string | undefined;
        while (true) {
          signal?.throwIfAborted();
          const rows = await tx.transaction.findMany({ where: { ...common, ...(afterId ? { id: { gt: afterId } } : {}), occurredAt: { gte: bounds.from, lte: bounds.to } },
            orderBy: { id: "asc" }, take: 500, select: { ...rowSelection, ...(includeNote ? { note: true } : {}) } });
          retain(rows);
          if (rows.length < 500) break;
          afterId = rows[rows.length - 1].id;
        }
      }
    }
    signal?.throwIfAborted();
    return { scope, locale, snapshotAt: captured.toISOString(), range: periods.range, current, previous, yearAgo, firstRecordedDate: firstOccurredAt ? shanghaiDate(firstOccurredAt) : null };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 10_000, timeout: 120_000 });
}
