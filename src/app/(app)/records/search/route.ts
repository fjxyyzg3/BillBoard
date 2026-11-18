import { NextResponse } from "next/server";
import { requireAppSession } from "@/lib/auth/session";
import { resolveLedgerPageContext } from "@/lib/ledgers/server";
import { createRecordAmountToken, createRecordSearchToken } from "@/lib/records/search-token";
import { parseRecordAmountFilter } from "@/lib/records/amount-filter";
import { db } from "@/lib/db";
import { authorizeMemberReadScope, parseMemberFilter } from "@/lib/records/member-filter";
import { extractEncryption, withHouseholdEncryption } from "@/lib/encryption/request";
import { EncryptionRequestError } from "@/lib/encryption/types";
import { readEncryptionBody } from "@/lib/encryption/body";

function getRecordsPath(requestUrl: URL) {
  return requestUrl.pathname.replace(/\/search\/?$/, "") || "/records";
}

function getSafeReturnUrl(
  value: FormDataEntryValue | null,
  requestUrl: URL,
  recordsPath: string,
) {
  const fallback = new URL(recordsPath, requestUrl);
  fallback.searchParams.set("mode", "month");

  if (typeof value !== "string" || value.length === 0) {
    return fallback;
  }

  try {
    const returnUrl = new URL(value, requestUrl);

    if (returnUrl.origin !== requestUrl.origin || returnUrl.pathname !== recordsPath) {
      return fallback;
    }

    return returnUrl;
  } catch {
    return fallback;
  }
}

function redirectTo(url: URL) {
  return new NextResponse(null, {
    headers: { Location: `${url.pathname}${url.search}` },
    status: 303,
  });
}

async function searchRecords(request: Request, formData: FormData) {
  const requestUrl = new URL(request.url);
  const recordsPath = getRecordsPath(requestUrl);
  const target = getSafeReturnUrl(formData.get("returnTo"), requestUrl, recordsPath);
  let user;
  let context;

  try {
    user = await requireAppSession();
    const params: Record<string, string | string[]> = Object.fromEntries(target.searchParams);
    for (const key of ["ledger", "entryLedger"]) {
      const values = target.searchParams.getAll(key);
      if (values.length > 1) params[key] = values;
    }
    const view = await resolveLedgerPageContext(user, params);
    context = { householdId: user.householdId, memberId: user.memberId, scope: view.scope };
    target.searchParams.set("ledger", view.scope.kind === "ledger" ? view.scope.ledgerId : "all");
    target.searchParams.set("entryLedger", view.entryLedgerId);
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return redirectTo(new URL("/login", requestUrl));
    }
    if (error instanceof Error && error.message === "Ledger is unavailable") {
      return new NextResponse(null, { status: 404 });
    }

    throw error;
  }

  target.searchParams.delete("perspective");
  try {
    const actorMemberId = parseMemberFilter(target.searchParams.getAll("member").length > 1
      ? target.searchParams.getAll("member") : target.searchParams.get("member"));
    await authorizeMemberReadScope(db, user.householdId, actorMemberId);
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") return new NextResponse(null, { status: 404 });
    throw error;
  }
  const rawSearch = formData.get("search");
  const normalizedSearch = typeof rawSearch === "string" ? rawSearch.trim() : "";

  if (formData.has("amountMode")) {
    let amountFilter;
    try {
      const readField = (name: string) => {
        const value = formData.get(name);
        if (value !== null && typeof value !== "string") {
          throw new Error("invalidAmount");
        }
        return value;
      };
      amountFilter = parseRecordAmountFilter({
        mode: readField("amountMode"),
        exact: readField("amountExact"),
        min: readField("amountMin"),
        max: readField("amountMax"),
      });
    } catch (error) {
      target.searchParams.set("filterError",
        error instanceof Error && error.message === "invalidAmountRange"
          ? "invalidAmountRange" : "invalidAmount");
      return redirectTo(target);
    }

    target.searchParams.delete("amount");
    if (amountFilter) {
      target.searchParams.set("amount", createRecordAmountToken(amountFilter, context)!);
    }
  }

  target.searchParams.delete("filterError");
  target.searchParams.delete("page");
  target.searchParams.delete("search");

  if (normalizedSearch) {
    target.searchParams.set(
      "search",
      createRecordSearchToken(normalizedSearch, context) ?? "",
    );
  }

  return redirectTo(target);
}

export async function POST(request: Request) {
  try {
    const body = await readEncryptionBody(request, 16 * 1024);
    const form = await new Response(new Uint8Array(body), { headers: { "Content-Type": request.headers.get("content-type") ?? "" } }).formData();
    const input = extractEncryption(form);
    if (input) {
      const origin = request.headers.get("origin"), url = new URL(request.url);
      const host = request.headers.get("host") ?? url.host;
      const protocol = request.headers.get("x-forwarded-proto") ?? url.protocol.slice(0, -1);
      if (!origin || origin !== `${protocol}://${host}` || (protocol !== "https" && !["127.0.0.1", "localhost"].includes(new URL(origin).hostname))) return new NextResponse(null, { status: 403 });
    }
    return await withHouseholdEncryption(input, () => searchRecords(request, form), { readOnly: true });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") return redirectTo(new URL("/login", request.url));
    if (error instanceof EncryptionRequestError) return Response.json({ error: error.code }, { status: 423, headers: { "Cache-Control": "no-store" } });
    throw error;
  }
}
