import { cookies } from "next/headers";
import { z } from "zod";
import { loadHomePage } from "@/app/(app)/home/loader";
import { loadAddPage } from "@/app/(app)/add/loader";
import { loadRecordsPage } from "@/app/(app)/records/loader";
import { loadReconciliationPage } from "@/app/(app)/records/reconcile/loader";
import { loadImportPage } from "@/app/(app)/records/import/loader";
import { loadMappingsPage } from "@/app/(app)/records/import/mappings/loader";
import { loadLedgersPage } from "@/app/(app)/ledgers/loader";
import { requireAppSession } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { withHouseholdEncryption } from "@/lib/encryption/request";
import { readEncryptionBody } from "@/lib/encryption/body";
import { encodeViewData } from "@/lib/encryption/view-data";
import { loadLedgerCatalog } from "@/lib/ledgers/server";
import { LEDGER_PREFERENCE_COOKIE } from "@/lib/ledgers/selection";
import { getServerLocale } from "@/lib/i18n-server";
import { processingServices } from "@/lib/processing/preferences";

export const runtime = "nodejs";
const schema = z.object({
  page: z.enum(["home", "add", "records", "reconciliation", "import", "mappings", "ledgers"]),
  search: z.string().max(12_000),
  encryption: z.object({ code: z.string().max(4096), revision: z.number().int().nonnegative() }).strict().optional(),
}).strict();
const headers = { "Cache-Control": "no-store, private", "Referrer-Policy": "no-referrer" };

async function input(request: Request) {
  const url = new URL(request.url);
  const origin = request.headers.get("origin");
  const site = request.headers.get("sec-fetch-site");
  const host = request.headers.get("host") ?? url.host;
  const forwarded = request.headers.get("x-forwarded-host");
  const protocol = request.headers.get("x-forwarded-proto") ?? url.protocol.slice(0, -1);
  if (url.search || !origin || (site && site !== "same-origin") || (forwarded && forwarded !== host)
    || !["https", "http"].includes(protocol) || origin !== new URL(`${protocol}://${host}`).origin) throw new Error("INVALID_VIEW_REQUEST");
  if (request.headers.get("content-type")?.split(";", 1)[0] !== "application/json"
    || (request.headers.get("content-encoding") && request.headers.get("content-encoding") !== "identity")) throw new Error("INVALID_VIEW_REQUEST");
  return schema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readEncryptionBody(request, 20_000))));
}

export async function POST(request: Request) {
  try {
    await requireAppSession();
    const body = await input(request);
    return await withHouseholdEncryption(body.encryption, async (session) => {
      const params = new URLSearchParams(body.search);
      const search: Record<string, string | string[]> = {};
      for (const key of new Set(params.keys())) {
        const values = params.getAll(key);
        search[key] = values.length === 1 ? values[0] : values;
      }
      const props = { searchParams: Promise.resolve(search) };
      let data: unknown;
      switch (body.page) {
        case "home": data = await loadHomePage(props); break;
        case "add": data = await loadAddPage(props as Parameters<typeof loadAddPage>[0]); break;
        case "records": data = await loadRecordsPage(props); break;
        case "reconciliation": data = await loadReconciliationPage(props); break;
        case "import": data = await loadImportPage(props); break;
        case "mappings": data = await loadMappingsPage(); break;
        case "ledgers": data = await loadLedgersPage(); break;
      }
      const [catalog, locale, cookieStore, choices] = await Promise.all([
        loadLedgerCatalog(session), getServerLocale(), cookies(),
        db.user.findUnique({ where: { id: session.id }, select: { aiProcessingEnabled: true, voiceProcessingEnabled: true } }),
      ]);
      const result = encodeViewData({ page: body.page, data, shell: {
        locale, catalog, currentMemberId: session.memberId,
        initialPreference: cookieStore.get(LEDGER_PREFERENCE_COOKIE)?.value,
        initialProcessing: { ai: choices?.aiProcessingEnabled ?? false, voice: choices?.voiceProcessingEnabled ?? false, services: processingServices() },
      } });
      return Response.json(result, { headers });
    }, { readOnly: true });
  } catch (error) {
    const code = error instanceof Error ? error.message : "VIEW_UNAVAILABLE";
    const unauthorized = code === "Unauthorized";
    const invalid = code === "INVALID_VIEW_REQUEST" || error instanceof z.ZodError;
    return Response.json({ error: unauthorized ? "unauthorized" : invalid ? "invalid_request" : code.startsWith("ENCRYPTION_") ? code : "unavailable" }, { status: unauthorized ? 401 : invalid ? 400 : code.startsWith("ENCRYPTION_") ? 409 : 503, headers });
  }
}
