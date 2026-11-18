import { getPageMetadata } from "@/lib/page-metadata";
import { requireAppSession } from "@/lib/auth/session";
import { getHouseholdEncryptionStatus } from "@/lib/encryption/request";
import { loadReconciliationPage } from "./loader";
import { ReconciliationView } from "./view";

export function generateMetadata() {
  return getPageMetadata((messages) => messages.billAnalysis.title);
}

export default async function ReconciliationPage(props: Parameters<typeof loadReconciliationPage>[0]) {
  const session = await requireAppSession();
  const status = await getHouseholdEncryptionStatus(session);
  if (status.mode !== "UNENCRYPTED") return null;
  return <ReconciliationView data={await loadReconciliationPage(props)} />;
}
