import { isOpsAdminInstance } from "@/lib/ops/config";
import { streamPublicDownload } from "@/lib/public-downloads";
import { releaseFailure, releaseHeaders } from "@/lib/release-files";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ platform: string }> }) {
  if (isOpsAdminInstance()) return releaseFailure("missing");
  const { platform } = await context.params;
  if (platform !== "android" && platform !== "windows") return releaseFailure("missing");
  const download = await streamPublicDownload(platform, request.signal);
  if (download.status !== "ok") return releaseFailure(download.status);
  if (request.signal.aborted) {
    await download.body.cancel().catch(() => undefined);
    return releaseFailure("cancelled");
  }
  const filename = platform === "android"
    ? `BillBoard-${download.release.version}.apk` : `BillBoard-${download.release.version}-x64.exe`;
  return new Response(download.body, { headers: {
    ...releaseHeaders,
    "Content-Type": platform === "android" ? "application/vnd.android.package-archive" : "application/octet-stream",
    "Content-Length": String(download.release.size),
    "Content-Disposition": `attachment; filename="${filename}"`,
  } });
}

export async function HEAD(request: Request, context: { params: Promise<{ platform: string }> }) {
  const response = await GET(request, context);
  await response.body?.cancel().catch(() => undefined);
  return new Response(null, { status: response.status, headers: response.headers });
}
