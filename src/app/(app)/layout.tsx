import { auth, type AppAuthSession, type AppSessionUser } from "@/auth";
import { AppShell } from "@/components/app-shell";
import { isOpsAdminInstance } from "@/lib/ops/config";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { loadLedgerCatalog } from "@/lib/ledgers/server";
import { LEDGER_PREFERENCE_COOKIE } from "@/lib/ledgers/selection";
import { cookies } from "next/headers";
import { signOutCurrentAccount } from "@/lib/auth/sign-out";
import { getServerLocale } from "@/lib/i18n-server";
import { getMessages } from "@/lib/i18n";
import { AccountAccessState } from "@/components/account-access-state";
import { processingServices } from "@/lib/processing/preferences";
import { getHouseholdEncryptionStatus } from "@/lib/encryption/request";
import { EncryptionGate } from "@/components/encryption-gate";
import { EncryptionProvider } from "@/components/encryption-provider";

async function signOutAccount() {
  "use server";
  await signOutCurrentAccount({ redirectTo: "/login" });
}

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  if (isOpsAdminInstance()) {
    redirect("/ops");
  }

  const session = (await auth()) as AppAuthSession | null;
  const user = session?.user as Partial<AppSessionUser> | undefined;

  if (user?.id && user.appSessionId && (!user.householdId || !user.memberId) && !session?.authError) {
    const locale = await getServerLocale();
    return <AccountAccessState labels={getMessages(locale).accountAccess} locale={locale} signOut={signOutAccount} />;
  }

  if (!user?.id || !user.householdId || !user.memberId) {
    if (session?.authError === "SESSION_INVALID") {
      redirect("/login?reason=session-expired");
    }

    redirect("/login");
  }

  const identity = { accountId: user.id, householdId: user.householdId, memberId: user.memberId };
  const status = await getHouseholdEncryptionStatus(user as AppSessionUser);
  if (status.mode !== "UNENCRYPTED") return <EncryptionGate identity={identity} locale={await getServerLocale()} status={status} />;
  const catalog = await loadLedgerCatalog({ id: user.id, householdId: user.householdId, memberId: user.memberId, appSessionId: user.appSessionId });
  const cookieStore = await cookies();
  const choices = await db.user.findUnique({ where: { id: user.id }, select: { aiProcessingEnabled: true, voiceProcessingEnabled: true } });
  const initialProcessing = { ai: choices?.aiProcessingEnabled ?? false, voice: choices?.voiceProcessingEnabled ?? false, services: processingServices() };
  return <EncryptionProvider identity={identity} locale={await getServerLocale()} status={status}><AppShell catalog={catalog} currentMemberId={user.memberId} initialProcessing={initialProcessing} initialPreference={cookieStore.get(LEDGER_PREFERENCE_COOKIE)?.value}>{children}</AppShell></EncryptionProvider>;
}
