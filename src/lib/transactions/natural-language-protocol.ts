import { z } from "zod";
import { parseShanghaiDateTimeLocal } from "./datetime";

export const NATURAL_LANGUAGE_SCHEMA_VERSION = "natural-language-entry.v2";
export const MAX_NATURAL_LANGUAGE_TEXT_LENGTH = 2000;
export const MAX_NATURAL_LANGUAGE_TRANSACTIONS = 20;

export function normalizeNaturalLanguageText(text: string): string {
  return text.replace(/\r\n?/g, "\n").trim();
}

const categoryId = z.string().regex(/^c\d{1,6}$/);
const memberId = z.string().regex(/^m\d{1,6}$/);
const transactionType = z.enum(["INCOME", "EXPENSE"]);
const candidateName = z.string().min(1).max(200);
const localDateTime = z.string().refine((value) => {
  try { parseShanghaiDateTimeLocal(value); return true; }
  catch { return false; }
}, "Invalid Shanghai date and time");
const offset = z.number().int().nonnegative();
const issueCode = z.enum([
  "missing_amount", "ambiguous_amount", "ambiguous_date", "ambiguous_member",
  "unsupported_transaction", "unclear_expense", "too_many_expenses",
]);
const issueSchema = z.object({ code: issueCode, start: offset, end: offset }).strict();

export const naturalLanguageRequestSchema = z.object({
  schemaVersion: z.literal(NATURAL_LANGUAGE_SCHEMA_VERSION),
  text: z.string().transform(normalizeNaturalLanguageText).pipe(z.string().min(1).max(MAX_NATURAL_LANGUAGE_TEXT_LENGTH)),
  referenceDateTime: localDateTime,
  categories: z.array(z.object({ id: categoryId, name: candidateName, displayName: candidateName, type: transactionType }).strict()).min(1).max(100),
  members: z.array(z.object({ id: memberId, displayName: candidateName }).strict()).min(1).max(2),
  currentMemberId: memberId,
}).strict().superRefine((request, context) => {
  for (const field of ["categories", "members"] as const) {
    if (new Set(request[field].map(({ id }) => id)).size !== request[field].length) {
      context.addIssue({ code: "custom", path: [field], message: "Duplicate identifiers" });
    }
  }
  if (!request.members.some(({ id }) => id === request.currentMemberId)) {
    context.addIssue({ code: "custom", path: ["currentMemberId"], message: "Unknown current member" });
  }
});

export const naturalLanguageResponseSchema = z.discriminatedUnion("outcome", [
  z.object({
    schemaVersion: z.literal(NATURAL_LANGUAGE_SCHEMA_VERSION),
    outcome: z.literal("success"),
    transactions: z.array(z.object({
      start: offset,
      end: offset,
      type: transactionType,
      amountFen: z.number().int().positive().max(2147483647),
      occurredAt: localDateTime.nullable(),
      memberId,
      categoryId,
      note: z.string().max(200),
    }).strict()).min(1).max(MAX_NATURAL_LANGUAGE_TRANSACTIONS),
  }).strict(),
  z.object({
    schemaVersion: z.literal(NATURAL_LANGUAGE_SCHEMA_VERSION),
    outcome: z.literal("needs_correction"),
    issues: z.array(issueSchema).min(1).max(MAX_NATURAL_LANGUAGE_TRANSACTIONS),
  }).strict(),
]);

export type NaturalLanguageRequest = z.infer<typeof naturalLanguageRequestSchema>;
export type NaturalLanguageResponse = z.infer<typeof naturalLanguageResponseSchema>;
export type NaturalLanguageIssue = z.infer<typeof issueSchema>;
export type NaturalLanguageIssueCode = z.infer<typeof issueCode>;

export function validateNaturalLanguageRequest(input: unknown): NaturalLanguageRequest {
  return naturalLanguageRequestSchema.parse(input);
}

function isCodePointBoundary(text: string, index: number): boolean {
  if (index === 0 || index === text.length) return true;
  const previous = text.charCodeAt(index - 1);
  const current = text.charCodeAt(index);
  return !(previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff);
}

export function validateNaturalLanguageResponse(request: NaturalLanguageRequest, input: unknown): NaturalLanguageResponse {
  const response = naturalLanguageResponseSchema.parse(input);
  const text = normalizeNaturalLanguageText(request.text);
  const ranges = response.outcome === "success" ? response.transactions : response.issues;
  const evidence = new Set<string>();
  for (const item of ranges) {
    if (item.start >= item.end || item.end > text.length
      || !isCodePointBoundary(text, item.start) || !isCodePointBoundary(text, item.end)
      || !text.slice(item.start, item.end).trim()) {
      throw new Error("Invalid natural-language evidence range");
    }
    if (response.outcome === "success") {
      const key = `${item.start}:${item.end}`;
      if (evidence.has(key)) throw new Error("Duplicate natural-language evidence");
      evidence.add(key);
    }
  }
  if (response.outcome === "success") {
    const categories = new Map(request.categories.map(({ id, type }) => [id, type]));
    const members = new Set(request.members.map(({ id }) => id));
    for (const transaction of response.transactions) {
      if (!categories.has(transaction.categoryId) || !members.has(transaction.memberId)) {
        throw new Error("Unknown natural-language candidate");
      }
      if (categories.get(transaction.categoryId) !== transaction.type) {
        throw new Error("Natural-language category type mismatch");
      }
    }
  }
  return response;
}
