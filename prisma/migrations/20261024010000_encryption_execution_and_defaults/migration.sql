CREATE TABLE "ResourceExecution" (
    "token" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ResourceExecution_pkey" PRIMARY KEY ("token")
);
ALTER TABLE "ResourceExecution" ADD CONSTRAINT "ResourceExecution_token_fkey"
  FOREIGN KEY ("token") REFERENCES "ResourceLease"("token") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "HouseholdEncryption" ("household_id", "mode", "revision", "key_version", "updated_at")
SELECT "id", 'UNENCRYPTED', 0, 0, CURRENT_TIMESTAMP FROM "Household"
ON CONFLICT ("household_id") DO NOTHING;

ALTER TABLE "HouseholdEncryption" ADD CONSTRAINT "HouseholdEncryption_mode_check"
  CHECK ("mode" IN ('UNENCRYPTED', 'ENABLING', 'ENCRYPTED', 'DISABLING'));
ALTER TABLE "HouseholdEncryption" ADD CONSTRAINT "HouseholdEncryption_revision_check"
  CHECK ("revision" >= 0 AND "key_version" >= 0);
