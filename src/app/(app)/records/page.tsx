import { getPageMetadata } from "@/lib/page-metadata";
import { requireAppSession } from "@/lib/auth/session";
import { getHouseholdEncryptionStatus } from "@/lib/encryption/request";
import { loadRecordsPage } from "./loader";
import { RecordsView } from "./view";

export function generateMetadata() {
  return getPageMetadata((messages) => messages.records.title);
}

export default async function RecordsPage(props: Parameters<typeof loadRecordsPage>[0]) {
  const session = await requireAppSession();
  const status = await getHouseholdEncryptionStatus(session);
  if (status.mode !== "UNENCRYPTED") return null;
  return <RecordsView data={await loadRecordsPage(props)} />;
}
