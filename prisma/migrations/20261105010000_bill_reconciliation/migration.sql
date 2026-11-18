CREATE TABLE "BillReconciliationApplication" (
    "id" TEXT NOT NULL,
    "household_id" TEXT NOT NULL,
    "created_by_member_id" TEXT NOT NULL,
    "client_request_id" TEXT NOT NULL,
    "report_id" TEXT,
    "generation" INTEGER,
    "status" TEXT NOT NULL,
    "definition" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "encrypted_payload" TEXT,
    "encryption_revision" TEXT,
    CONSTRAINT "BillReconciliationApplication_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "BillReconciliationApplication_status_check" CHECK ("status" IN ('SUCCEEDED', 'REJECTED', 'NOT_ACCEPTED'))
);

CREATE UNIQUE INDEX "BillReconciliationApplication_household_member_request_key" ON "BillReconciliationApplication"("household_id", "created_by_member_id", "client_request_id");
CREATE INDEX "BillReconciliationApplication_household_report_generation_idx" ON "BillReconciliationApplication"("household_id", "report_id", "generation");

ALTER TABLE "BillReconciliationApplication" ADD CONSTRAINT "BillReconciliationApplication_household_fkey" FOREIGN KEY ("household_id") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BillReconciliationApplication" ADD CONSTRAINT "BillReconciliationApplication_member_household_fkey" FOREIGN KEY ("created_by_member_id", "household_id") REFERENCES "HouseholdMember"("id", "household_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BillReconciliationApplication" ADD CONSTRAINT "BillReconciliationApplication_report_household_fkey" FOREIGN KEY ("report_id", "household_id") REFERENCES "BillAnalysisReport"("id", "household_id") ON DELETE RESTRICT ON UPDATE CASCADE;
