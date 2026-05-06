-- CreateEnum
CREATE TYPE "ImportDraftStatus" AS ENUM ('PENDING', 'COMPLETED');

-- CreateEnum
CREATE TYPE "ImportDraftRowStatus" AS ENUM ('READY', 'NEEDS_MAPPING', 'SOURCE_DUPLICATE', 'POSSIBLE_DUPLICATE', 'INVALID', 'USER_SKIPPED');

-- CreateEnum
CREATE TYPE "ImportRowDecision" AS ENUM ('KEEP', 'SKIP');

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "source" TEXT,
ADD COLUMN     "source_fingerprint" TEXT,
ADD COLUMN     "source_imported_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ImportCategoryMapping" (
    "id" TEXT NOT NULL,
    "household_id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "transaction_type" "TransactionType" NOT NULL,
    "primary_category" TEXT NOT NULL,
    "secondary_category" TEXT NOT NULL,
    "category_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImportCategoryMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportDraft" (
    "id" TEXT NOT NULL,
    "household_id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "status" "ImportDraftStatus" NOT NULL DEFAULT 'PENDING',
    "file_name" TEXT NOT NULL,
    "created_by_member_id" TEXT NOT NULL,
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImportDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportDraftRow" (
    "id" TEXT NOT NULL,
    "draft_id" TEXT NOT NULL,
    "row_number" INTEGER NOT NULL,
    "transaction_type" "TransactionType",
    "occurred_at" TIMESTAMP(3),
    "occurred_date" TEXT,
    "amount_fen" INTEGER,
    "actor_member_id" TEXT,
    "created_by_member_id" TEXT,
    "category_id" TEXT,
    "primary_category" TEXT,
    "secondary_category" TEXT,
    "mapping_key" TEXT,
    "note" TEXT,
    "source_fingerprint" TEXT,
    "status" "ImportDraftRowStatus" NOT NULL,
    "user_decision" "ImportRowDecision" NOT NULL DEFAULT 'KEEP',
    "skip_reason" TEXT,
    "duplicate_candidates" JSONB,
    "actor_fallback_applied" BOOLEAN NOT NULL DEFAULT false,
    "creator_fallback_applied" BOOLEAN NOT NULL DEFAULT false,
    "raw_transaction_type" TEXT,
    "raw_date" TEXT,
    "raw_amount" TEXT,
    "raw_member" TEXT,
    "raw_created_by" TEXT,
    "raw_currency" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImportDraftRow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ImportCategoryMapping_category_id_idx" ON "ImportCategoryMapping"("category_id");

-- CreateIndex
CREATE UNIQUE INDEX "household_source_type_primary_secondary" ON "ImportCategoryMapping"("household_id", "source", "transaction_type", "primary_category", "secondary_category");

-- CreateIndex
CREATE INDEX "ImportDraft_household_id_status_created_at_idx" ON "ImportDraft"("household_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "ImportDraftRow_draft_id_status_idx" ON "ImportDraftRow"("draft_id", "status");

-- CreateIndex
CREATE INDEX "ImportDraftRow_mapping_key_idx" ON "ImportDraftRow"("mapping_key");

-- CreateIndex
CREATE INDEX "ImportDraftRow_source_fingerprint_idx" ON "ImportDraftRow"("source_fingerprint");

-- CreateIndex
CREATE INDEX "Transaction_household_id_source_source_fingerprint_idx" ON "Transaction"("household_id", "source", "source_fingerprint");

-- AddForeignKey
ALTER TABLE "ImportCategoryMapping" ADD CONSTRAINT "ImportCategoryMapping_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportCategoryMapping" ADD CONSTRAINT "ImportCategoryMapping_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportDraft" ADD CONSTRAINT "ImportDraft_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportDraft" ADD CONSTRAINT "ImportDraft_created_by_member_id_fkey" FOREIGN KEY ("created_by_member_id") REFERENCES "HouseholdMember"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportDraftRow" ADD CONSTRAINT "ImportDraftRow_draft_id_fkey" FOREIGN KEY ("draft_id") REFERENCES "ImportDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "Transaction_household_source_fingerprint_unique"
ON "Transaction"("household_id", "source", "source_fingerprint")
WHERE "source" IS NOT NULL AND "source_fingerprint" IS NOT NULL;
