ALTER TYPE "LedgerAuditAction" ADD VALUE IF NOT EXISTS 'TRANSACTION_MOVED';
ALTER TYPE "LedgerAuditAction" ADD VALUE IF NOT EXISTS 'LEDGER_CREATED';
ALTER TYPE "LedgerAuditAction" ADD VALUE IF NOT EXISTS 'LEDGER_RENAMED';
ALTER TYPE "LedgerAuditAction" ADD VALUE IF NOT EXISTS 'LEDGER_DEFAULT_CHANGED';
ALTER TYPE "LedgerAuditAction" ADD VALUE IF NOT EXISTS 'LEDGER_ARCHIVED';
ALTER TYPE "LedgerAuditAction" ADD VALUE IF NOT EXISTS 'LEDGER_RESTORED';

ALTER TABLE "Ledger" ADD COLUMN "accepts_legacy_drafts" BOOLEAN NOT NULL DEFAULT false;
UPDATE "Ledger" SET "accepts_legacy_drafts" = true WHERE "is_default";
CREATE UNIQUE INDEX "Ledger_legacy_drafts_household_key" ON "Ledger"("household_id") WHERE "accepts_legacy_drafts";
