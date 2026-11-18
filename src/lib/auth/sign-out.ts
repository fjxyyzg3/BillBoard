import { signOut } from "@/auth";
import { requireAccountSession } from "@/lib/auth/session";
import { revokeCurrentAccountSession } from "@/lib/identity/account";
import { IdentityError } from "@/lib/identity/shared";
import { withAuthStorageGuard } from "./storage-availability";

export async function signOutCurrentAccount(options: { redirect?: boolean; redirectTo?: string }) {
  try {
    const session = await withAuthStorageGuard(() => requireAccountSession());
    await revokeCurrentAccountSession(session);
  } catch (error) {
    // Already-invalid authentication still needs its browser cookie cleared.
    // Other failures retain the cookie so revocation can be retried.
    if (!(error instanceof Error && error.message === "Unauthorized")
      && !(error instanceof IdentityError && error.code === "UNAUTHORIZED")) throw error;
  }
  await signOut(options);
}
