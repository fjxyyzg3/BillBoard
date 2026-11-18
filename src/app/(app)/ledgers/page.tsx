import { getPageMetadata } from "@/lib/page-metadata";
import { requireAppSession } from "@/lib/auth/session";
import { getHouseholdEncryptionStatus } from "@/lib/encryption/request";
import { loadLedgersPage } from "./loader";
import { LedgersView } from "./view";

export function generateMetadata() {
  return getPageMetadata((messages) => messages.ledgers.title);
}

export default async function LedgersPage() {
  const session = await requireAppSession();
  const status = await getHouseholdEncryptionStatus(session);
  if (status.mode !== "UNENCRYPTED") return null;
  return <LedgersView data={await loadLedgersPage()} />;
}
