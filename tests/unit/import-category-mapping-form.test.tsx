import { TransactionType } from "@prisma/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ImportCategoryMappingForm } from "@/components/import-category-mapping-form";

vi.mock("@/app/account/actions", () => ({ finishReauthenticationAction: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock("@/app/(app)/records/import/actions", () => ({
  saveImportMappingChanges: vi.fn(),
}));

vi.mock("@/app/(app)/records/import/agent-actions", () => ({
  recommendImportMappings: vi.fn(),
}));

describe("ImportCategoryMappingForm", () => {
  it("keeps unresolved mappings ahead of a collapsed saved group", () => {
    const markup = renderToStaticMarkup(
      <ImportCategoryMappingForm
        categories={[{ id: "dining", name: "Dining", type: "EXPENSE" }]}
        draftId="draft"
        groups={[
          {
            count: 3,
            initialValue: "__ignore__",
            mappingKey: "sui_shou_ji|EXPENSE|Saved|",
            primaryCategory: "Saved",
            secondaryCategory: null,
            transactionType: TransactionType.EXPENSE,
          },
          {
            count: 2,
            initialValue: "",
            mappingKey: "sui_shou_ji|EXPENSE|Pending|",
            primaryCategory: "Pending",
            secondaryCategory: null,
            transactionType: TransactionType.EXPENSE,
          },
        ]}
        locale="en-US"
      />,
    );

    expect(markup.indexOf("Pending")).toBeLessThan(markup.indexOf("Saved"));
    expect(markup).toMatch(/<details[^>]*>.*Saved.*<\/details>/);
    expect(markup).not.toMatch(/<details[^>]*\sopen(?:[=\s>])/);
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*type="submit"/);
  });

  it.each([
    ["zh-CN", "智能推荐", "WheelMaker Hub（Codex）"],
    ["en-US", "Suggest categories", "WheelMaker Hub (Codex)"],
  ] as const)("offers explicit recommendations and data disclosure in %s", (locale, button, disclosure) => {
    const markup = renderToStaticMarkup(
      <ImportCategoryMappingForm
        categories={[{ id: "dining", name: "Dining", type: "EXPENSE" }]}
        draftId="draft"
        groups={[{
          count: 1,
          initialValue: "",
          mappingKey: "sui_shou_ji|EXPENSE|餐饮|早餐",
          primaryCategory: "餐饮",
          secondaryCategory: "早餐",
          transactionType: TransactionType.EXPENSE,
        }]}
        locale={locale}
      />,
    );

    expect(markup).toContain(`type="button">${button}</button>`);
    expect(markup).toContain(disclosure);
    expect(markup).toContain('type="submit"');
  });
});
