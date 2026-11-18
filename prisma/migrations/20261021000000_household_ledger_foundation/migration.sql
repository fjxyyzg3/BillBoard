-- Maintenance-window migration: all writers must be stopped before execution.
-- One atomic transaction leaves either the complete foundation or the original schema.
BEGIN;

CREATE TEMP TABLE billboard_foundation_migration_state ON COMMIT DROP AS
SELECT NOT EXISTS (
  SELECT 1 FROM information_schema.columns
  WHERE table_schema = current_schema() AND table_name = 'AppSession' AND column_name = 'member_id'
) AS bind_legacy_sessions;

ALTER TABLE "Household" ADD COLUMN IF NOT EXISTS "closed_at" TIMESTAMP(3);
ALTER TABLE "HouseholdMember" ADD COLUMN IF NOT EXISTS "left_at" TIMESTAMP(3);

-- Reject ambiguous ownership and broken historical associations without printing data.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "Household" h
    WHERE h."closed_at" IS NULL AND (
      SELECT count(*) FROM "HouseholdMember" m
      WHERE m."household_id" = h."id" AND m."left_at" IS NULL AND m."role" = 'OWNER'
    ) <> 1
  ) OR EXISTS (
    SELECT 1 FROM "HouseholdMember" WHERE "left_at" IS NULL GROUP BY "user_id" HAVING count(*) > 1
  ) OR EXISTS (
    SELECT 1 FROM "HouseholdMember" WHERE "left_at" IS NULL
    GROUP BY "household_id", "member_name" HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Existing household data violates active membership invariants';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "Transaction" t
    LEFT JOIN "HouseholdMember" a ON a."id" = t."actor_member_id"
    LEFT JOIN "HouseholdMember" c ON c."id" = t."created_by_member_id"
    WHERE a."household_id" IS DISTINCT FROM t."household_id"
       OR c."household_id" IS DISTINCT FROM t."household_id"
  ) OR EXISTS (
    SELECT 1 FROM "NaturalLanguageRequest" r LEFT JOIN "HouseholdMember" m ON m."id" = r."created_by_member_id"
    WHERE m."household_id" IS DISTINCT FROM r."household_id"
  ) OR EXISTS (
    SELECT 1 FROM "ImportDraft" d LEFT JOIN "HouseholdMember" m ON m."id" = d."created_by_member_id"
    WHERE m."household_id" IS DISTINCT FROM d."household_id"
  ) OR EXISTS (
    SELECT 1 FROM "ImportMemberMapping" x LEFT JOIN "HouseholdMember" m ON m."id" = x."member_id"
    WHERE m."household_id" IS DISTINCT FROM x."household_id"
  ) OR EXISTS (
    SELECT 1 FROM "ClientDiagnosticReport" x LEFT JOIN "HouseholdMember" m ON m."id" = x."member_id"
    WHERE m."household_id" IS DISTINCT FROM x."household_id"
  ) OR EXISTS (
    SELECT 1 FROM "AppEvent" e JOIN "HouseholdMember" m ON m."id" = e."member_id"
    WHERE e."household_id" IS NOT NULL AND m."household_id" <> e."household_id"
  ) OR EXISTS (
    SELECT 1 FROM "ImportDraftRow" r JOIN "ImportDraft" d ON d."id" = r."draft_id"
    LEFT JOIN "HouseholdMember" a ON a."id" = r."actor_member_id"
    LEFT JOIN "HouseholdMember" c ON c."id" = r."created_by_member_id"
    WHERE (r."actor_member_id" IS NOT NULL AND a."household_id" IS DISTINCT FROM d."household_id")
       OR (r."created_by_member_id" IS NOT NULL AND c."household_id" IS DISTINCT FROM d."household_id")
  ) THEN
    RAISE EXCEPTION 'Existing data contains invalid cross-household or orphan member references';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "Ledger" (
  "id" TEXT NOT NULL,
  "household_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "is_default" BOOLEAN NOT NULL DEFAULT false,
  "archived_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Ledger_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
    WHERE n.nspname=current_schema() AND t.typname='LedgerAuditAction') THEN
    CREATE TYPE "LedgerAuditAction" AS ENUM ('TRANSACTION_CREATED', 'TRANSACTION_UPDATED', 'TRANSACTION_DELETED', 'IMPORT_CONFIRMED');
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS "LedgerAuditLog" (
  "id" TEXT NOT NULL,
  "household_id" TEXT NOT NULL,
  "member_id" TEXT NOT NULL,
  "ledger_id" TEXT NOT NULL,
  "action" "LedgerAuditAction" NOT NULL,
  "target_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LedgerAuditLog_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Transaction" ADD COLUMN IF NOT EXISTS "ledger_id" TEXT;
ALTER TABLE "ImportDraft" ADD COLUMN IF NOT EXISTS "ledger_id" TEXT;
ALTER TABLE "NaturalLanguageRequest" ADD COLUMN IF NOT EXISTS "ledger_id" TEXT;
ALTER TABLE "AppSession" ADD COLUMN IF NOT EXISTS "member_id" TEXT;

INSERT INTO "Ledger" ("id", "household_id", "name", "is_default", "updated_at")
SELECT 'default-ledger:' || h."id", h."id", 'Default', true, CURRENT_TIMESTAMP
FROM "Household" h
WHERE NOT EXISTS (SELECT 1 FROM "Ledger" l WHERE l."household_id" = h."id" AND l."is_default")
ON CONFLICT ("id") DO NOTHING;

-- Bounded set-based writes include soft-deleted rows and every request terminal state.
-- Original timestamps, input hashes, results and source metadata are never rewritten.
DO $$
DECLARE target_table TEXT; changed BIGINT;
BEGIN
  FOREACH target_table IN ARRAY ARRAY['Transaction', 'ImportDraft', 'NaturalLanguageRequest'] LOOP
    LOOP
      EXECUTE format(
        'UPDATE %I t SET ledger_id = l.id FROM "Ledger" l WHERE t.household_id = l.household_id AND l.is_default AND t.id IN (SELECT id FROM %I WHERE ledger_id IS NULL LIMIT 5000)',
        target_table, target_table
      );
      GET DIAGNOSTICS changed = ROW_COUNT;
      EXIT WHEN changed = 0;
    END LOOP;
  END LOOP;
END $$;

-- Bind pre-upgrade sessions to their original membership without renewing or revoking them.
UPDATE "AppSession" s SET "member_id" = m."id"
FROM "HouseholdMember" m
WHERE s."member_id" IS NULL AND m."user_id" = s."user_id" AND m."left_at" IS NULL
  AND (SELECT bind_legacy_sessions FROM billboard_foundation_migration_state);

ALTER TABLE "Transaction" ALTER COLUMN "ledger_id" SET NOT NULL;
ALTER TABLE "ImportDraft" ALTER COLUMN "ledger_id" SET NOT NULL;
ALTER TABLE "NaturalLanguageRequest" ALTER COLUMN "ledger_id" SET NOT NULL;

DROP INDEX IF EXISTS "HouseholdMember_user_id_key";
DROP INDEX IF EXISTS "HouseholdMember_household_id_member_name_key";
CREATE UNIQUE INDEX IF NOT EXISTS "HouseholdMember_active_user_key" ON "HouseholdMember"("user_id") WHERE "left_at" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "HouseholdMember_active_name_key" ON "HouseholdMember"("household_id", "member_name") WHERE "left_at" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "HouseholdMember_active_owner_key" ON "HouseholdMember"("household_id") WHERE "left_at" IS NULL AND "role" = 'OWNER';
CREATE UNIQUE INDEX IF NOT EXISTS "HouseholdMember_id_household_id_key" ON "HouseholdMember"("id", "household_id");
CREATE UNIQUE INDEX IF NOT EXISTS "HouseholdMember_id_user_id_key" ON "HouseholdMember"("id", "user_id");
CREATE INDEX IF NOT EXISTS "HouseholdMember_user_id_idx" ON "HouseholdMember"("user_id");
CREATE UNIQUE INDEX IF NOT EXISTS "Ledger_active_default_key" ON "Ledger"("household_id") WHERE "is_default";
CREATE UNIQUE INDEX IF NOT EXISTS "Ledger_id_household_id_key" ON "Ledger"("id", "household_id");
CREATE INDEX IF NOT EXISTS "Ledger_household_id_idx" ON "Ledger"("household_id");
CREATE INDEX IF NOT EXISTS "Transaction_ledger_id_occurred_at_idx" ON "Transaction"("ledger_id", "occurred_at");
CREATE INDEX IF NOT EXISTS "LedgerAuditLog_household_id_created_at_idx" ON "LedgerAuditLog"("household_id", "created_at");
CREATE INDEX IF NOT EXISTS "LedgerAuditLog_target_id_idx" ON "LedgerAuditLog"("target_id");

ALTER TABLE "Transaction" DROP CONSTRAINT IF EXISTS "Transaction_actor_member_id_fkey";
ALTER TABLE "HouseholdMember" DROP CONSTRAINT IF EXISTS "HouseholdMember_user_id_fkey";
ALTER TABLE "Transaction" DROP CONSTRAINT IF EXISTS "Transaction_created_by_member_id_fkey";
ALTER TABLE "NaturalLanguageRequest" DROP CONSTRAINT IF EXISTS "NaturalLanguageRequest_created_by_member_id_fkey";
ALTER TABLE "ImportMemberMapping" DROP CONSTRAINT IF EXISTS "ImportMemberMapping_member_id_fkey";
ALTER TABLE "ClientDiagnosticReport" DROP CONSTRAINT IF EXISTS "ClientDiagnosticReport_member_id_fkey";
ALTER TABLE "ImportDraft" DROP CONSTRAINT IF EXISTS "ImportDraft_created_by_member_id_fkey";

DO $$
DECLARE item RECORD;
BEGIN
  FOR item IN SELECT * FROM (VALUES
    ('HouseholdMember', 'HouseholdMember_user_id_fkey', 'FOREIGN KEY (user_id) REFERENCES "User"(id) ON DELETE RESTRICT ON UPDATE CASCADE'),
    ('Ledger', 'Ledger_household_id_fkey', 'FOREIGN KEY (household_id) REFERENCES "Household"(id) ON DELETE CASCADE ON UPDATE CASCADE'),
    ('Ledger', 'Ledger_default_not_archived_check', 'CHECK (NOT is_default OR archived_at IS NULL)'),
    ('LedgerAuditLog', 'LedgerAuditLog_household_id_fkey', 'FOREIGN KEY (household_id) REFERENCES "Household"(id) ON DELETE CASCADE ON UPDATE CASCADE'),
    ('LedgerAuditLog', 'LedgerAuditLog_member_id_household_id_fkey', 'FOREIGN KEY (member_id, household_id) REFERENCES "HouseholdMember"(id, household_id) ON DELETE RESTRICT ON UPDATE CASCADE'),
    ('LedgerAuditLog', 'LedgerAuditLog_ledger_id_household_id_fkey', 'FOREIGN KEY (ledger_id, household_id) REFERENCES "Ledger"(id, household_id) ON DELETE RESTRICT ON UPDATE CASCADE'),
    ('Transaction', 'Transaction_actor_member_id_household_id_fkey', 'FOREIGN KEY (actor_member_id, household_id) REFERENCES "HouseholdMember"(id, household_id) ON DELETE RESTRICT ON UPDATE CASCADE'),
    ('Transaction', 'Transaction_created_by_member_id_household_id_fkey', 'FOREIGN KEY (created_by_member_id, household_id) REFERENCES "HouseholdMember"(id, household_id) ON DELETE RESTRICT ON UPDATE CASCADE'),
    ('Transaction', 'Transaction_ledger_id_household_id_fkey', 'FOREIGN KEY (ledger_id, household_id) REFERENCES "Ledger"(id, household_id) ON DELETE RESTRICT ON UPDATE CASCADE'),
    ('NaturalLanguageRequest', 'NaturalLanguageRequest_created_by_member_id_household_id_fkey', 'FOREIGN KEY (created_by_member_id, household_id) REFERENCES "HouseholdMember"(id, household_id) ON DELETE CASCADE ON UPDATE CASCADE'),
    ('NaturalLanguageRequest', 'NaturalLanguageRequest_ledger_id_household_id_fkey', 'FOREIGN KEY (ledger_id, household_id) REFERENCES "Ledger"(id, household_id) ON DELETE RESTRICT ON UPDATE CASCADE'),
    ('ImportDraft', 'ImportDraft_created_by_member_id_household_id_fkey', 'FOREIGN KEY (created_by_member_id, household_id) REFERENCES "HouseholdMember"(id, household_id) ON DELETE RESTRICT ON UPDATE CASCADE'),
    ('ImportDraft', 'ImportDraft_ledger_id_household_id_fkey', 'FOREIGN KEY (ledger_id, household_id) REFERENCES "Ledger"(id, household_id) ON DELETE RESTRICT ON UPDATE CASCADE'),
    ('ImportMemberMapping', 'ImportMemberMapping_member_id_household_id_fkey', 'FOREIGN KEY (member_id, household_id) REFERENCES "HouseholdMember"(id, household_id) ON DELETE CASCADE ON UPDATE CASCADE'),
    ('ClientDiagnosticReport', 'ClientDiagnosticReport_member_id_household_id_fkey', 'FOREIGN KEY (member_id, household_id) REFERENCES "HouseholdMember"(id, household_id) ON DELETE CASCADE ON UPDATE CASCADE'),
    ('ImportDraftRow', 'ImportDraftRow_actor_member_id_fkey', 'FOREIGN KEY (actor_member_id) REFERENCES "HouseholdMember"(id) ON DELETE SET NULL ON UPDATE CASCADE'),
    ('ImportDraftRow', 'ImportDraftRow_created_by_member_id_fkey', 'FOREIGN KEY (created_by_member_id) REFERENCES "HouseholdMember"(id) ON DELETE SET NULL ON UPDATE CASCADE'),
    ('AppSession', 'AppSession_member_id_user_id_fkey', 'FOREIGN KEY (member_id, user_id) REFERENCES "HouseholdMember"(id, user_id) ON DELETE CASCADE ON UPDATE CASCADE')
  ) AS constraints(table_name, constraint_name, definition) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = format('%I', item.table_name)::regclass AND conname = item.constraint_name) THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I %s', item.table_name, item.constraint_name, item.definition);
    END IF;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION billboard_check_import_row_household() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "ImportDraft" d
    LEFT JOIN "HouseholdMember" a ON a."id" = NEW."actor_member_id"
    LEFT JOIN "HouseholdMember" c ON c."id" = NEW."created_by_member_id"
    WHERE d."id" = NEW."draft_id" AND (
      (NEW."actor_member_id" IS NOT NULL AND a."household_id" IS DISTINCT FROM d."household_id") OR
      (NEW."created_by_member_id" IS NOT NULL AND c."household_id" IS DISTINCT FROM d."household_id")
    )
  ) THEN
    RAISE EXCEPTION 'Import row member must belong to its draft household' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS "ImportDraftRow_household_guard" ON "ImportDraftRow";
CREATE TRIGGER "ImportDraftRow_household_guard" BEFORE INSERT OR UPDATE OF "draft_id", "actor_member_id", "created_by_member_id"
ON "ImportDraftRow" FOR EACH ROW EXECUTE FUNCTION billboard_check_import_row_household();

CREATE OR REPLACE FUNCTION billboard_check_event_household() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."household_id" IS NOT NULL AND NEW."member_id" IS NOT NULL AND EXISTS (
    SELECT 1 FROM "HouseholdMember" WHERE "id" = NEW."member_id" AND "household_id" <> NEW."household_id"
  ) THEN
    RAISE EXCEPTION 'Event member must belong to its household' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS "AppEvent_household_guard" ON "AppEvent";
CREATE TRIGGER "AppEvent_household_guard" BEFORE INSERT OR UPDATE OF "household_id", "member_id"
ON "AppEvent" FOR EACH ROW EXECUTE FUNCTION billboard_check_event_household();

CREATE OR REPLACE FUNCTION billboard_preserve_household_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."household_id" IS DISTINCT FROM OLD."household_id" THEN
    RAISE EXCEPTION 'Historical household ownership is immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'HouseholdMember' AND to_jsonb(NEW)->>'user_id' IS DISTINCT FROM to_jsonb(OLD)->>'user_id' THEN
    RAISE EXCEPTION 'Historical membership account is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS "HouseholdMember_identity_guard" ON "HouseholdMember";
CREATE TRIGGER "HouseholdMember_identity_guard" BEFORE UPDATE OF "household_id", "user_id"
ON "HouseholdMember" FOR EACH ROW EXECUTE FUNCTION billboard_preserve_household_identity();
DROP TRIGGER IF EXISTS "Ledger_identity_guard" ON "Ledger";
CREATE TRIGGER "Ledger_identity_guard" BEFORE UPDATE OF "household_id"
ON "Ledger" FOR EACH ROW EXECUTE FUNCTION billboard_preserve_household_identity();
DROP TRIGGER IF EXISTS "ImportDraft_identity_guard" ON "ImportDraft";
CREATE TRIGGER "ImportDraft_identity_guard" BEFORE UPDATE OF "household_id"
ON "ImportDraft" FOR EACH ROW EXECUTE FUNCTION billboard_preserve_household_identity();

COMMIT;
