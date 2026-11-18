CREATE TABLE "IdentityMailLease" (
  "slot" INTEGER NOT NULL,
  "token" TEXT NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "IdentityMailLease_pkey" PRIMARY KEY ("slot"),
  CONSTRAINT "IdentityMailLease_slot_check" CHECK ("slot" >= 0 AND "slot" < 2)
);
CREATE UNIQUE INDEX "IdentityMailLease_token_key" ON "IdentityMailLease"("token");
