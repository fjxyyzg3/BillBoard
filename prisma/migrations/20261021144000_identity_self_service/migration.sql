-- CreateEnum
CREATE TYPE "InvitationPurpose" AS ENUM ('PLATFORM', 'HOUSEHOLD');

-- CreateEnum
CREATE TYPE "AccountTokenPurpose" AS ENUM ('VERIFY_EMAIL', 'CHANGE_EMAIL', 'RESET_PASSWORD', 'REGISTER');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "email_verified_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "Invitation" (
    "id" TEXT NOT NULL,
    "purpose" "InvitationPurpose" NOT NULL,
    "email" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "household_id" TEXT,
    "created_by_member_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "sent_at" TIMESTAMP(3),
    "consumed_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountToken" (
    "id" TEXT NOT NULL,
    "purpose" "AccountTokenPurpose" NOT NULL,
    "token_hash" TEXT NOT NULL,
    "user_id" TEXT,
    "email" TEXT NOT NULL,
    "invitation_id" TEXT,
    "password_hash" TEXT,
    "display_name" TEXT,
    "member_name" TEXT,
    "household_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "sent_at" TIMESTAMP(3),
    "consumed_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "AccountToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdentityAuditLog" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actor_user_id" TEXT,
    "actor_member_id" TEXT,
    "household_id" TEXT,
    "target_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdentityAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdentityRateLimit" (
    "id" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "window_started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdentityRateLimit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_token_hash_key" ON "Invitation"("token_hash");

-- CreateIndex
CREATE INDEX "Invitation_household_id_created_at_idx" ON "Invitation"("household_id", "created_at");

-- CreateIndex
CREATE INDEX "Invitation_email_purpose_expires_at_idx" ON "Invitation"("email", "purpose", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "AccountToken_token_hash_key" ON "AccountToken"("token_hash");

-- CreateIndex
CREATE INDEX "AccountToken_user_id_purpose_expires_at_idx" ON "AccountToken"("user_id", "purpose", "expires_at");

-- CreateIndex
CREATE INDEX "AccountToken_invitation_id_created_at_idx" ON "AccountToken"("invitation_id", "created_at");

-- CreateIndex
CREATE INDEX "AccountToken_expires_at_idx" ON "AccountToken"("expires_at");

-- CreateIndex
CREATE INDEX "IdentityAuditLog_household_id_created_at_idx" ON "IdentityAuditLog"("household_id", "created_at");

-- CreateIndex
CREATE INDEX "IdentityAuditLog_actor_user_id_created_at_idx" ON "IdentityAuditLog"("actor_user_id", "created_at");

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_created_by_member_id_household_id_fkey" FOREIGN KEY ("created_by_member_id", "household_id") REFERENCES "HouseholdMember"("id", "household_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountToken" ADD CONSTRAINT "AccountToken_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountToken" ADD CONSTRAINT "AccountToken_invitation_id_fkey" FOREIGN KEY ("invitation_id") REFERENCES "Invitation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A join invitation must identify its issuing member in the same household.
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_purpose_target_check" CHECK (
  ("purpose" = 'PLATFORM' AND "household_id" IS NULL AND "created_by_member_id" IS NULL)
  OR ("purpose" = 'HOUSEHOLD' AND "household_id" IS NOT NULL AND "created_by_member_id" IS NOT NULL)
);
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_token_digest_check" CHECK ("token_hash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "AccountToken" ADD CONSTRAINT "AccountToken_token_digest_check" CHECK ("token_hash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "AccountToken" ADD CONSTRAINT "AccountToken_subject_check" CHECK (
  ("purpose" = 'REGISTER' AND "user_id" IS NULL AND "invitation_id" IS NOT NULL
    AND "password_hash" IS NOT NULL AND "display_name" IS NOT NULL AND "member_name" IS NOT NULL)
  OR ("purpose" <> 'REGISTER' AND "user_id" IS NOT NULL AND "invitation_id" IS NULL AND "password_hash" IS NOT NULL)
);
ALTER TABLE "IdentityRateLimit" ADD CONSTRAINT "IdentityRateLimit_attempts_check" CHECK ("attempts" >= 0);

