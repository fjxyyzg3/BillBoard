import { NaturalLanguageProvider } from "@/components/natural-language-provider";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { NaturalLanguageForm } from "@/components/natural-language-form";

vi.mock("@/app/account/actions", () => ({ finishReauthenticationAction: vi.fn() }));

vi.mock("@/app/(app)/add/natural-language-actions", () => ({
  queryNaturalLanguageEntry: vi.fn(),
  submitNaturalLanguageEntry: vi.fn(),
}));

describe("natural language form", () => {
  it.each([
    ["zh-CN", "收支描述", "导入", "模型服务"],
    ["en-US", "Describe transactions", "Import", "model service"],
  ] as const)("offers a single transaction text field and import button in %s", (locale, label, button, disclosure) => {
    const markup = renderToStaticMarkup(
      <NaturalLanguageProvider currentMemberId="member"><NaturalLanguageForm locale={locale} /></NaturalLanguageProvider>,
    );

    expect(markup).toContain(label);
    expect(markup).toContain(disclosure);
    expect(markup.match(/<textarea\b/g)).toHaveLength(1);
    expect(markup.match(/<button\b/g)).toHaveLength(1);
    expect(markup).not.toMatch(/<input\b|<select\b/);
    expect(markup).toContain(`type="submit">${button}</button>`);
    expect(markup).toContain('method="post"');
    expect(markup).toMatch(/<textarea[^>]*\bdisabled=""/);
    expect(markup).toMatch(/<button[^>]*\bdisabled=""/);
  });
});
