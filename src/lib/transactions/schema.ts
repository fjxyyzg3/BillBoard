import { z } from "zod";
import { parseAmountInput } from "@/lib/money";

const transactionTypes = ["income", "expense"] as const;

export const createTransactionSchema = z.object({
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

    const occurredAt = new Date(value);

    if (Number.isNaN(occurredAt.getTime())) {
      context.addIssue({
        code: "custom",
        message: "Choose a valid date and time",
      });

      return z.NEVER;
    }

    return occurredAt;
  }),
  note: z.string().trim().optional().transform((value) => value || undefined),
});

export type CreateTransactionInput = z.input<typeof createTransactionSchema>;
export type CreateTransactionData = z.output<typeof createTransactionSchema>;
