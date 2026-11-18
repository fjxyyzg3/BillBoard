import { z } from "zod";
import { supportedLocales } from "@/lib/i18n";
import { isValidReportDate } from "@/lib/reports/report-range";

export type RecordExportErrorCode = "unauthorized" | "forbidden" | "invalid_input" | "busy" | "too_large" | "timeout" | "cancelled" | "unavailable";

export class RecordExportError extends Error {
  constructor(readonly code: RecordExportErrorCode) { super(code); }
}

const schema = z.object({
  ledgerId: z.string().trim().min(1).max(128).optional(),
  actorMemberId: z.string().trim().min(1).max(128).optional(),
  from: z.string().refine(isValidReportDate),
  to: z.string().refine(isValidReportDate),
  locale: z.enum(supportedLocales),
}).strict().refine((input) => input.from <= input.to);

export function parseRecordExportInput(value: unknown) {
  const result = schema.safeParse(value);
  if (!result.success) throw new RecordExportError("invalid_input");
  return {
    ...result.data,
    range: {
      from: new Date(`${result.data.from}T00:00:00.000+08:00`),
      to: new Date(`${result.data.to}T23:59:59.999+08:00`),
    },
  };
}

export type RecordExportInput = ReturnType<typeof parseRecordExportInput>;
