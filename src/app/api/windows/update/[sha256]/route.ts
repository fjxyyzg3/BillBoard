import {
  desktopUpdateFailure, desktopUpdateHeaders, requireDesktopUpdateSession, streamDesktopInstaller,
} from "@/lib/desktop-update";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ sha256: string }> }) {
  let session;
  try {
    session = await requireDesktopUpdateSession();
  } catch {
    return new Response(null, { status: 401, headers: desktopUpdateHeaders });
  }
  const { sha256 } = await context.params;
  const installer = await streamDesktopInstaller(sha256, request.signal);
  if (installer.status !== "ok") return desktopUpdateFailure(installer.status);
  try {
    await requireDesktopUpdateSession(session);
  } catch {
    await installer.body.cancel().catch(() => undefined);
    return new Response(null, { status: 401, headers: desktopUpdateHeaders });
  }
  if (request.signal.aborted) {
    await installer.body.cancel().catch(() => undefined);
    return desktopUpdateFailure("cancelled");
  }
  return new Response(installer.body, { headers: {
    ...desktopUpdateHeaders,
    "Content-Type": "application/octet-stream",
    "Content-Length": String(installer.size),
    "Content-Disposition": 'attachment; filename="BillBoard-Setup.exe"',
  } });
}
