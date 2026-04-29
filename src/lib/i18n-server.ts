import { cookies } from "next/headers";
import { LOCALE_COOKIE_NAME, parseLocale } from "@/lib/i18n";

export async function getServerLocale() {
  const cookieStore = await cookies();

  return parseLocale(cookieStore.get(LOCALE_COOKIE_NAME)?.value);
}
