ALTER TABLE "ResourceExecution" ADD COLUMN "charged_at" TIMESTAMP(3);

-- Existing executions already consumed their windows before this upgrade.
UPDATE "ResourceExecution" SET "charged_at" = "created_at";
