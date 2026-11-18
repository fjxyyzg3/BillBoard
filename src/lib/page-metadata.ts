import type { Metadata } from "next";
import { getMessages, type Messages } from "@/lib/i18n";
import { getServerLocale } from "@/lib/i18n-server";

export async function getPageMetadata(getTitle: (messages: Messages) => string): Promise<Metadata> {
  const messages = getMessages(await getServerLocale());
  return { title: `${getTitle(messages)} · ${messages.app.brand}` };
}
