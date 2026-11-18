import { requireAppSession } from "@/lib/auth/session";
import { androidUpdateHeaders, readAndroidApk } from "@/lib/android-update";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ sha256: string }> }) {
  try {
    await requireAppSession();
  } catch {
    return new Response(null, { status: 401, headers: androidUpdateHeaders });
  }
  const { sha256 } = await context.params;
  const bytes = await readAndroidApk(sha256);
  if (!bytes) return new Response(null, { status: 404, headers: androidUpdateHeaders });
  return new Response(new Uint8Array(bytes), { headers: {
    ...androidUpdateHeaders,
    "Content-Type": "application/vnd.android.package-archive",
    "Content-Length": String(bytes.length),
    "Content-Disposition": 'attachment; filename="BillBoard.apk"',
  } });
}
