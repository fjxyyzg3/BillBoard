import { randomUUID } from "node:crypto";
import { z } from "zod";
import { physicalDb, db } from "@/lib/db";
import { openKeyRing, parseHouseholdCode } from "@/lib/encryption/crypto";
import { runEncryptionContext } from "@/lib/encryption/request-context";
import { applyBillReconciliation, queryBillReconciliationApplication } from "@/lib/reports/bill-reconciliation-application";
import { reconciliationApplyInputSchema } from "@/lib/reports/bill-reconciliation-application-protocol";
import { prepareBillReconciliation, buildBillReconciliationContent } from "@/lib/reports/bill-reconciliation-prepare";
import { BILL_RECONCILIATION_SCHEMA_VERSION, type BillReconciliationAgentResponse } from "@/lib/reports/bill-reconciliation-protocol";
import { queryBillReconciliationSnapshot } from "@/lib/reports/bill-reconciliation-snapshot";
import type { ReconciliationApplyInput } from "@/lib/reports/bill-reconciliation-types";

const id = z.string().uuid();
const session = z.object({ id, householdId: id, memberId: id, appSessionId: id }).strict();
const common = { database: z.string().regex(/^bb_recovery_(?:source|target)_[a-f0-9]{32}_test$/), session };
const request = z.discriminatedUnion("operation", [
  z.object({ ...common, operation: z.enum(["apply", "apply-manual"]), ledgerId: id, expenseId: id, incomeId: id, requestId: id }).strict(),
  z.object({ ...common, operation: z.literal("apply-retention"), ledgerId: id, expenseId: id, incomeId: id, duplicateId: id, requestId: id }).strict(),
  z.object({ ...common, operation: z.literal("query"), code: z.string().min(1).max(4096),
    input: reconciliationApplyInputSchema, rejectedInput: reconciliationApplyInputSchema.optional(), closedInput: reconciliationApplyInputSchema.optional(),
  }).strict(),
]);

async function main() {
  let body = "";
  for await (const chunk of process.stdin) {
    body += String(chunk);
    if (Buffer.byteLength(body) > 32 * 1024) throw new Error("Recovery application worker input exceeded its bound");
  }
  const input = request.parse(JSON.parse(body));
  const url = new URL(process.env.DATABASE_URL ?? "");
  if (process.env.NODE_ENV === "production" || !["127.0.0.1", "localhost"].includes(url.hostname) || url.pathname !== `/${input.database}`) throw new Error("Recovery application worker requires its owned isolated database");
  const [{ name }] = await physicalDb.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`;
  if (name !== input.database) throw new Error("Recovery application worker database identity mismatch");
  if (input.operation !== "query") {
    const manual = input.operation !== "apply";
    const retention = input.operation === "apply-retention";
    const snapshot = await queryBillReconciliationSnapshot(input.session, { mode: "year", period: "2026", ledgerId: input.ledgerId, actorMemberId: null }, "en-US");
    const prepared = prepareBillReconciliation(snapshot);
    const expenseRef = Object.entries(prepared.assertions).find(([, row]) => row.id === input.expenseId)?.[0];
    const incomeRef = Object.entries(prepared.assertions).find(([, row]) => row.id === input.incomeId)?.[0];
    const duplicateRef = retention ? Object.entries(prepared.assertions).find(([, row]) => row.id === input.duplicateId)?.[0] : undefined;
    if (!expenseRef || !incomeRef || retention && !duplicateRef) throw new Error("Synthetic application rows were not included in the snapshot");
    const refs = [expenseRef, incomeRef, ...(duplicateRef ? [duplicateRef] : [])];
    const content = buildBillReconciliationContent(prepared, prepared.batches.map<BillReconciliationAgentResponse>((batch) => ({
      schemaVersion: BILL_RECONCILIATION_SCHEMA_VERSION, batchId: batch.batchId,
      groups: refs.every((ref) => batch.rows.some((row) => row.ref === ref)) ? [{
        kind: manual ? "notice" : "refund", title: "Synthetic isolated reconciliation", reason: "The records require synthetic review", confidence: manual ? "review" : "high",
        evidenceRefs: refs, duplicateGroups: [], offset: manual ? null : { expenseRef, incomeRefs: [incomeRef], kind: "refund" },
      }] : [],
    })));
    const suggestion = content.suggestions.find((item) => manual ? item.kind === "notice" : item.canApply);
    if (!suggestion) throw new Error("Synthetic isolated refund did not produce an applicable suggestion");
    const report = await db.billAnalysisReport.create({ data: { householdId: input.session.householdId, createdByMemberId: input.session.memberId,
      definition: { purpose: "reconciliation", version: 1, scope: snapshot.scope }, content: JSON.parse(JSON.stringify(content)),
      generation: 1, generatedAt: new Date(), inputHash: prepared.inputHash } });
    const common = { requestId: input.requestId, reportId: report.id, generation: report.generation };
    const applyInput: ReconciliationApplyInput = retention ? { ...common, version: 3, suggestionIds: [], manualGroups: [{ noticeId: suggestion.id, refs, keepRefs: [expenseRef, incomeRef] }] }
      : manual ? { ...common, version: 2, suggestionIds: [], manualGroups: [{ noticeId: suggestion.id, refs, keepRef: incomeRef }] } : { ...common, suggestionIds: [suggestion.id] };
    const outcome = await applyBillReconciliation(input.session, applyInput);
    const rejectedInput = manual ? { ...applyInput, requestId: randomUUID() } : undefined;
    const rejected = rejectedInput ? await applyBillReconciliation(input.session, rejectedInput) : undefined;
    const closedInput = retention ? { ...applyInput, requestId: randomUUID() } : undefined;
    const closed = closedInput ? await queryBillReconciliationApplication(input.session, closedInput.requestId) : undefined;
    const receipt = await physicalDb.billReconciliationApplication.findFirst({ where: { householdId: input.session.householdId, createdByMemberId: input.session.memberId, clientRequestId: input.requestId } });
    return { input: applyInput, outcome, rejectedInput, rejected, closedInput, closed, receiptStatus: receipt?.status, auditCount: await physicalDb.ledgerAuditLog.count({ where: { householdId: input.session.householdId } }) };
  }
  const config = await physicalDb.householdEncryption.findUniqueOrThrow({ where: { householdId: input.session.householdId } });
  const code = parseHouseholdCode(input.code);
  const ring = await openKeyRing(code, config.sealedKeyRing!);
  code.secret = "";
  const auditBefore = await physicalDb.ledgerAuditLog.count({ where: { householdId: input.session.householdId } });
  const result = await runEncryptionContext({ session: { ...input.session, role: "OWNER" }, mode: "ENCRYPTED", configMode: "ENCRYPTED", revision: config.revision,
    ring, expiresAt: Date.now() + 60_000, disposed: false, readOnly: false }, async () => ({
    queried: await queryBillReconciliationApplication(input.session, input.input.requestId),
    replayed: await applyBillReconciliation(input.session, input.input),
    ...(input.rejectedInput ? { rejectedQueried: await queryBillReconciliationApplication(input.session, input.rejectedInput.requestId), rejectedReplayed: await applyBillReconciliation(input.session, input.rejectedInput) } : {}),
    ...(input.closedInput ? { closedQueried: await queryBillReconciliationApplication(input.session, input.closedInput.requestId), closedReplayed: await applyBillReconciliation(input.session, input.closedInput) } : {}),
    newAttempt: await applyBillReconciliation(input.session, { ...input.input, requestId: randomUUID() }),
  }));
  return { ...result, auditBefore, auditAfter: await physicalDb.ledgerAuditLog.count({ where: { householdId: input.session.householdId } }),
    activeRequests: await physicalDb.billAnalysisRequest.count({ where: { householdId: input.session.householdId, status: { in: ["PREPARING", "RUNNING", "STOPPING"] } } }),
    leases: await physicalDb.resourceLease.count({ where: { householdId: input.session.householdId } }) };
}

main().then((result) => { process.stdout.write(JSON.stringify(result)); }).catch((error: unknown) => {
  process.stderr.write(error instanceof Error ? `Recovery application worker failed (${error.name})` : "Recovery application worker failed");
  process.exitCode = 1;
}).finally(() => physicalDb.$disconnect());
