import { AppShellView, type AppShellViewProps } from "@/components/app-shell-view";
import { getServerLocale } from "@/lib/i18n-server";

export async function AppShell(props: Omit<AppShellViewProps, "locale">) {
  return <AppShellView {...props} locale={await getServerLocale()} />;
}
