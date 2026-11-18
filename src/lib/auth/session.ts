import { auth, type AppSessionUser } from "@/auth";
import type { AccountSessionUser } from "./app-sessions";
import { resolveHouseholdContext } from "./household-context";
import { db } from "@/lib/db";

export async function requireAccountSession() {
  const session = await auth();
  const user = session?.user as Partial<AccountSessionUser> | undefined;
  if (!user?.id || !user.appSessionId) throw new Error("Unauthorized");
  return user as AccountSessionUser;
}

export async function requireAppSession() {
  const user = await requireAccountSession();

  if (!user?.id || !user.householdId || !user.memberId) {
    throw new Error("Unauthorized");
  }

  const context = await resolveHouseholdContext(db, { ...user, householdId: user.householdId, memberId: user.memberId }, { metadataOnly: true });
  return { ...user, role: context.role } as AppSessionUser;
}
