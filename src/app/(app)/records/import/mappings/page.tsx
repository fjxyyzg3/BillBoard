import { getPageMetadata } from "@/lib/page-metadata";
import { requireAppSession } from "@/lib/auth/session";
import { getHouseholdEncryptionStatus } from "@/lib/encryption/request";
import { loadMappingsPage } from "./loader";
import { MappingsView } from "./view";

export function generateMetadata() {
  return getPageMetadata((messages) => messages.import.manageMappings);
}

export default async function MappingsPage() {
  const session = await requireAppSession();
  const status = await getHouseholdEncryptionStatus(session);
  if (status.mode !== "UNENCRYPTED") return null;
  return <MappingsView data={await loadMappingsPage()} />;
}
