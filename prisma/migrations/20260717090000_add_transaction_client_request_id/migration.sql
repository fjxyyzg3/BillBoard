-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN "client_request_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_created_by_member_id_client_request_id_key"
ON "Transaction"("created_by_member_id", "client_request_id");
