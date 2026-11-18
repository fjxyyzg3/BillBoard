import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { LanguageToggle } from "@/components/language-toggle";
import { getMessages } from "@/lib/i18n";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: vi.fn(),
  }),
}));

describe("LanguageToggle", () => {
  it("renders disabled before hydration so early clicks cannot be lost", () => {
    const messages = getMessages("zh-CN");

    const markup = renderToStaticMarkup(
      <LanguageToggle labels={messages.language} locale="zh-CN" />,
    );

    expect(markup).toContain('aria-label="切换语言"');
    expect(markup).toContain("disabled");
  });
});
