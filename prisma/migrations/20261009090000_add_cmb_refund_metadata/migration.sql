ALTER TABLE "ImportDraftRow"
ADD COLUMN "refund_original_amount_fen" INTEGER,
ADD COLUMN "refund_source_fingerprints" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

CREATE INDEX "ImportDraftRow_refund_source_fingerprints_idx"
ON "ImportDraftRow" USING GIN ("refund_source_fingerprints");
