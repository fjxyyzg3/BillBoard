-- Add a fixed non-secret resolver marker
ALTER TABLE "ClientDiagnosticReport"
ADD COLUMN "resolved_by" TEXT;
