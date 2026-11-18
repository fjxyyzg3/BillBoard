import { getPageMetadata } from "@/lib/page-metadata";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { IdentityLink } from "@/components/identity-link";
import { identityLinkBootstrapScript } from "@/components/identity-link-token";
import { withAppBasePath } from "@/lib/base-path";
import { getMessages } from "@/lib/i18n";
import { getServerLocale } from "@/lib/i18n-server";
import { isOpsAdminInstance } from "@/lib/ops/config";

export async function generateMetadata() {
  return { ...await getPageMetadata((messages) => messages.identity.linkTitle), referrer: "no-referrer" as const, robots: { index: false, follow: false } };
}

export default async function AccountLinkPage() {
  if (isOpsAdminInstance()) redirect("/ops");
  const locale = await getServerLocale();
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return <>
    <script nonce={nonce} dangerouslySetInnerHTML={{ __html: identityLinkBootstrapScript }} />
    <IdentityLink authBasePath={withAppBasePath("/api/auth")} labels={getMessages(locale).identity} locale={locale} />
  </>;
}
