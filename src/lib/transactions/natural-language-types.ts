import { z } from "zod";
import { MAX_NATURAL_LANGUAGE_TRANSACTIONS } from "./natural-language-protocol";
import type { NaturalLanguageIssue } from "./natural-language-protocol";
import type { EntryContext } from "./entry-context";

export const NATURAL_LANGUAGE_RESULT_VERSION = 2;
const maxAmountFen = 2147483647;

export const naturalLanguageSummarySchema = z.object({
  resultVersion: z.literal(NATURAL_LANGUAGE_RESULT_VERSION),
  count: z.number().int().min(1).max(MAX_NATURAL_LANGUAGE_TRANSACTIONS),
  incomeCount: z.number().int().min(0).max(MAX_NATURAL_LANGUAGE_TRANSACTIONS),
  expenseCount: z.number().int().min(0).max(MAX_NATURAL_LANGUAGE_TRANSACTIONS),
  incomeAmountFen: z.number().int().min(0).max(MAX_NATURAL_LANGUAGE_TRANSACTIONS * maxAmountFen),
  expenseAmountFen: z.number().int().min(0).max(MAX_NATURAL_LANGUAGE_TRANSACTIONS * maxAmountFen),
}).strict().superRefine((result, context) => {
  if (result.incomeCount + result.expenseCount !== result.count) {
    context.addIssue({ code: "custom", message: "Transaction count mismatch" });
  }
  for (const type of ["income", "expense"] as const) {
    const count = result[`${type}Count`];
    const amountFen = result[`${type}AmountFen`];
    if ((count === 0 && amountFen !== 0) || (count > 0 && (amountFen < count || amountFen > count * maxAmountFen))) {
      context.addIssue({ code: "custom", path: [`${type}AmountFen`], message: "Invalid transaction type total" });
    }
  }
});

const successResultSchema = naturalLanguageSummarySchema.safeExtend({ status: z.literal("success"), requestId: z.string().uuid() });

export type NaturalLanguageErrorCode =
  | "INPUT_EMPTY" | "INPUT_TOO_LONG" | "INVALID_REQUEST" | "CONFLICT" | "CONTEXT_REQUIRED"
  | "NOT_ACCEPTED" | "EXPIRED" | "NEEDS_CORRECTION" | "INVALID_RESPONSE"
  | "BUSY" | "AUTHENTICATION_REQUIRED" | "TIMEOUT" | "UNAVAILABLE" | "STALE" | "CONSENT_REQUIRED";

export type NaturalLanguageActionResult =
  | { status: "processing"; requestId: string }
  | { status: "unknown"; requestId: string }
  | z.infer<typeof successResultSchema>
  | { status: "error"; requestId: string; code: NaturalLanguageErrorCode; issues?: NaturalLanguageIssue[] };

export type NaturalLanguageEntryInput = { requestId: string; text: string; locale: "zh-CN" | "en-US"; resultVersion?: typeof NATURAL_LANGUAGE_RESULT_VERSION; context?: EntryContext; voiceAdmissionId?: string };

export function isCurrentNaturalLanguageSuccessResult(value: unknown): value is Extract<NaturalLanguageActionResult, { status: "success" }> {
  return successResultSchema.safeParse(value).success;
}
