import { auth, type AppSessionUser } from "@/auth";

export async function requireAppSession() {
  const session = await auth();
  const user = session?.user as Partial<AppSessionUser> | undefined;

  if (!user?.id || !user.householdId || !user.memberId) {
    throw new Error("Unauthorized");
  }

  return user as AppSessionUser;
}
