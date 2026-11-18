import { handleBillReportPost } from "@/lib/reports/bill-report-http";

export const runtime = "nodejs";
export const maxDuration = 540;

export function POST(request: Request) {
  return handleBillReportPost(request, "analysis");
}
