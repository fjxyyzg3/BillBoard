import { requireAppSession } from "@/lib/auth/session";
import { getServerLocale } from "@/lib/i18n-server";
import { loadLedgerCatalog } from "@/lib/ledgers/server";

export async function loadLedgersPage() {
  const [session, locale] = await Promise.all([requireAppSession(), getServerLocale()]);
  const catalog = await loadLedgerCatalog(session);
  return { locale, catalog };
}
