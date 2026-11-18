-- AlterTable
ALTER TABLE "VoiceProcessingAdmission" ADD COLUMN     "encrypted_payload" TEXT,
ADD COLUMN     "encryption_revision" TEXT;

-- AlterTable
ALTER TABLE "Ledger" ADD COLUMN     "encrypted_payload" TEXT,
ADD COLUMN     "encryption_revision" TEXT;

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "encrypted_payload" TEXT,
ADD COLUMN     "encryption_revision" TEXT;

-- AlterTable
ALTER TABLE "NaturalLanguageRequest" ADD COLUMN     "encrypted_payload" TEXT,
ADD COLUMN     "encryption_revision" TEXT;

-- AlterTable
ALTER TABLE "ImportCategoryMapping" ADD COLUMN     "encrypted_payload" TEXT,
ADD COLUMN     "encryption_revision" TEXT;

-- AlterTable
ALTER TABLE "ImportMemberMapping" ADD COLUMN     "encrypted_payload" TEXT,
ADD COLUMN     "encryption_revision" TEXT;

-- AlterTable
ALTER TABLE "AppEvent" ADD COLUMN     "encrypted_payload" TEXT,
ADD COLUMN     "encryption_revision" TEXT;

-- AlterTable
ALTER TABLE "ImportDraft" ADD COLUMN     "encrypted_payload" TEXT,
ADD COLUMN     "encryption_revision" TEXT;

-- AlterTable
ALTER TABLE "ImportDraftRow" ADD COLUMN     "encrypted_payload" TEXT,
ADD COLUMN     "encryption_revision" TEXT;

-- CreateTable
CREATE TABLE "HouseholdEncryption" (
    "household_id" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'UNENCRYPTED',
    "revision" INTEGER NOT NULL DEFAULT 0,
    "generation" TEXT,
    "key_version" INTEGER NOT NULL DEFAULT 0,
    "sealed_key_ring" TEXT,
    "recovery_digest" TEXT,
    "active_operation_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HouseholdEncryption_pkey" PRIMARY KEY ("household_id")
);

-- CreateTable
CREATE TABLE "EncryptionOperation" (
    "id" TEXT NOT NULL,
    "household_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "member_id" TEXT NOT NULL,
    "app_session_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PREPARED',
    "source_mode" TEXT NOT NULL,
    "source_revision" INTEGER NOT NULL,
    "barrier_revision" INTEGER NOT NULL,
    "candidate_generation" TEXT,
    "candidate_key_version" INTEGER,
    "candidate_key_ring" TEXT,
    "recovery_digest" TEXT,
    "manifest" JSONB,
    "cursor" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "EncryptionOperation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EncryptionStaging" (
    "operation_id" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "source_digest" TEXT NOT NULL,
    "target" JSONB NOT NULL,

    CONSTRAINT "EncryptionStaging_pkey" PRIMARY KEY ("operation_id","model","entity_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "HouseholdEncryption_active_operation_id_key" ON "HouseholdEncryption"("active_operation_id");

-- CreateIndex
CREATE INDEX "EncryptionOperation_household_id_status_idx" ON "EncryptionOperation"("household_id", "status");

-- AddForeignKey
ALTER TABLE "HouseholdEncryption" ADD CONSTRAINT "HouseholdEncryption_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EncryptionOperation" ADD CONSTRAINT "EncryptionOperation_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EncryptionStaging" ADD CONSTRAINT "EncryptionStaging_operation_id_fkey" FOREIGN KEY ("operation_id") REFERENCES "EncryptionOperation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
