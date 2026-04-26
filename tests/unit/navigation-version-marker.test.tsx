import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BottomNav } from "@/components/bottom-nav";
import { DesktopNav } from "@/components/desktop-nav";

vi.mock("next/navigation", () => ({
  usePathname: () => "/home",
}));

vi.mock("@/components/app-filters-provider", () => ({
  useAppFilters: () => ({
    buildHref: (pathname: string) => pathname,
    navigateTo: () => undefined,
  }),
}));

describe("navigation version markers", () => {
  it("renders the version marker in desktop and mobile navigation", () => {
    const desktopMarkup = renderToStaticMarkup(<DesktopNav versionLabel="v0.1.0" />);
    const mobileMarkup = renderToStaticMarkup(<BottomNav versionLabel="v0.1.0" />);

    expect(desktopMarkup).toContain("v0.1.0");
    expect(mobileMarkup).toContain("v0.1.0");
  });
});
