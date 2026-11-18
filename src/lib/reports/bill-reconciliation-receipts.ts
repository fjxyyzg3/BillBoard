import { Prisma } from "@prisma/client";
import { parseReconciliationApplicationDefinition } from "./bill-reconciliation-application-protocol";
import type { BillReconciliationContent, ReconciliationApplicationDefinition } from "./bill-reconciliation-types";

const MAX_RECEIPTS = 200;
const MAX_JSON_BYTES = 1024 * 1024;
// BBE1 base64url-encodes both the GCM ciphertext and its JSON envelope. The
// per-row allowance covers the protected-field wrapper, tag, and bounded header.
const MAX_CIPHER_BYTES = Math.ceil((Math.ceil((MAX_JSON_BYTES + MAX_RECEIPTS * 64) * 4 / 3) + MAX_RECEIPTS * 2048) * 4 / 3) + MAX_RECEIPTS * 5;

export class ReconciliationReceiptCapacityError extends Error {
  constructor() { super("Reconciliation receipt capacity exceeded"); }
}

function logicalBytes(definitions: ReconciliationApplicationDefinition[]) {
  return Buffer.byteLength(JSON.stringify(definitions.map((definition) => ({ definition }))));
}

export async function loadReconciliationReceipts(tx: Prisma.TransactionClient, metadata: Prisma.TransactionClient,
  householdId: string, reportId: string, generation: number): Promise<ReconciliationApplicationDefinition[]> {
  const rows = await metadata.$queryRaw<Array<{ id: string; bytes: bigint }>>(Prisma.sql`
    SELECT id, (COALESCE(octet_length(encrypted_payload),0) + COALESCE(octet_length(definition::text),0))::bigint AS bytes
    FROM "BillReconciliationApplication" WHERE household_id=${householdId} AND report_id=${reportId}
      AND generation=${generation} AND status='SUCCEEDED' ORDER BY id ASC LIMIT ${MAX_RECEIPTS + 1}`);
  if (rows.length > MAX_RECEIPTS || rows.some((row) => row.bytes < 0n) || rows.reduce((sum, row) => sum + row.bytes, 0n) > BigInt(MAX_CIPHER_BYTES)) throw new ReconciliationReceiptCapacityError();
  const definitions: ReconciliationApplicationDefinition[] = [];
  // Bound the physical page before the encrypted delegate opens any payload.
  for (let offset = 0; offset < rows.length; offset += 20) {
    const ids = rows.slice(offset, offset + 20).map((row) => row.id);
    const page = await tx.billReconciliationApplication.findMany({ where: { householdId, reportId, generation, status: "SUCCEEDED", id: { in: ids } }, orderBy: { id: "asc" }, take: ids.length,
      select: { clientRequestId: true, definition: true } });
    if (page.length !== ids.length) throw new Error("Incomplete reconciliation receipts");
    for (const row of page) {
      const definition = parseReconciliationApplicationDefinition(row.definition);
      if (definition.outcome.status !== "success" || definition.outcome.requestId !== row.clientRequestId || definition.outcome.reportId !== reportId || definition.outcome.generation !== generation || !definition.inputHash) throw new Error("Invalid reconciliation receipt");
      definitions.push(definition);
      if (logicalBytes(definitions) > MAX_JSON_BYTES) throw new ReconciliationReceiptCapacityError();
    }
  }
  return definitions;
}

export function assertReconciliationReceiptCapacity(existing: ReconciliationApplicationDefinition[], candidate: ReconciliationApplicationDefinition) {
  if (existing.length >= MAX_RECEIPTS || logicalBytes([...existing, candidate]) > MAX_JSON_BYTES) throw new ReconciliationReceiptCapacityError();
}

export function reconciliationHandledTransactionIds(content: BillReconciliationContent, definitions: ReconciliationApplicationDefinition[]) {
  const handled = new Set<string>();
  for (const definition of definitions) {
    const expected = new Set<string>();
    for (const id of definition.outcome.suggestionIds ?? []) {
      const suggestion = content.suggestions.find((value) => value.id === id);
      if (!suggestion || suggestion.kind === "notice") throw new Error("Invalid reconciliation receipt binding");
      for (const action of suggestion.actions) {
        const source = content.assertions[action.ref];
        if (!source) throw new Error("Invalid reconciliation receipt binding");
        expected.add(source.id);
      }
    }
    if (definition.version === 2 || definition.version === 3) for (const group of definition.manualGroups) {
      const notice = content.suggestions.find((value) => value.id === group.noticeId);
      if (!notice || notice.kind !== "notice" || group.refs.some((ref) => !notice.evidenceRefs.includes(ref))) throw new Error("Invalid reconciliation receipt binding");
      for (const transaction of group.transactions) {
        if (content.assertions[transaction.ref]?.id !== transaction.transactionId) throw new Error("Invalid reconciliation receipt binding");
        expected.add(transaction.transactionId);
      }
    }
    if (expected.size !== definition.transactionIds?.length || definition.transactionIds.some((id) => !expected.has(id))) throw new Error("Invalid reconciliation receipt binding");
    for (const id of expected) {
      if (handled.has(id)) throw new Error("Overlapping reconciliation receipt binding");
      handled.add(id);
    }
  }
  return handled;
}
