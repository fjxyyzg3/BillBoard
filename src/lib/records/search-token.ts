import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { isRecordAmountFilter, type RecordAmountFilter } from "@/lib/records/amount-filter";
import { z } from "zod";
import type { EntryContext } from "@/lib/transactions/entry-context";
import type { LedgerScope } from "@/lib/ledgers/selection";
import { getEncryptionContext } from "@/lib/encryption/request-context";

const TOKEN_VERSION = "v3";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const MAX_TOKEN_LENGTH = 4096;
const TOKEN_AAD_PREFIX = "billboard-record-search";
const AMOUNT_TOKEN_AAD_PREFIX = "billboard-record-amount";

export type RecordReadContext = { householdId: string; memberId: string; scope: LedgerScope };
type FilterContext = RecordReadContext | EntryContext;
const readContextSchema = z.object({
  householdId: z.string().min(1),
  memberId: z.string().min(1),
  scope: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("household") }),
    z.object({ kind: z.literal("ledger"), ledgerId: z.string().min(1) }),
  ]),
});

function normalizeContext(context: FilterContext): RecordReadContext | undefined {
  if (!context || typeof context !== "object") return undefined;
  const parsed = readContextSchema.safeParse("scope" in context ? context : {
    householdId: context.householdId, memberId: context.memberId,
    scope: { kind: "ledger", ledgerId: context.ledgerId },
  });
  return parsed.success ? parsed.data : undefined;
}

type RecordFilterTokenPayload = {
  context: RecordReadContext;
  search?: string;
  amount?: RecordAmountFilter;
};

function getTokenKey(context: RecordReadContext, purpose: string) {
  const request = getEncryptionContext();
  if (request?.mode === "ENCRYPTED") {
    const ring = request.ring;
    if (!ring || ring.householdId !== context.householdId || request.session.memberId !== context.memberId) throw new Error("Household is locked");
    const key = ring.keys.find((key) => key.generation === ring.generation && key.keyVersion === ring.currentKeyVersion);
    if (!key) throw new Error("Household is locked");
    return Buffer.from(hkdfSync("sha256", Buffer.from(key.secret, "base64url"), Buffer.from(`billboard-filter:${context.householdId}:${ring.generation}:${ring.currentKeyVersion}:${request.revision}`), Buffer.from(purpose), 32));
  }
  const secret = process.env.AUTH_SECRET;

  if (!secret) {
    throw new Error("AUTH_SECRET is required to protect record search tokens");
  }

  return createHash("sha256").update(secret).digest();
}

function getAdditionalAuthenticatedData(context: RecordReadContext, purpose: string) {
  const scope = [context.householdId, context.memberId, context.scope.kind,
    ...(context.scope.kind === "ledger" ? [context.scope.ledgerId] : [])].map(encodeURIComponent).join(":");
  const request = getEncryptionContext();
  const version = request?.mode === "ENCRYPTED" ? `v4:${request.revision}` : TOKEN_VERSION;
  return Buffer.from(`${purpose}:${version}:${scope}`, "utf8");
}

function encode(value: Buffer) {
  return value.toString("base64url");
}

function createToken(payload: RecordFilterTokenPayload, purpose: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", getTokenKey(payload.context, purpose), iv);
  cipher.setAAD(getAdditionalAuthenticatedData(payload.context, purpose));
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(payload)),
    cipher.final(),
  ]);

  return [getEncryptionContext()?.mode === "ENCRYPTED" ? "v4" : TOKEN_VERSION, encode(iv), encode(cipher.getAuthTag()), encode(encrypted)].join(".");
}

function decodeToken(
  token: string | undefined,
  context: FilterContext,
  purpose: string,
): Partial<RecordFilterTokenPayload> | undefined {
  const normalizedContext = normalizeContext(context);
  if (!token || token.length > MAX_TOKEN_LENGTH || !normalizedContext) {
    return undefined;
  }

  const parts = token.split(".");

  if (parts.length !== 4 || parts[0] !== (getEncryptionContext()?.mode === "ENCRYPTED" ? "v4" : TOKEN_VERSION)) {
    return undefined;
  }

  try {
    const iv = Buffer.from(parts[1], "base64url");
    const authTag = Buffer.from(parts[2], "base64url");
    const encrypted = Buffer.from(parts[3], "base64url");

    if (iv.length !== IV_LENGTH || authTag.length !== AUTH_TAG_LENGTH || encrypted.length === 0) {
      return undefined;
    }

    const decipher = createDecipheriv("aes-256-gcm", getTokenKey(normalizedContext, purpose), iv);
    decipher.setAAD(getAdditionalAuthenticatedData(normalizedContext, purpose));
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    const payload = JSON.parse(decrypted.toString("utf8")) as Partial<RecordFilterTokenPayload>;

    const parsedContext = readContextSchema.safeParse(payload.context);
    if (!parsedContext.success || !getAdditionalAuthenticatedData(parsedContext.data, purpose).equals(getAdditionalAuthenticatedData(normalizedContext, purpose))) {
      return undefined;
    }

    return payload;
  } catch {
    return undefined;
  }
}

export function createRecordSearchToken(search: string, context: FilterContext): string | undefined {
  const normalizedSearch = search.trim();

  const normalizedContext = normalizeContext(context);
  if (!normalizedSearch || !normalizedContext) {
    return undefined;
  }

  return createToken({ context: normalizedContext, search: normalizedSearch }, TOKEN_AAD_PREFIX);
}

export function decodeRecordSearchToken(
  token: string | undefined,
  context: FilterContext,
): string | undefined {
  const payload = decodeToken(token, context, TOKEN_AAD_PREFIX);
  return typeof payload?.search === "string" ? payload.search.trim() || undefined : undefined;
}

export function createRecordAmountToken(
  amount: RecordAmountFilter | undefined,
  context: FilterContext,
): string | undefined {
  const normalizedContext = normalizeContext(context);
  if (!isRecordAmountFilter(amount) || !normalizedContext) {
    return undefined;
  }

  return createToken({ context: normalizedContext, amount }, AMOUNT_TOKEN_AAD_PREFIX);
}

export function decodeRecordAmountToken(
  token: string | undefined,
  context: FilterContext,
): RecordAmountFilter | undefined {
  const payload = decodeToken(token, context, AMOUNT_TOKEN_AAD_PREFIX);
  return isRecordAmountFilter(payload?.amount) ? payload.amount : undefined;
}
