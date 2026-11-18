import { z } from "zod";
import { parseAmountInput } from "@/lib/money";
import { parseShanghaiDateTimeLocal } from "@/lib/transactions/datetime";
import { entryContextSchema } from "./entry-context";

const transactionTypes = ["income", "expense"] as const;

export const transactionPayloadSchema = z.object({
  context: entryContextSchema.optional(),
  type: z.enum(transactionTypes, {
    error: "Select income or expense",
  }),
  amount: z.string().trim().transform((value, context) => {
    try {
      return parseAmountInput(value);
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "Enter a valid amount",
      });

      return z.NEVER;
    }
  }),
  categoryId: z.string().trim().min(1, "Select a category"),
  actorMemberId: z.string().trim().min(1, "Select who made the transaction"),
  occurredAt: z.string().trim().transform((value, context) => {
    if (value.length === 0) {
      context.addIssue({
        code: "custom",
        message: "Choose when the transaction happened",
      });

      return z.NEVER;
    }

    try {
      return parseShanghaiDateTimeLocal(value);
    } catch {
      context.addIssue({
        code: "custom",
        message: "Choose a valid date and time",
      });

      return z.NEVER;
    }
  }),
  note: z.string().trim().optional().transform((value) => value || undefined),
});

export const updateTransactionPayloadSchema = transactionPayloadSchema.partial({
  type: true,
  amount: true,
  categoryId: true,
  actorMemberId: true,
  occurredAt: true,
  note: true,
}).extend({
  context: entryContextSchema,
  targetLedgerId: z.string().trim().min(1).optional(),
});

export type UpdateTransactionInput = z.input<typeof updateTransactionPayloadSchema>;

export const createTransactionSubmissionSchema = transactionPayloadSchema.extend({
  clientRequestId: z.string().uuid("Invalid transaction request ID"),
});

export const createTransactionSchema = createTransactionSubmissionSchema.extend({
  context: entryContextSchema,
});

export type CreateTransactionInput = z.input<typeof createTransactionSchema>;
export type CreateTransactionData = z.output<typeof createTransactionSchema>;
