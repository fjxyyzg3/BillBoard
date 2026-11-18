-- Add schema version summary
ALTER TABLE "ClientDiagnosticReport"
ADD COLUMN "schema_version" TEXT NOT NULL DEFAULT 'diagnostic-report.v1';
