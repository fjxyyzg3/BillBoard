import { auth, type AppSessionUser } from "@/auth";
import { AppShell } from "@/components/app-shell";
import { redirect } from "next/navigation";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  const user = session?.user as Partial<AppSessionUser> | undefined;

  if (!user?.id || !user.householdId || !user.memberId) {
    redirect("/login");
  }

  return <AppShell>{children}</AppShell>;
}
