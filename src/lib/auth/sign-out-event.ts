import type { JWT } from "next-auth/jwt";
import { ensureAppSessionForToken, loadValidAccountSessionUser } from "./app-sessions";
import { markAuthStorageUnavailable } from "./storage-availability";
import { revokeCurrentAccountSession } from "@/lib/identity/account";
import { IdentityError } from "@/lib/identity/shared";

export async function revokeVerifiedSignOutSession(token: JWT | null) {
  if (!token || typeof token.sub !== "string" || !token.sub) return;
  try {
    const sessionId = typeof token.appSessionId === "string" && token.appSessionId
      ? token.appSessionId : await ensureAppSessionForToken(token, null);
    if (!sessionId) return;
    const session = await loadValidAccountSessionUser(sessionId);
    if (!session || session.id !== token.sub) return;
    await revokeCurrentAccountSession(session);
  } catch (error) {
    // A concurrent revocation or ended identity is already unable to replay.
    if (error instanceof IdentityError && error.code === "UNAUTHORIZED") return;
    throw markAuthStorageUnavailable();
  }
}
