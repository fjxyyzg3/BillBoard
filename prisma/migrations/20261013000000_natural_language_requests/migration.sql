CREATE TYPE "NaturalLanguageRequestStatus" AS ENUM ('PROCESSING', 'SUCCEEDED', 'FAILED');

CREATE TABLE "NaturalLanguageRequest" (
    "id" TEXT NOT NULL,
    "household_id" TEXT NOT NULL,
    "created_by_member_id" TEXT NOT NULL,
    "client_request_id" TEXT NOT NULL,
    "input_hash" TEXT,
    "reference_at" TIMESTAMP(3),
    "status" "NaturalLanguageRequestStatus" NOT NULL,
    "attempt_id" TEXT,
    "lease_expires_at" TIMESTAMP(3),
    "result" JSONB,
    "error_code" TEXT,
    "issues" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NaturalLanguageRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NaturalLanguageRequest_household_member_request_key"
    ON "NaturalLanguageRequest"("household_id", "created_by_member_id", "client_request_id");
CREATE INDEX "NaturalLanguageRequest_household_id_created_by_member_id_st_idx"
    ON "NaturalLanguageRequest"("household_id", "created_by_member_id", "status");
ALTER TABLE "NaturalLanguageRequest" ADD CONSTRAINT "NaturalLanguageRequest_household_id_fkey"
    FOREIGN KEY ("household_id") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NaturalLanguageRequest" ADD CONSTRAINT "NaturalLanguageRequest_created_by_member_id_fkey"
    FOREIGN KEY ("created_by_member_id") REFERENCES "HouseholdMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;
