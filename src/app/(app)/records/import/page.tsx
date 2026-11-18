import { getPageMetadata } from "@/lib/page-metadata";
import { requireAppSession } from "@/lib/auth/session";
import { getHouseholdEncryptionStatus } from "@/lib/encryption/request";
import { loadImportPage } from "./loader";
import { ImportView } from "./view";

export function generateMetadata() {
  return getPageMetadata((messages) => messages.import.title);
}

export default async function ImportPage(props: Parameters<typeof loadImportPage>[0]) {
  const session = await requireAppSession();
  const status = await getHouseholdEncryptionStatus(session);
  if (status.mode !== "UNENCRYPTED") return null;
  return <ImportView data={await loadImportPage(props)} />;
}
