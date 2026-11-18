import { describe, expect, it } from "vitest";
import {
  getCollapsedCategoryIds,
  getDefaultCategoryIds,
  getRecentShanghaiNaturalDayWindow,
  orderCategoriesByUsage,
  type CategoryUsageStat,
  type DefaultCategoryIds,
  type PreferenceCategory,
} from "@/lib/transactions/category-preferences";

const categories: PreferenceCategory[] = [
  { id: "dining", name: "Dining", type: "expense" },
  { id: "transport", name: "Transport", type: "expense" },
  { id: "shopping", name: "Shopping", type: "expense" },
  { id: "home", name: "Home", type: "expense" },
  { id: "medical", name: "Medical", type: "expense" },
  { id: "childcare", name: "Childcare", type: "expense" },
  { id: "salary", name: "Salary", type: "income" },
  { id: "bonus", name: "Bonus", type: "income" },
];

describe("category preference helpers", () => {
  it("builds a 30 Shanghai natural day window ending at now", () => {
    const now = new Date("2026-05-22T15:30:00.000Z");

    expect(getRecentShanghaiNaturalDayWindow(now, 30)).toEqual({
      from: new Date("2026-04-22T16:00:00.000Z"),
      to: now,
    });
  });

  it("orders categories by count, recency, then default order within each type", () => {
    const usageStats: CategoryUsageStat[] = [
      {
        categoryId: "shopping",
        count: 2,
        lastOccurredAt: new Date("2026-05-10T02:00:00.000Z"),
        type: "expense",
      },
      {
        categoryId: "dining",
        count: 2,
        lastOccurredAt: new Date("2026-05-12T02:00:00.000Z"),
        type: "expense",
      },
      {
        categoryId: "bonus",
        count: 1,
        lastOccurredAt: new Date("2026-05-11T02:00:00.000Z"),
        type: "income",
      },
    ];

    expect(orderCategoriesByUsage(categories, usageStats).map((category) => category.id)).toEqual([
      "dining",
      "shopping",
      "transport",
      "home",
      "medical",
      "childcare",
      "bonus",
      "salary",
    ]);
  });

  it("returns default category ids by selected type", () => {
    const ordered = orderCategoriesByUsage(categories, [
      {
        categoryId: "shopping",
        count: 3,
        lastOccurredAt: new Date("2026-05-12T02:00:00.000Z"),
        type: "expense",
      },
    ]);

    expect(getDefaultCategoryIds(ordered)).toEqual({
      expense: "shopping",
      income: "salary",
    } satisfies DefaultCategoryIds);
  });

  it("returns empty default category ids for missing types", () => {
    expect(getDefaultCategoryIds(categories.filter((category) => category.type === "expense"))).toEqual({
      expense: "dining",
      income: "",
    } satisfies DefaultCategoryIds);
  });

  it("keeps the selected category visible in the collapsed list", () => {
    expect(getCollapsedCategoryIds(categories.slice(0, 6), "childcare", 5)).toEqual([
      "dining",
      "transport",
      "shopping",
      "home",
      "childcare",
    ]);
  });

  it("does not duplicate selected categories already in the visible limit", () => {
    expect(getCollapsedCategoryIds(categories.slice(0, 6), "shopping", 5)).toEqual([
      "dining",
      "transport",
      "shopping",
      "home",
      "medical",
    ]);
  });
});
