ALTER TABLE "ResourceLease"
  ADD COLUMN task_key TEXT,
  ADD COLUMN waiters INTEGER NOT NULL DEFAULT 0 CHECK (waiters BETWEEN 0 AND 2);
CREATE INDEX "ResourceLease_kind_household_id_task_key_expires_at_idx"
  ON "ResourceLease"(kind, household_id, task_key, expires_at);
