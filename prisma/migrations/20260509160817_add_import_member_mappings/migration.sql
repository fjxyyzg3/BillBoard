ALTER TABLE "ImportDraftRow"
ADD COLUMN "actor_external_name" TEXT,
ADD COLUMN "creator_external_name" TEXT;

CREATE TABLE "ImportMemberMapping" (
    "id" TEXT NOT NULL,
    "household_id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "external_name" TEXT NOT NULL,
    "member_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImportMemberMapping_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "household_source_external_name" ON "ImportMemberMapping"("household_id", "source", "external_name");
CREATE INDEX "ImportMemberMapping_member_id_idx" ON "ImportMemberMapping"("member_id");

ALTER TABLE "ImportMemberMapping"
ADD CONSTRAINT "ImportMemberMapping_household_id_fkey"
FOREIGN KEY ("household_id") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ImportMemberMapping"
ADD CONSTRAINT "ImportMemberMapping_member_id_fkey"
FOREIGN KEY ("member_id") REFERENCES "HouseholdMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;
