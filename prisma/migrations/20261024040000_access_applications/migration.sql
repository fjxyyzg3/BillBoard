ALTER TYPE "OpsAuditAction" ADD VALUE 'ACCESS_APPLICATION_APPROVED';
ALTER TYPE "OpsAuditAction" ADD VALUE 'ACCESS_APPLICATION_REJECTED';
ALTER TYPE "OpsAuditAction" ADD VALUE 'ACCESS_APPLICATION_MAIL_RETRIED';

CREATE TYPE "AccessApplicationStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
CREATE TYPE "AccessApplicationMailStatus" AS ENUM ('NONE', 'SENDING', 'SENT', 'FAILED');

CREATE TABLE "AccessApplicationConfirmation" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'zh-CN',
    "token_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "sent_at" TIMESTAMP(3),
    "consumed_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    CONSTRAINT "AccessApplicationConfirmation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AccessApplicationConfirmation_normalized_email" CHECK (email = lower(btrim(email)) AND length(email) BETWEEN 3 AND 254)
);

CREATE TABLE "AccessApplication" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'zh-CN',
    "status" "AccessApplicationStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "verified_at" TIMESTAMP(3) NOT NULL,
    "decided_at" TIMESTAMP(3),
    "mail_status" "AccessApplicationMailStatus" NOT NULL DEFAULT 'NONE',
    "mail_attempt_token" TEXT,
    "mail_lease_expires_at" TIMESTAMP(3),
    "mail_sent_at" TIMESTAMP(3),
    CONSTRAINT "AccessApplication_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AccessApplication_normalized_email" CHECK (email = lower(btrim(email)) AND length(email) BETWEEN 3 AND 254)
);

CREATE UNIQUE INDEX "AccessApplicationConfirmation_token_hash_key" ON "AccessApplicationConfirmation"("token_hash");
CREATE INDEX "AccessApplicationConfirmation_email_created_at_idx" ON "AccessApplicationConfirmation"("email", "created_at");
CREATE INDEX "AccessApplicationConfirmation_expires_at_idx" ON "AccessApplicationConfirmation"("expires_at");
CREATE INDEX "AccessApplication_status_created_at_idx" ON "AccessApplication"("status", "created_at");
CREATE INDEX "AccessApplication_email_created_at_idx" ON "AccessApplication"("email", "created_at");
CREATE UNIQUE INDEX "AccessApplication_one_pending_email" ON "AccessApplication"("email") WHERE status = 'PENDING';

ALTER TABLE "Invitation" ADD COLUMN "access_application_id" TEXT;
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_access_application_id_fkey" FOREIGN KEY ("access_application_id") REFERENCES "AccessApplication"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "Invitation_access_application_id_created_at_idx" ON "Invitation"("access_application_id", "created_at");

ALTER TABLE "OpsAuditLog" ADD COLUMN "target_access_application_id" TEXT;
ALTER TABLE "OpsAuditLog" ADD CONSTRAINT "OpsAuditLog_target_access_application_id_fkey" FOREIGN KEY ("target_access_application_id") REFERENCES "AccessApplication"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "OpsAuditLog_target_access_application_id_created_at_idx" ON "OpsAuditLog"("target_access_application_id", "created_at");
