import { requireAccountSession } from "@/lib/auth/session";
import { getProcessingPreferences, setProcessingPreferences } from "@/lib/processing/preferences";
import { IdentityError } from "@/lib/identity/shared";

export const runtime = "nodejs";
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });

class PreferenceBodyError extends Error {
  constructor(readonly code: "invalid_request" | "timeout" | "cancelled", readonly status: number) { super(code); }
}

async function readChoicesBody(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new PreferenceBodyError("invalid_request", 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timedOut = false;
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  const check = () => {
    if (request.signal.aborted) throw new PreferenceBodyError("cancelled", 499);
    if (timedOut) throw new PreferenceBodyError("timeout", 408);
  };
  const timer = setTimeout(() => { timedOut = true; cancel(); }, 5_000);
  request.signal.addEventListener("abort", cancel, { once: true });
  try {
    check();
    while (true) {
      const next = await reader.read();
      check();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 1024) throw new PreferenceBodyError("invalid_request", 413);
      chunks.push(next.value);
    }
    check();
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
}

export async function GET(request: Request) {
  try {
    if (new URL(request.url).search) return json({ error: "invalid_request" }, 400);
    return json(await getProcessingPreferences(await requireAccountSession()));
  } catch { return json({ error: "unauthorized" }, 401); }
}

export async function POST(request: Request) {
  try {
    const session = await requireAccountSession();
    const origin = request.headers.get("origin");
    const host = request.headers.get("host") ?? new URL(request.url).host;
    const protocol = request.headers.get("x-forwarded-proto") ?? new URL(request.url).protocol.replace(":", "");
    if (!origin || origin !== `${protocol}://${host}` || new URL(request.url).search
      || (request.headers.get("x-forwarded-host") && request.headers.get("x-forwarded-host") !== host)
      || (request.headers.get("sec-fetch-site") && request.headers.get("sec-fetch-site") !== "same-origin")) return json({ error: "forbidden" }, 403);
    if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") return json({ error: "invalid_request" }, 400);
    const value = await readChoicesBody(request);
    return json(await setProcessingPreferences(session, value, request.signal));
  } catch (error) {
    if (request.signal.aborted) return json({ error: "cancelled" }, 499);
    if (error instanceof PreferenceBodyError) return json({ error: error.code }, error.status);
    const unauthorized = error instanceof IdentityError && error.code === "UNAUTHORIZED"
      || error instanceof Error && error.message === "Unauthorized";
    return json({ error: unauthorized ? "unauthorized" : "invalid_request" }, unauthorized ? 401 : 400);
  }
}
