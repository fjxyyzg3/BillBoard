import { handlers } from "@/auth";
import type { NextRequest } from "next/server";
import { AuthStorageUnavailable, withAuthStorageGuard } from "@/lib/auth/storage-availability";

export const runtime = "nodejs";

async function handleAuthentication(operation: () => Promise<Response>) {
  try {
    return await withAuthStorageGuard(operation);
  } catch (error) {
    if (!(error instanceof AuthStorageUnavailable)) throw error;
    // Auth.js swallows callback/event errors and may clear a still-valid cookie.
    // Discard that response until the server session can be checked or revoked.
    return Response.json({ error: "temporarily_unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}

export async function GET(request: NextRequest) {
  return handleAuthentication(() => handlers.GET(request));
}

export async function POST(request: NextRequest) {
  return handleAuthentication(() => handlers.POST(request));
}
