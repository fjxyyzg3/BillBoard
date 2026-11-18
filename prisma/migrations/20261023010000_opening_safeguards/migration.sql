ALTER TYPE "UserStatus" ADD VALUE IF NOT EXISTS 'DEACTIVATED';

ALTER TABLE "User"
  ADD COLUMN ai_processing_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN voice_processing_enabled BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "ResourceWindow" (
  key TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('global', 'household', 'member')),
  subject_id TEXT NOT NULL,
  started_at TIMESTAMP(3) NOT NULL,
  used INTEGER NOT NULL DEFAULT 0 CHECK (used >= 0)
);
CREATE INDEX "ResourceWindow_started_at_idx" ON "ResourceWindow"(started_at);

CREATE TABLE "ResourceLease" (
  token TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('import', 'ai', 'voice', 'export')),
  household_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  expires_at TIMESTAMP(3) NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ResourceLease_household_id_fkey" FOREIGN KEY (household_id) REFERENCES "Household"(id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ResourceLease_member_id_household_id_fkey" FOREIGN KEY (member_id, household_id) REFERENCES "HouseholdMember"(id, household_id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "ResourceLease_kind_expires_at_idx" ON "ResourceLease"(kind, expires_at);
CREATE INDEX "ResourceLease_household_id_kind_expires_at_idx" ON "ResourceLease"(household_id, kind, expires_at);
CREATE INDEX "ResourceLease_member_id_kind_expires_at_idx" ON "ResourceLease"(member_id, kind, expires_at);

CREATE TABLE "VoiceProcessingAdmission" (
  id TEXT PRIMARY KEY,
  client_request_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  household_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  ledger_id TEXT NOT NULL,
  app_session_id TEXT NOT NULL,
  audio_hash TEXT NOT NULL,
  text_hash TEXT,
  expires_at TIMESTAMP(3) NOT NULL,
  consumed_at TIMESTAMP(3),
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "VoiceProcessingAdmission_household_id_fkey" FOREIGN KEY (household_id) REFERENCES "Household"(id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "VoiceProcessingAdmission_member_id_household_id_fkey" FOREIGN KEY (member_id, household_id) REFERENCES "HouseholdMember"(id, household_id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "VoiceProcessingAdmission_ledger_id_household_id_fkey" FOREIGN KEY (ledger_id, household_id) REFERENCES "Ledger"(id, household_id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "VoiceProcessingAdmission_household_id_member_id_client_request_id_key" ON "VoiceProcessingAdmission"(household_id, member_id, client_request_id);
CREATE INDEX "VoiceProcessingAdmission_expires_at_idx" ON "VoiceProcessingAdmission"(expires_at);
