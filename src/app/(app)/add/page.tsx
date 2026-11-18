import { getPageMetadata } from "@/lib/page-metadata";
import { requireAppSession } from "@/lib/auth/session";
import { getHouseholdEncryptionStatus } from "@/lib/encryption/request";
import { loadAddPage } from "./loader";
import { AddView } from "./view";

export function generateMetadata() {
  return getPageMetadata((messages) => messages.add.title);
}

export default async function AddPage(props: Parameters<typeof loadAddPage>[0]) {
  const session = await requireAppSession();
  const status = await getHouseholdEncryptionStatus(session);
  if (status.mode !== "UNENCRYPTED") return null;
  return <AddView data={await loadAddPage(props)} />;
}
