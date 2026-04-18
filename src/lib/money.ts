export function parseAmountInput(input: string): number {
  const normalized = input.trim();

  if (!/^-?\d+(\.\d{1,2})?$/.test(normalized)) {
    throw new Error("Enter a valid amount with up to two decimals");
  }

  const sign = normalized.startsWith("-") ? -1 : 1;
  const unsigned = sign === -1 ? normalized.slice(1) : normalized;
  const [yuan, decimal = ""] = unsigned.split(".");
  const fen = sign * (Number(yuan) * 100 + Number(decimal.padEnd(2, "0")));

  if (fen <= 0) {
    throw new Error("Amount must be greater than zero");
  }

  return fen;
}

export function formatFen(fen: number): string {
  const yuan = Math.floor(fen / 100);
  const cents = String(fen % 100).padStart(2, "0");

  return `${yuan}.${cents}`;
}
