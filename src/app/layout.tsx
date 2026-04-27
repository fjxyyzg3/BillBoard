import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Household Accounting",
  description: "Fast two-person household accounting.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-[var(--ios-bg)] text-[var(--ios-text)] antialiased">{children}</body>
    </html>
  );
}
