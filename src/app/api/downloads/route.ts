import { isOpsAdminInstance } from "@/lib/ops/config";
import { readDownloadCatalog } from "@/lib/public-downloads";
import { releaseFailure, releaseHeaders } from "@/lib/release-files";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (isOpsAdminInstance()) return releaseFailure("missing");
  if (request.signal.aborted) return releaseFailure("cancelled");
  const catalog = await readDownloadCatalog(request.signal);
  if (request.signal.aborted) return releaseFailure("cancelled");
  return Response.json(catalog, { headers: releaseHeaders });
}
