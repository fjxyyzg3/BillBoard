import { describe, expect, it } from "vitest";

import type { ManagedImportCategoryMapping } from "@/lib/imports/category-mapping-management";
import { filterManagedImportMappings, getManagedImportMappingChanges } from "@/lib/imports/managed-mapping-form";
import { IGNORE_IMPORT_MAPPING_VALUE } from "@/lib/imports/mapping-form";

const expenseMapping: ManagedImportCategoryMapping = {
  id: "expense-rule",
  source: "sui_shou_ji",
  transactionType: "EXPENSE",
  primaryCategory: "餐饮",
  secondaryCategory: "三餐",
  categoryId: "dining",
  categoryName: "Dining",
  categoryIsActive: true,
  updatedAt: "2026-10-09T01:00:00.123Z",
};
const ignoredMapping: ManagedImportCategoryMapping = {
  ...expenseMapping,
  id: "ignored-rule",
  source: "wechat_pay",
  categoryId: null,
  categoryName: null,
  categoryIsActive: null,
};

const filterMappings: ManagedImportCategoryMapping[] = [
  expenseMapping,
  { ...ignoredMapping, primaryCategory: "商户消费", secondaryCategory: "" },
  { ...expenseMapping, id: "income-rule", source: "alipay", transactionType: "INCOME",
    primaryCategory: "", secondaryCategory: "到账", categoryId: "salary", categoryName: "Salary" },
  { ...expenseMapping, id: "inactive-rule", source: "cmb", primaryCategory: "Coffee | Shop",
    secondaryCategory: "", categoryId: "old", categoryName: "Legacy category", categoryIsActive: false },
];
const noFilters = { source: "", transactionType: "", keyword: "" } as const;

describe("managed import mapping filters", () => {
  it("keeps all rules when filters are empty", () => {
    expect(filterManagedImportMappings(filterMappings, noFilters, "zh-CN")).toEqual(filterMappings);
  });

  it("combines source, transaction type and localized saved target", () => {
    expect(filterManagedImportMappings(filterMappings, {
      source: "alipay", transactionType: "INCOME", keyword: "工资",
    }, "zh-CN").map(({ id }) => id)).toEqual(["income-rule"]);
    expect(filterManagedImportMappings(filterMappings, {
      source: "alipay", transactionType: "EXPENSE", keyword: "",
    }, "zh-CN")).toEqual([]);
  });

  it.each([
    ["三餐", "zh-CN", "expense-rule"],
    [" 到账 ", "zh-CN", "income-rule"],
    ["忽略", "zh-CN", "ignored-rule"],
    ["DINING", "en-US", "expense-rule"],
    [" ignore ", "en-US", "ignored-rule"],
    ["LEGACY CATEGORY", "en-US", "inactive-rule"],
    ["coffee |", "en-US", "inactive-rule"],
  ] as const)("matches original or saved classifications for %s in %s", (keyword, locale, id) => {
    expect(filterManagedImportMappings(filterMappings, { ...noFilters, keyword }, locale)
      .map((mapping) => mapping.id)).toEqual([id]);
  });

  it("does not change the full baseline or its saved targets", () => {
    const before = structuredClone(filterMappings);
    expect(filterManagedImportMappings(filterMappings, { ...noFilters, keyword: "no match" }, "en-US")).toEqual([]);
    expect(filterMappings).toEqual(before);
  });
});

describe("managed import mapping choices", () => {
  it("does not publish untouched rules or choices changed back to the initial target", () => {
    expect(getManagedImportMappingChanges([expenseMapping, ignoredMapping], {})).toEqual([]);
    expect(getManagedImportMappingChanges([expenseMapping, ignoredMapping], {
      [expenseMapping.id]: expenseMapping.categoryId!,
      [ignoredMapping.id]: IGNORE_IMPORT_MAPPING_VALUE,
    })).toEqual([]);
  });

  it("carries the presented version and stable id for a real target change", () => {
    expect(getManagedImportMappingChanges([expenseMapping, ignoredMapping], {
      [expenseMapping.id]: "transport",
    })).toEqual([{ id: expenseMapping.id, categoryId: "transport",
      expectedUpdatedAt: expenseMapping.updatedAt }]);
  });

  it("converts only the explicit ignore choice to null", () => {
    expect(getManagedImportMappingChanges([expenseMapping, ignoredMapping], {
      [expenseMapping.id]: IGNORE_IMPORT_MAPPING_VALUE,
      [ignoredMapping.id]: "dining",
    })).toEqual([
      { id: expenseMapping.id, categoryId: null, expectedUpdatedAt: expenseMapping.updatedAt },
      { id: ignoredMapping.id, categoryId: "dining", expectedUpdatedAt: ignoredMapping.updatedAt },
    ]);
  });

  it("omits empty selections instead of clearing an existing rule", () => {
    expect(getManagedImportMappingChanges([expenseMapping, ignoredMapping], {
      [expenseMapping.id]: "",
      [ignoredMapping.id]: "",
    })).toEqual([]);
  });

  it("never publishes rules that were not presented", () => {
    expect(getManagedImportMappingChanges([expenseMapping], {
      [ignoredMapping.id]: "dining",
      unknown: IGNORE_IMPORT_MAPPING_VALUE,
    })).toEqual([]);
  });

  it("uses a returned committed version as the next baseline", () => {
    const committed = { ...expenseMapping, categoryId: null,
      updatedAt: "2026-10-09T01:00:00.124Z" };
    expect(getManagedImportMappingChanges([committed], {
      [committed.id]: IGNORE_IMPORT_MAPPING_VALUE,
    })).toEqual([]);
    expect(getManagedImportMappingChanges([committed], {
      [committed.id]: "dining",
    })).toEqual([{ id: committed.id, categoryId: "dining",
      expectedUpdatedAt: committed.updatedAt }]);
  });
});
