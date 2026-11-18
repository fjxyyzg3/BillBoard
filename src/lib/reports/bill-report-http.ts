import { z } from "zod";
import { after } from "next/server";
import { requireAppSession } from "@/lib/auth/session";
import { parseEncryptionInput, withHouseholdEncryption } from "@/lib/encryption/request";
import { billAnalysisScopeSchema } from "@/lib/reports/bill-analysis-protocol";
import { billAnalysisErrorCode } from "@/lib/reports/bill-analysis-service";
import { queryBillAnalysisRequest, cancelBillAnalysisRequest, readBillAnalysisReport, listBillAnalysisReports, listBillAnalysisEntries, BillAnalysisStoreError } from "@/lib/reports/bill-analysis-store";
import { abortBillAnalysisExecution, reapStoppedBillAnalysisExecutions } from "@/lib/reports/bill-analysis-owner";
import { assertEncryptionTransport } from "@/lib/encryption/transport";
import { createBillAnalysisTaskContext } from "@/lib/reports/bill-analysis-task-context";
import { submitBillAnalysisTask } from "@/lib/reports/bill-analysis-runtime";
import { getServerLocale } from "@/lib/i18n-server";
import { parseReconciliationApplyInput } from "./bill-reconciliation-application-protocol";

const requestId = z.string().uuid();
const id = z.string().min(1).max(128);
const inputSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("generate"), requestId, scope: billAnalysisScopeSchema, locale: z.enum(["zh-CN", "en-US"]) }).strict(),
  z.object({ operation: z.literal("query"), requestId }).strict(),
  z.object({ operation: z.literal("cancel"), requestId }).strict(),
  z.object({ operation: z.literal("report"), reportId: id.optional(), scope: billAnalysisScopeSchema.optional() }).strict().refine((input) => Boolean(input.reportId) !== Boolean(input.scope)),
  z.object({ operation: z.literal("list"), cursor: z.string().max(2048).optional() }).strict(),
  z.object({ operation: z.literal("query-application"), requestId }).strict(),
  z.object({ operation: z.literal("entries"), cursor: z.string().max(2048).optional(), locale: z.enum(["zh-CN", "en-US"]).optional() }).strict(),
]);
const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };
class InputError extends Error { constructor(readonly status: number) { super("Invalid analysis request"); } }

function assertOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host") ?? new URL(request.url).host;
  const forwardedHost = request.headers.get("x-forwarded-host");
  const protocol = request.headers.get("x-forwarded-proto") ?? new URL(request.url).protocol.slice(0, -1);
  const site = request.headers.get("sec-fetch-site");
  if ((forwardedHost && forwardedHost !== host) || (site && site !== "same-origin") || !["http", "https"].includes(protocol) || !origin) throw new InputError(403);
  try { if (new URL(origin).origin !== origin || origin !== new URL(`${protocol}://${host}`).origin) throw new Error(); }
  catch { throw new InputError(403); }
}

async function readInput(request: Request) {
  const length = request.headers.get("content-length");
  if (new URL(request.url).search || request.headers.get("content-type")?.split(";")[0].trim() !== "application/json"
    || (request.headers.get("content-encoding") && request.headers.get("content-encoding") !== "identity")
    || (length && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length))))) throw new InputError(400);
  if (length && Number(length) > 16 * 1024) throw new InputError(413);
  if (!request.body) throw new InputError(400);
  const reader = request.body.getReader();
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]);
  let cancellation: Promise<void> | undefined;
  const cancel = () => { cancellation ??= reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (signal.aborted) cancel();
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > 16 * 1024) throw new InputError(413);
      chunks.push(value);
    }
    const raw: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new InputError(400);
    const body = raw as Record<string, unknown>;
    const encryption = parseEncryptionInput(body.encryption);
    delete body.encryption;
    if (body.operation === "apply") {
      const application = { ...body };
      delete application.operation;
      return { input: { operation: "apply" as const, ...parseReconciliationApplyInput(application) }, encryption };
    }
    return { input: inputSchema.parse(body), encryption };
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
    await cancellation;
    reader.releaseLock();
  }
}

export async function handleBillReportPost(request: Request, purpose: "analysis" | "reconciliation") {
  const startedAt = Date.now();
  try {
    const original = await requireAppSession();
    assertOrigin(request);
    const { input, encryption } = await readInput(request);
    request.signal.throwIfAborted();
    if (input.operation === "generate") {
      if (purpose !== "reconciliation") throw new InputError(410);
      if (encryption?.code) assertEncryptionTransport(request.headers);
      const context = await createBillAnalysisTaskContext(original, encryption, startedAt);
      const result = await submitBillAnalysisTask(original, { ...input, purpose }, context, startedAt, (completion) => after(completion));
      return Response.json({ result }, { headers });
    }
    if (input.operation === "entries") await reapStoppedBillAnalysisExecutions();
    const locale = input.operation === "entries" && input.locale ? input.locale : await getServerLocale();
    const result = await withHouseholdEncryption(encryption, async (session) => {
      if (session.appSessionId !== original.appSessionId) throw new Error("Unauthorized");
      if (input.operation === "apply") {
        if (purpose !== "reconciliation") throw new InputError(410);
        const { applyBillReconciliation } = await import("./bill-reconciliation-application");
        const common = { requestId: input.requestId, reportId: input.reportId, generation: input.generation, suggestionIds: input.suggestionIds };
        if (input.version === 3) return { result: await applyBillReconciliation(session, { ...common, version: 3, manualGroups: input.manualGroups }) };
        return { result: await applyBillReconciliation(session, input.version === 2 ? { ...common, version: 2, manualGroups: input.manualGroups } : common) };
      }
      if (input.operation === "query-application") {
        if (purpose !== "reconciliation") throw new InputError(410);
        const { queryBillReconciliationApplication } = await import("./bill-reconciliation-application");
        return { result: await queryBillReconciliationApplication(session, input.requestId) };
      }
      if (input.operation === "query") {
        await reapStoppedBillAnalysisExecutions();
        try { return { result: await queryBillAnalysisRequest(session, input.requestId) }; }
        catch (error) {
          if (error instanceof BillAnalysisStoreError && error.code === "CONFLICT") return { result: { requestId: input.requestId, status: "error", error: "CONFLICT" } };
          throw error;
        }
      }
      if (input.operation === "cancel") {
        let result;
        try { result = await cancelBillAnalysisRequest(session, input.requestId); }
        catch (error) {
          if (error instanceof BillAnalysisStoreError && error.code === "CONFLICT") return { result: { requestId: input.requestId, status: "error", error: "CONFLICT" } };
          throw error;
        }
        if (result.status === "stopping") abortBillAnalysisExecution(session, input.requestId);
        return { result };
      }
      if (input.operation === "report") return { report: await readBillAnalysisReport(session, { ...input, purpose }, locale) };
      if (input.operation === "entries") return listBillAnalysisEntries(session, input.cursor, locale);
      return listBillAnalysisReports(session, input.cursor, locale);
    }, { readOnly: input.operation === "report" || input.operation === "list" || input.operation === "entries", receiptQuery: input.operation === "query" || input.operation === "cancel" || input.operation === "query-application" });
    return Response.json(result, { headers });
  } catch (error) {
    const code = error instanceof InputError || error instanceof z.ZodError || error instanceof SyntaxError ? "INVALID" : billAnalysisErrorCode(error);
    const status = error instanceof InputError ? error.status : code === "UNAUTHORIZED" ? 401 : code === "INVALID" ? 400 : code === "ENCRYPTION_CHANGED" ? 409 : 503;
    return Response.json({ error: code }, { status, headers });
  }
}
