import { TransactionType } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  getImportMappingChanges,
  getImportMappingGroups,
  getImportMappingRecommendationTargets,
  IGNORE_IMPORT_MAPPING_VALUE,
  mergeImportMappingSuggestions,
} from "@/lib/imports/mapping-form";

const expenseGroup = {
  count: 2,
  mappingKey: "sui_shou_ji|EXPENSE|餐饮|三餐",
  primaryCategory: "餐饮",
  secondaryCategory: "三餐",
  transactionType: TransactionType.EXPENSE,
};
const incomeGroup = {
  count: 1,
  mappingKey: "sui_shou_ji|INCOME|职业收入|工资",
  primaryCategory: "职业收入",
  secondaryCategory: "工资",
  transactionType: TransactionType.INCOME,
};

describe("import category mapping choices", () => {
  it("keeps an unchanged ignored group out of changes when a different group is mapped", () => {
    const groups = getImportMappingGroups([incomeGroup], [expenseGroup]);

    expect(getImportMappingChanges(groups, {
      [expenseGroup.mappingKey]: IGNORE_IMPORT_MAPPING_VALUE,
      [incomeGroup.mappingKey]: "category-income",
    })).toEqual([{ mappingKey: incomeGroup.mappingKey, categoryId: "category-income" }]);
  });

  it("does not publish an ignored choice after it is changed back to its initial value", () => {
    const groups = getImportMappingGroups([], [expenseGroup]);

    expect(getImportMappingChanges(groups, { [expenseGroup.mappingKey]: "category-expense" }))
      .toEqual([{ mappingKey: expenseGroup.mappingKey, categoryId: "category-expense" }]);
    expect(getImportMappingChanges(groups, { [expenseGroup.mappingKey]: IGNORE_IMPORT_MAPPING_VALUE }))
      .toEqual([]);
    expect(getImportMappingChanges(groups, {})).toEqual([]);
  });

  it("turns a newly selected ignore choice into null while empty choices stay unmapped", () => {
    const groups = getImportMappingGroups([expenseGroup, incomeGroup], []);

    expect(getImportMappingChanges(groups, {
      [expenseGroup.mappingKey]: IGNORE_IMPORT_MAPPING_VALUE,
      [incomeGroup.mappingKey]: "",
    })).toEqual([{ mappingKey: expenseGroup.mappingKey, categoryId: null }]);
    expect(getImportMappingChanges(groups, {})).toEqual([]);
  });

  it("merges ignored and missing rows of the same group with an empty initial choice", () => {
    const groups = getImportMappingGroups([expenseGroup], [{ ...expenseGroup, count: 3 }]);

    expect(groups).toEqual([{ ...expenseGroup, count: 5, initialValue: "" }]);
    expect(getImportMappingChanges(groups, { [expenseGroup.mappingKey]: IGNORE_IMPORT_MAPPING_VALUE }))
      .toEqual([{ mappingKey: expenseGroup.mappingKey, categoryId: null }]);
    expect(getImportMappingChanges(groups, { [expenseGroup.mappingKey]: "category-expense" }))
      .toEqual([{ mappingKey: expenseGroup.mappingKey, categoryId: "category-expense" }]);
  });

  it("retains separate type and source groups while giving ignored-only groups an ignore initial value", () => {
    const otherSource = { ...expenseGroup, mappingKey: "wechat_pay|EXPENSE|餐饮|三餐" };
    const groups = getImportMappingGroups([incomeGroup], [expenseGroup, otherSource]);

    expect(groups).toHaveLength(3);
    expect(groups.find((group) => group.mappingKey === incomeGroup.mappingKey)?.initialValue).toBe("");
    expect(groups.filter((group) => group.mappingKey !== incomeGroup.mappingKey)
      .every((group) => group.initialValue === IGNORE_IMPORT_MAPPING_VALUE)).toBe(true);
  });

  it("ignores choices for groups that were not presented in the form", () => {
    const groups = getImportMappingGroups([expenseGroup], []);

    expect(getImportMappingChanges(groups, {
      [incomeGroup.mappingKey]: IGNORE_IMPORT_MAPPING_VALUE,
    })).toEqual([]);
  });
});

describe("import category recommendations", () => {
  it("requests only missing groups without an existing or manual choice", () => {
    const ignored = { ...expenseGroup, mappingKey: "ignored", initialValue: IGNORE_IMPORT_MAPPING_VALUE };
    const saved = { ...expenseGroup, mappingKey: "saved", initialValue: "saved-category" };
    const manual = { ...expenseGroup, mappingKey: "manual", initialValue: "" };
    const groups = [...getImportMappingGroups([expenseGroup, incomeGroup], []), ignored, saved, manual];

    expect(getImportMappingRecommendationTargets(groups, {
      [manual.mappingKey]: "manual-category",
      [saved.mappingKey]: "",
      [ignored.mappingKey]: "",
    })).toEqual(groups.slice(0, 2).map((group) => group.mappingKey));
  });

  it("prefills categories and explicit ignore while omitted uncertain groups stay empty", () => {
    const uncertain = { ...expenseGroup, mappingKey: "uncertain", initialValue: "" };
    const groups = [...getImportMappingGroups([expenseGroup, incomeGroup], []), uncertain];
    const versions = Object.fromEntries(groups.map((group) => [group.mappingKey, 0]));

    const choices = mergeImportMappingSuggestions(groups, {}, [
      { mappingKey: expenseGroup.mappingKey, categoryId: "dining" },
      { mappingKey: incomeGroup.mappingKey, categoryId: null },
    ], versions, {});

    expect(choices).toEqual({
      [expenseGroup.mappingKey]: "dining",
      [incomeGroup.mappingKey]: IGNORE_IMPORT_MAPPING_VALUE,
    });
    expect(getImportMappingRecommendationTargets(groups, choices)).toEqual([uncertain.mappingKey]);
  });

  it("preserves a manual choice made while recommendations were in flight", () => {
    const groups = getImportMappingGroups([expenseGroup], []);
    const choices = { [expenseGroup.mappingKey]: "manual-category" };

    expect(mergeImportMappingSuggestions(groups, choices, [
      { mappingKey: expenseGroup.mappingKey, categoryId: "dining" },
    ], { [expenseGroup.mappingKey]: 0 }, { [expenseGroup.mappingKey]: 1 })).toEqual(choices);
  });

  it("does not refill a selection the user changed and then cleared", () => {
    const groups = getImportMappingGroups([expenseGroup], []);
    const choices = { [expenseGroup.mappingKey]: "" };

    expect(mergeImportMappingSuggestions(groups, choices, [
      { mappingKey: expenseGroup.mappingKey, categoryId: "dining" },
    ], { [expenseGroup.mappingKey]: 0 }, { [expenseGroup.mappingKey]: 2 })).toEqual(choices);
  });

  it("ignores results for removed, already saved, or unrequested groups", () => {
    const groups = [{ ...expenseGroup, initialValue: "saved-category" }];

    expect(mergeImportMappingSuggestions(groups, {}, [
      { mappingKey: expenseGroup.mappingKey, categoryId: null },
      { mappingKey: incomeGroup.mappingKey, categoryId: "salary" },
      { mappingKey: "unknown", categoryId: null },
    ], { [expenseGroup.mappingKey]: 0, [incomeGroup.mappingKey]: 0 }, {})).toEqual({});

    expect(mergeImportMappingSuggestions(getImportMappingGroups([expenseGroup], []), {}, [
      { mappingKey: expenseGroup.mappingKey, categoryId: null },
    ], {}, {})).toEqual({});
  });
});
