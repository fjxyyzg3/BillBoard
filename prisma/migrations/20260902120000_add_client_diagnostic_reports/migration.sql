-- CreateEnum
CREATE TYPE "ClientDiagnosticReportStatus" AS ENUM ('OPEN', 'RESOLVED');

-- CreateTable
CREATE TABLE "ClientDiagnosticReport" (
    "id" TEXT NOT NULL,
    "client_report_id" TEXT NOT NULL,
    "household_id" TEXT NOT NULL,
    "member_id" TEXT NOT NULL,
    "status" "ClientDiagnosticReportStatus" NOT NULL DEFAULT 'OPEN',
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "ClientDiagnosticReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ClientDiagnosticReport_client_report_id_key" ON "ClientDiagnosticReport"("client_report_id");

-- CreateIndex
CREATE INDEX "ClientDiagnosticReport_status_created_at_idx" ON "ClientDiagnosticReport"("status", "created_at");

-- CreateIndex
CREATE INDEX "ClientDiagnosticReport_household_id_status_created_at_idx" ON "ClientDiagnosticReport"("household_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "ClientDiagnosticReport_member_id_status_created_at_idx" ON "ClientDiagnosticReport"("member_id", "status", "created_at");

-- AddForeignKey
ALTER TABLE "ClientDiagnosticReport" ADD CONSTRAINT "ClientDiagnosticReport_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientDiagnosticReport" ADD CONSTRAINT "ClientDiagnosticReport_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "HouseholdMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;
