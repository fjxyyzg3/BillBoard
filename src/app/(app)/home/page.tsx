import { getPageMetadata } from "@/lib/page-metadata";
import { requireAppSession } from "@/lib/auth/session";
import { getHouseholdEncryptionStatus } from "@/lib/encryption/request";
import { loadHomePage } from "./loader";
import { HomeView } from "./view";

export function generateMetadata() {
  return getPageMetadata((messages) => messages.home.title);
}

export default async function HomePage(props: Parameters<typeof loadHomePage>[0]) {
  const session = await requireAppSession();
  const status = await getHouseholdEncryptionStatus(session);
  if (status.mode !== "UNENCRYPTED") return null;
  return <HomeView data={await loadHomePage(props)} />;
}
