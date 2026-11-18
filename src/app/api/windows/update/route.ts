import {
  desktopUpdateFailure, desktopUpdateHeaders, readDesktopUpdate, requireDesktopUpdateSession,
} from "@/lib/desktop-update";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  let session;
  try {
    session = await requireDesktopUpdateSession();
  } catch {
    return new Response(null, { status: 401, headers: desktopUpdateHeaders });
  }
  const update = await readDesktopUpdate(request.signal);
  if (update.status !== "ok") return desktopUpdateFailure(update.status);
  try {
    await requireDesktopUpdateSession(session);
  } catch {
    return new Response(null, { status: 401, headers: desktopUpdateHeaders });
  }
  if (request.signal.aborted) return desktopUpdateFailure("cancelled");
  return new Response(update.bytes, { headers: { ...desktopUpdateHeaders, "Content-Type": "application/json; charset=utf-8" } });
}
