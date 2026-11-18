-- CreateEnum
CREATE TYPE "OpsAuditAction" AS ENUM ('RESET_USER_PASSWORD', 'REVOKE_USER_SESSION', 'REVOKE_USER_SESSIONS_AFTER_PASSWORD_RESET');

-- CreateTable
CREATE TABLE "AppSession" (
    "id" TEXT NOT NULL,
    "session_key" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "user_agent" TEXT,
    "login_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpsAuditLog" (
    "id" TEXT NOT NULL,
    "action" "OpsAuditAction" NOT NULL,
    "operator" TEXT NOT NULL DEFAULT 'ops-admin',
    "target_user_id" TEXT,
    "target_session_id" TEXT,
    "summary" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OpsAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AppSession_session_key_key" ON "AppSession"("session_key");

-- CreateIndex
CREATE INDEX "AppSession_user_id_revoked_at_expires_at_idx" ON "AppSession"("user_id", "revoked_at", "expires_at");

-- CreateIndex
CREATE INDEX "AppSession_expires_at_idx" ON "AppSession"("expires_at");

-- CreateIndex
CREATE INDEX "OpsAuditLog_created_at_idx" ON "OpsAuditLog"("created_at");

-- CreateIndex
CREATE INDEX "OpsAuditLog_target_user_id_created_at_idx" ON "OpsAuditLog"("target_user_id", "created_at");

-- CreateIndex
CREATE INDEX "OpsAuditLog_target_session_id_created_at_idx" ON "OpsAuditLog"("target_session_id", "created_at");

-- AddForeignKey
ALTER TABLE "AppSession" ADD CONSTRAINT "AppSession_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpsAuditLog" ADD CONSTRAINT "OpsAuditLog_target_user_id_fkey" FOREIGN KEY ("target_user_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpsAuditLog" ADD CONSTRAINT "OpsAuditLog_target_session_id_fkey" FOREIGN KEY ("target_session_id") REFERENCES "AppSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;
