
import { requireAppSession } from "@/lib/auth/session";
import { getServerLocale } from "@/lib/i18n-server";
import { getImportCategoryMappingManagement } from "@/lib/imports/category-mapping-management";

export async function loadMappingsPage() {
  const sessionUser = await requireAppSession();
  const locale = await getServerLocale();
  const { mappings, categories } = await getImportCategoryMappingManagement(sessionUser);

  return { locale, mappings, categories };
}
