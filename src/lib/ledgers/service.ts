import type { Ledger, LedgerAuditAction, Prisma } from "@prisma/client";
import { z } from "zod";
import { resolveHouseholdContext, type HouseholdSession } from "@/lib/auth/household-context";
import { db } from "@/lib/db";
import type { LedgerSummary } from "./selection";

const nameSchema = z.string().trim().min(1, "Enter a ledger name").max(80, "Ledger name must be 80 characters or fewer");
const idSchema = z.string().min(1).max(512);
const transactionOptions = { maxWait: 10_000, timeout: 15_000 };

function summary(ledger: Ledger): LedgerSummary {
  return { id: ledger.id, name: ledger.name, isDefault: ledger.isDefault, archivedAt: ledger.archivedAt?.toISOString() ?? null };
}

async function targetLedger(transaction: Prisma.TransactionClient, householdId: string, ledgerId: string) {
  await transaction.$queryRaw`SELECT id FROM "Ledger" WHERE id = ${ledgerId} AND household_id = ${householdId} FOR UPDATE`;
  const ledger = await transaction.ledger.findFirst({ where: { id: ledgerId, householdId } });
  if (!ledger) throw new Error("Ledger is unavailable");
  return ledger;
}

async function audit(
  transaction: Prisma.TransactionClient,
  context: { householdId: string; memberId: string },
  ledgerId: string,
  action: LedgerAuditAction,
) {
  await transaction.ledgerAuditLog.create({ data: { ...context, ledgerId, targetId: ledgerId, action } });
}

export async function createLedger(input: { name: string }, session: HouseholdSession) {
  const name = nameSchema.parse(input.name);
  return db.$transaction(async (transaction) => {
    const context = await resolveHouseholdContext(transaction, session, { lock: true });
    const ledger = await transaction.ledger.create({ data: { householdId: context.householdId, name } });
    await audit(transaction, { householdId: context.householdId, memberId: context.memberId }, ledger.id, "LEDGER_CREATED");
    return summary(ledger);
  }, transactionOptions);
}

export async function renameLedger(input: { ledgerId: string; name: string }, session: HouseholdSession) {
  const ledgerId = idSchema.parse(input.ledgerId);
  const name = nameSchema.parse(input.name);
  return db.$transaction(async (transaction) => {
    const context = await resolveHouseholdContext(transaction, session, { lock: true });
    const ledger = await targetLedger(transaction, context.householdId, ledgerId);
    if (ledger.archivedAt !== null) throw new Error("Ledger is unavailable");
    if (ledger.name === name) return summary(ledger);
    const updated = await transaction.ledger.update({ where: { id: ledger.id }, data: { name } });
    await audit(transaction, { householdId: context.householdId, memberId: context.memberId }, ledger.id, "LEDGER_RENAMED");
    return summary(updated);
  }, transactionOptions);
}

export async function setDefaultLedger(input: { ledgerId: string }, session: HouseholdSession) {
  const ledgerId = idSchema.parse(input.ledgerId);
  return db.$transaction(async (transaction) => {
    const context = await resolveHouseholdContext(transaction, session, { lock: true });
    if (context.role !== "OWNER") throw new Error("Forbidden");
    const ledger = await targetLedger(transaction, context.householdId, ledgerId);
    if (ledger.archivedAt !== null) throw new Error("Ledger is unavailable");
    if (ledger.isDefault) return summary(ledger);
    await transaction.ledger.updateMany({ where: { householdId: context.householdId, isDefault: true }, data: { isDefault: false } });
    const updated = await transaction.ledger.update({ where: { id: ledger.id }, data: { isDefault: true } });
    await audit(transaction, { householdId: context.householdId, memberId: context.memberId }, ledger.id, "LEDGER_DEFAULT_CHANGED");
    return summary(updated);
  }, transactionOptions);
}

async function changeArchive(input: { ledgerId: string }, session: HouseholdSession, archived: boolean) {
  const ledgerId = idSchema.parse(input.ledgerId);
  return db.$transaction(async (transaction) => {
    const context = await resolveHouseholdContext(transaction, session, { lock: true });
    if (context.role !== "OWNER") throw new Error("Forbidden");
    const ledger = await targetLedger(transaction, context.householdId, ledgerId);
    if (archived && ledger.isDefault) throw new Error("Cannot archive the default ledger");
    if ((ledger.archivedAt !== null) === archived) return summary(ledger);
    const updated = await transaction.ledger.update({ where: { id: ledger.id }, data: { archivedAt: archived ? new Date() : null } });
    await audit(transaction, { householdId: context.householdId, memberId: context.memberId }, ledger.id, archived ? "LEDGER_ARCHIVED" : "LEDGER_RESTORED");
    return summary(updated);
  }, transactionOptions);
}

export async function archiveLedger(input: { ledgerId: string }, session: HouseholdSession) {
  return changeArchive(input, session, true);
}

export async function restoreLedger(input: { ledgerId: string }, session: HouseholdSession) {
  return changeArchive(input, session, false);
}
