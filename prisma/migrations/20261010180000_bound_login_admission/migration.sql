CREATE TABLE "LoginBudget" (
    "id" INTEGER NOT NULL,
    "tokens" INTEGER NOT NULL,
    "refilled_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoginBudget_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "LoginBudget_singleton" CHECK ("id" = 1),
    CONSTRAINT "LoginBudget_token_bounds" CHECK ("tokens" BETWEEN 0 AND 10)
);

INSERT INTO "LoginBudget" ("id", "tokens", "refilled_at")
VALUES (1, 10, CURRENT_TIMESTAMP);

CREATE TABLE "LoginAttemptLease" (
    "slot" INTEGER NOT NULL,
    "token" TEXT NOT NULL,
    "user_id" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoginAttemptLease_pkey" PRIMARY KEY ("slot"),
    CONSTRAINT "LoginAttemptLease_slot_bounds" CHECK ("slot" BETWEEN 0 AND 1)
);

CREATE UNIQUE INDEX "LoginAttemptLease_token_key" ON "LoginAttemptLease"("token");
CREATE UNIQUE INDEX "LoginAttemptLease_user_id_key" ON "LoginAttemptLease"("user_id");
