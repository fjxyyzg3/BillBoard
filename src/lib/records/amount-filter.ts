export type RecordAmountFilter =
  | { mode: "exact"; valueFen: number }
  | { mode: "range"; minFen?: number; maxFen?: number };

export type RecordAmountFilterError = "invalidAmount" | "invalidAmountRange";

const MAX_AMOUNT_FEN = 2_147_483_647;

function parseOptionalAmount(value: string | null | undefined): number | undefined {
  const normalized = value?.trim();

  if (!normalized) {
    return undefined;
  }

  if (normalized.length > 30 || !/^\d+(\.\d{1,2})?$/.test(normalized)) {
    throw new Error("invalidAmount");
  }

  const [yuan, cents = ""] = normalized.split(".");
  const fen = BigInt(yuan) * 100n + BigInt(cents.padEnd(2, "0"));

  if (fen > BigInt(MAX_AMOUNT_FEN)) {
    throw new Error("invalidAmount");
  }

  return Number(fen);
}

export function parseRecordAmountFilter(input: {
  mode?: string | null;
  exact?: string | null;
  min?: string | null;
  max?: string | null;
}): RecordAmountFilter | undefined {
  if (!input.mode || input.mode === "any") {
    return undefined;
  }

  if (input.mode === "exact") {
    const valueFen = parseOptionalAmount(input.exact);
    return valueFen === undefined ? undefined : { mode: "exact", valueFen };
  }

  if (input.mode !== "range") {
    throw new Error("invalidAmount");
  }

  const minFen = parseOptionalAmount(input.min);
  const maxFen = parseOptionalAmount(input.max);

  if (minFen === undefined && maxFen === undefined) {
    return undefined;
  }
  if (minFen !== undefined && maxFen !== undefined && minFen > maxFen) {
    throw new Error("invalidAmountRange");
  }

  return { mode: "range", minFen, maxFen };
}

export function isRecordAmountFilter(value: unknown): value is RecordAmountFilter {
  if (!value || typeof value !== "object") {
    return false;
  }

  const filter = value as Partial<Record<string, unknown>>;
  const isFen = (fen: unknown): fen is number =>
    typeof fen === "number" && Number.isSafeInteger(fen) && fen >= 0 && fen <= MAX_AMOUNT_FEN;

  if (filter.mode === "exact") {
    return isFen(filter.valueFen);
  }

  return filter.mode === "range"
    && (filter.minFen !== undefined || filter.maxFen !== undefined)
    && (filter.minFen === undefined || isFen(filter.minFen))
    && (filter.maxFen === undefined || isFen(filter.maxFen))
    && !(isFen(filter.minFen) && isFen(filter.maxFen) && filter.minFen > filter.maxFen);
}
