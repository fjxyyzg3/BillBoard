-- CreateEnum
CREATE TYPE "BillAnalysisRequestStatus" AS ENUM ('PREPARING', 'RUNNING', 'STOPPING', 'SUCCEEDED', 'FAILED');

-- AlterTable
ALTER TABLE "ResourceExecution" ADD COLUMN     "charged_calls" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "BillAnalysisReport" (
    "id" TEXT NOT NULL,
    "household_id" TEXT NOT NULL,
    "created_by_member_id" TEXT NOT NULL,
    "definition" JSONB,
    "content" JSONB,
    "input_hash" TEXT,
    "generation" INTEGER NOT NULL DEFAULT 0,
    "active_request_id" TEXT,
    "generated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "encrypted_payload" TEXT,
    "encryption_revision" TEXT,

    CONSTRAINT "BillAnalysisReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillAnalysisRequest" (
    "id" TEXT NOT NULL,
    "household_id" TEXT NOT NULL,
    "created_by_member_id" TEXT NOT NULL,
    "original_app_session_id" TEXT NOT NULL,
    "client_request_id" TEXT NOT NULL,
    "status" "BillAnalysisRequestStatus" NOT NULL,
    "report_id" TEXT,
    "generation" INTEGER,
    "definition" JSONB,
    "error_code" TEXT,
    "mode_revision" INTEGER NOT NULL,
    "config_mode" TEXT NOT NULL,
    "lease_token" TEXT,
    "deadline_at" TIMESTAMP(3),
    "owner_id" TEXT,
    "owner_runtime" TEXT,
    "owner_pid" INTEGER,
    "owner_started_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "encrypted_payload" TEXT,
    "encryption_revision" TEXT,

    CONSTRAINT "BillAnalysisRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BillAnalysisReport_household_id_generated_at_id_idx" ON "BillAnalysisReport"("household_id", "generated_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "BillAnalysisReport_id_household_id_key" ON "BillAnalysisReport"("id", "household_id");

-- CreateIndex
CREATE INDEX "BillAnalysisRequest_household_id_status_idx" ON "BillAnalysisRequest"("household_id", "status");

-- CreateIndex
CREATE INDEX "BillAnalysisRequest_owner_runtime_owner_pid_status_idx" ON "BillAnalysisRequest"("owner_runtime", "owner_pid", "status");

-- CreateIndex
CREATE INDEX "BillAnalysisRequest_lease_token_idx" ON "BillAnalysisRequest"("lease_token");

-- CreateIndex
CREATE UNIQUE INDEX "BillAnalysisRequest_household_member_request_key" ON "BillAnalysisRequest"("household_id", "created_by_member_id", "client_request_id");

-- AddForeignKey
ALTER TABLE "BillAnalysisReport" ADD CONSTRAINT "BillAnalysisReport_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillAnalysisReport" ADD CONSTRAINT "BillAnalysisReport_created_by_member_id_household_id_fkey" FOREIGN KEY ("created_by_member_id", "household_id") REFERENCES "HouseholdMember"("id", "household_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillAnalysisRequest" ADD CONSTRAINT "BillAnalysisRequest_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillAnalysisRequest" ADD CONSTRAINT "BillAnalysisRequest_created_by_member_id_household_id_fkey" FOREIGN KEY ("created_by_member_id", "household_id") REFERENCES "HouseholdMember"("id", "household_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillAnalysisRequest" ADD CONSTRAINT "BillAnalysisRequest_report_id_household_id_fkey" FOREIGN KEY ("report_id", "household_id") REFERENCES "BillAnalysisReport"("id", "household_id") ON DELETE RESTRICT ON UPDATE CASCADE;
