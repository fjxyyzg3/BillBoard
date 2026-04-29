import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BottomNav } from "@/components/bottom-nav";
import { DesktopNav } from "@/components/desktop-nav";
import { getMessages } from "@/lib/i18n";

vi.mock("next/navigation", () => ({
  usePathname: () => "/home",
  useRouter: () => ({
    refresh: () => undefined,
  }),
}));

vi.mock("@/components/app-filters-provider", () => ({
  useAppFilters: () => ({
    buildHref: (pathname: string) => pathname,
    navigateTo: () => undefined,
  }),
}));

describe("navigation version markers", () => {
  it("renders localized labels and the version marker in desktop and mobile navigation", () => {
    const messages = getMessages("zh-CN");
    const desktopMarkup = renderToStaticMarkup(
      <DesktopNav labels={{ app: messages.app, language: messages.language, nav: messages.nav }} locale="zh-CN" versionLabel="v0.1.0" />,
    );
    const mobileMarkup = renderToStaticMarkup(
      <BottomNav labels={{ language: messages.language, nav: messages.nav }} locale="zh-CN" versionLabel="v0.1.0" />,
    );

    expect(desktopMarkup).toContain("v0.1.0");
    expect(desktopMarkup).toContain("首页");
    expect(desktopMarkup).toContain("家庭记账");
    expect(mobileMarkup).toContain("v0.1.0");
    expect(mobileMarkup).toContain("记录");
  });
});
