import type { Metadata } from "next";
import { ImportReviewHistoryGuard } from "@/components/import-review-history-guard";
import { EncryptionLifecycle } from "@/components/encryption-lifecycle";
import { getMessages } from "@/lib/i18n";
import { getServerLocale } from "@/lib/i18n-server";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getServerLocale();
  const messages = getMessages(locale);

  return {
    title: messages.metadata.title,
    description: messages.metadata.description,
  };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getServerLocale();

  return (
    <html lang={locale}>
      <body className="min-h-screen bg-[var(--ios-bg)] text-[var(--ios-text)] antialiased">
        <ImportReviewHistoryGuard />
        <EncryptionLifecycle />
        {children}
      </body>
    </html>
  );
}
