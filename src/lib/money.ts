const INVALID_AMOUNT_MESSAGE = "Enter a valid amount with up to two decimals";
const NON_POSITIVE_AMOUNT_MESSAGE = "Amount must be greater than zero";
const MAX_AMOUNT_FEN = 2_147_483_647n;
const MAX_AMOUNT_INPUT_LENGTH = 120;

type Rational = {
  denominator: bigint;
  numerator: bigint;
};

type NumberToken = {
  type: "number";
  value: Rational;
};

type OperatorToken = {
  type: "operator";
  value: "+" | "-" | "*" | "/";
};

type ParenthesisToken = {
  type: "parenthesis";
  value: "(" | ")";
};

type Token = NumberToken | OperatorToken | ParenthesisToken;

const directAmountPattern = /^-?\d+(\.\d{1,2})?$/;
const amountSymbolMap: Record<string, string> = {
  "＋": "+",
  "－": "-",
  "＊": "*",
  "／": "/",
  "（": "(",
  "）": ")",
  "。": ".",
  "．": ".",
  "×": "*",
  "÷": "/",
};

function normalizeAmountInput(input: string) {
  return input
    .trim()
    .replace(/[＋－＊／（）。．×÷]/g, (symbol) => amountSymbolMap[symbol] ?? symbol);
}

function ensureInputLength(value: string) {
  if (value.length === 0 || value.length > MAX_AMOUNT_INPUT_LENGTH) {
    throw new Error(INVALID_AMOUNT_MESSAGE);
  }
}

function hasExpressionSyntax(value: string) {
  return /[+\-*/()]/.test(value);
}

function isDigit(value: string) {
  return value >= "0" && value <= "9";
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;

  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }

  return a === 0n ? 1n : a;
}

function createRational(numerator: bigint, denominator: bigint): Rational {
  if (denominator === 0n) {
    throw new Error(INVALID_AMOUNT_MESSAGE);
  }

  let normalizedNumerator = numerator;
  let normalizedDenominator = denominator;

  if (normalizedDenominator < 0n) {
    normalizedNumerator = -normalizedNumerator;
    normalizedDenominator = -normalizedDenominator;
  }

  const divisor = greatestCommonDivisor(normalizedNumerator, normalizedDenominator);

  return {
    numerator: normalizedNumerator / divisor,
    denominator: normalizedDenominator / divisor,
  };
}

function addRational(left: Rational, right: Rational) {
  return createRational(
    left.numerator * right.denominator + right.numerator * left.denominator,
    left.denominator * right.denominator,
  );
}

function subtractRational(left: Rational, right: Rational) {
  return createRational(
    left.numerator * right.denominator - right.numerator * left.denominator,
    left.denominator * right.denominator,
  );
}

function multiplyRational(left: Rational, right: Rational) {
  return createRational(left.numerator * right.numerator, left.denominator * right.denominator);
}

function divideRational(left: Rational, right: Rational) {
  if (right.numerator === 0n) {
    throw new Error(INVALID_AMOUNT_MESSAGE);
  }

  return createRational(left.numerator * right.denominator, left.denominator * right.numerator);
}

function parseNumberLiteral(value: string): Rational {
  const [yuanText, decimalText = ""] = value.split(".");
  const denominator = decimalText.length === 0 ? 1n : decimalText.length === 1 ? 10n : 100n;
  const numerator = BigInt(yuanText) * denominator + BigInt(decimalText || "0");

  return createRational(numerator, denominator);
}

function tokenizeExpression(value: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < value.length) {
    const current = value[index];

    if (!current) {
      break;
    }

    if (/\s/.test(current)) {
      index += 1;
      continue;
    }

    if (isDigit(current)) {
      const start = index;

      while (index < value.length && isDigit(value[index] ?? "")) {
        index += 1;
      }

      if (value[index] === ".") {
        index += 1;
        const decimalStart = index;

        while (index < value.length && isDigit(value[index] ?? "")) {
          index += 1;
        }

        const decimalLength = index - decimalStart;

        if (decimalLength === 0 || decimalLength > 2) {
          throw new Error(INVALID_AMOUNT_MESSAGE);
        }
      }

      tokens.push({
        type: "number",
        value: parseNumberLiteral(value.slice(start, index)),
      });
      continue;
    }

    if (current === "+" || current === "-" || current === "*" || current === "/") {
      tokens.push({ type: "operator", value: current });
      index += 1;
      continue;
    }

    if (current === "(" || current === ")") {
      tokens.push({ type: "parenthesis", value: current });
      index += 1;
      continue;
    }

    throw new Error(INVALID_AMOUNT_MESSAGE);
  }

  return tokens;
}

function parseExpressionTokens(tokens: Token[]): Rational {
  let index = 0;

  function peek() {
    return tokens[index];
  }

  function parseExpression(): Rational {
    let value = parseTerm();

    while (true) {
      const token = peek();

      if (token?.type !== "operator" || (token.value !== "+" && token.value !== "-")) {
        return value;
      }

      index += 1;
      const right = parseTerm();
      value = token.value === "+" ? addRational(value, right) : subtractRational(value, right);
    }
  }

  function parseTerm(): Rational {
    let value = parseUnary();

    while (true) {
      const token = peek();

      if (token?.type !== "operator" || (token.value !== "*" && token.value !== "/")) {
        return value;
      }

      index += 1;
      const right = parseUnary();
      value = token.value === "*" ? multiplyRational(value, right) : divideRational(value, right);
    }
  }

  function parseUnary(): Rational {
    const token = peek();

    if (token?.type === "operator" && token.value === "-") {
      index += 1;
      return multiplyRational(createRational(-1n, 1n), parseUnary());
    }

    return parsePrimary();
  }

  function parsePrimary(): Rational {
    const token = peek();

    if (token?.type === "number") {
      index += 1;
      return token.value;
    }

    if (token?.type === "parenthesis" && token.value === "(") {
      index += 1;
      const value = parseExpression();
      const closeToken = peek();

      if (closeToken?.type !== "parenthesis" || closeToken.value !== ")") {
        throw new Error(INVALID_AMOUNT_MESSAGE);
      }

      index += 1;
      return value;
    }

    throw new Error(INVALID_AMOUNT_MESSAGE);
  }

  if (tokens.length === 0) {
    throw new Error(INVALID_AMOUNT_MESSAGE);
  }

  const value = parseExpression();

  if (index !== tokens.length) {
    throw new Error(INVALID_AMOUNT_MESSAGE);
  }

  return value;
}

function validateFen(fen: bigint): number {
  if (fen <= 0n) {
    throw new Error(NON_POSITIVE_AMOUNT_MESSAGE);
  }

  if (fen > MAX_AMOUNT_FEN) {
    throw new Error(INVALID_AMOUNT_MESSAGE);
  }

  return Number(fen);
}

function rationalToRoundedFen(value: Rational): number {
  if (value.numerator <= 0n) {
    throw new Error(NON_POSITIVE_AMOUNT_MESSAGE);
  }

  const scaledNumerator = value.numerator * 100n;
  const quotient = scaledNumerator / value.denominator;
  const remainder = scaledNumerator % value.denominator;
  const roundedFen = quotient + (remainder * 2n >= value.denominator ? 1n : 0n);

  return validateFen(roundedFen);
}

function parseDirectAmountInput(normalized: string): number {
  if (!directAmountPattern.test(normalized)) {
    throw new Error(INVALID_AMOUNT_MESSAGE);
  }

  const sign = normalized.startsWith("-") ? -1n : 1n;
  const unsigned = sign === -1n ? normalized.slice(1) : normalized;
  const [yuan, decimal = ""] = unsigned.split(".");
  const fen = sign * (BigInt(yuan) * 100n + BigInt(decimal.padEnd(2, "0")));

  return validateFen(fen);
}

function parseExpressionAmountInput(normalized: string): number {
  return rationalToRoundedFen(parseExpressionTokens(tokenizeExpression(normalized)));
}

export function parseAmountInput(input: string): number {
  const normalized = normalizeAmountInput(input);

  ensureInputLength(normalized);

  if (hasExpressionSyntax(normalized)) {
    return parseExpressionAmountInput(normalized);
  }

  return parseDirectAmountInput(normalized);
}

export function getAmountExpressionPreviewFen(input: string): number | null {
  const normalized = normalizeAmountInput(input);

  if (!hasExpressionSyntax(normalized)) {
    return null;
  }

  try {
    ensureInputLength(normalized);
    return parseExpressionAmountInput(normalized);
  } catch {
    return null;
  }
}

export function formatFen(fen: number): string {
  const yuan = Math.floor(fen / 100);
  const cents = String(fen % 100).padStart(2, "0");

  return `${yuan}.${cents}`;
}
