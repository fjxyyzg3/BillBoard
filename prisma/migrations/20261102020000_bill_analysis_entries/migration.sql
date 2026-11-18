CREATE INDEX "BillAnalysisReport_household_id_updated_at_id_idx" ON "BillAnalysisReport"("household_id", "updated_at", "id");

CREATE INDEX "BillAnalysisReport_household_id_active_request_id_idx" ON "BillAnalysisReport"("household_id", "active_request_id");

CREATE INDEX "BillAnalysisRequest_household_id_report_id_created_at_id_idx" ON "BillAnalysisRequest"("household_id", "report_id", "created_at", "id");
