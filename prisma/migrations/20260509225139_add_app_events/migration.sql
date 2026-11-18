-- CreateEnum
CREATE TYPE "AppEventType" AS ENUM ('LOGIN_SUCCESS', 'LOGIN_FAILED', 'PAGE_VIEW', 'TRANSACTION_CREATED', 'TRANSACTION_UPDATED', 'TRANSACTION_DELETED', 'IMPORT_DRAFT_UPLOADED', 'IMPORT_CONFIRMED');

-- CreateTable
CREATE TABLE "AppEvent" (
    "id" TEXT NOT NULL,
    "event_type" "AppEventType" NOT NULL,
    "household_id" TEXT,
    "member_id" TEXT,
    "path" TEXT,
    "summary" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AppEvent_created_at_idx" ON "AppEvent"("created_at");

-- CreateIndex
CREATE INDEX "AppEvent_event_type_created_at_idx" ON "AppEvent"("event_type", "created_at");

-- CreateIndex
CREATE INDEX "AppEvent_household_id_created_at_idx" ON "AppEvent"("household_id", "created_at");

-- CreateIndex
CREATE INDEX "AppEvent_member_id_created_at_idx" ON "AppEvent"("member_id", "created_at");

-- AddForeignKey
ALTER TABLE "AppEvent" ADD CONSTRAINT "AppEvent_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "Household"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppEvent" ADD CONSTRAINT "AppEvent_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "HouseholdMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;
