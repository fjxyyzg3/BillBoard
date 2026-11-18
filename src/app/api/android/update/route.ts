import { requireAppSession } from "@/lib/auth/session";
import { androidUpdateHeaders, readAndroidUpdate } from "@/lib/android-update";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireAppSession();
  } catch {
    return new Response(null, { status: 401, headers: androidUpdateHeaders });
  }
  const manifest = await readAndroidUpdate();
  return manifest
    ? Response.json(manifest, { headers: androidUpdateHeaders })
    : new Response(null, { status: 404, headers: androidUpdateHeaders });
}
