import { Children, isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BottomNav } from "@/components/bottom-nav";
import { DesktopNav } from "@/components/desktop-nav";
import { MobileUtilities } from "@/components/mobile-utilities";
import { getMessages } from "@/lib/i18n";
import AppLoading from "@/app/(app)/loading";
import AppRouteError from "@/app/(app)/error";

const currentLocale = vi.hoisted(() => ({ value: "zh-CN" as "zh-CN" | "en-US" }));

vi.mock("@/components/voice-accounting-provider", () => ({
  useVoiceAccounting: () => ({ begin: () => undefined, finish: () => undefined, cancel: () => undefined,
    armCancel: () => undefined, hint: "Hold to speak" }),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/home",
  useRouter: () => ({
    refresh: () => undefined,
  }),
}));

vi.mock("@/components/app-filters-provider", () => ({
  useAppFilters: () => ({
    buildHref: (pathname: string) => pathname,
    locale: currentLocale.value,
    navigateTo: () => undefined,
    pendingPath: "/add",
  }),
}));

describe("navigation version markers", () => {
  it("keeps mobile navigation focused and exposes utilities separately", () => {
    const messages = getMessages("zh-CN");
    const desktopMarkup = renderToStaticMarkup(
      <DesktopNav labels={{ app: messages.app, language: messages.language, nav: messages.nav }} locale="zh-CN" versionLabel="v0.1.0" />,
    );
    const mobileMarkup = renderToStaticMarkup(
      <BottomNav labels={messages.nav} navigationLabel={messages.ui.mainNavigation} />,
    );
    const utilityMarkup = renderToStaticMarkup(<MobileUtilities locale="zh-CN" versionLabel="v0.1.0" />);

    expect(desktopMarkup).toContain("v0.1.0");
    expect(desktopMarkup).toContain("首页");
    expect(desktopMarkup).toContain("记一笔");
    expect(desktopMarkup).toContain("记录");
    expect(desktopMarkup).not.toContain("报表");
    expect(desktopMarkup).toContain("家庭记账");
    expect(desktopMarkup).toContain("切换语言");
    expect(desktopMarkup).toContain('href="/account"');
    expect(desktopMarkup).not.toContain("diagnostic-feedback-trigger");
    expect(desktopMarkup).not.toContain("反馈卡顿");
    expect(mobileMarkup).not.toContain("v0.1.0");
    expect(mobileMarkup).not.toContain("diagnostic-feedback-trigger");
    expect(utilityMarkup).toContain("更多选项");
    expect(mobileMarkup).toContain("首页");
    expect(mobileMarkup).toContain("记一笔");
    expect(mobileMarkup).toContain("记录");
    expect(mobileMarkup).not.toContain("报表");
    expect(desktopMarkup).toMatch(/aria-busy="true"[^>]*href="\/add"|href="\/add"[^>]*aria-busy="true"/);
    expect(mobileMarkup).toMatch(/aria-busy="true"[^>]*href="\/add"|href="\/add"[^>]*aria-busy="true"/);
  });

  it("renders a stable busy skeleton while an app route is loading", () => {
    const markup = renderToStaticMarkup(<AppLoading />);

    expect(markup).toContain("aria-busy=\"true\"");
    expect(markup).toContain("data-testid=\"app-route-loading\"");
  });

  it.each([
    ["zh-CN", "页面加载失败", "重试页面"],
    ["en-US", "Page failed to load", "Retry page"],
  ] as const)("preserves the %s route error and retries with fresh content", (locale, title, retryLabel) => {
    currentLocale.value = locale;
    const retry = vi.fn();
    const view = AppRouteError({ retry });
    const markup = renderToStaticMarkup(view);
    const button = Children.toArray(view.props.children).find(
      (child) => isValidElement(child) && child.type === "button",
    ) as ReactElement<{ onClick: () => void }>;

    expect(markup).toContain(title);
    expect(markup).toContain(retryLabel);
    button.props.onClick();
    expect(retry).toHaveBeenCalledOnce();
    currentLocale.value = "zh-CN";
  });
});
