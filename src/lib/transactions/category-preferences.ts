export type PreferenceCategoryType = "expense" | "income";

export type PreferenceCategory = {
  id: string;
  name: string;
  type: PreferenceCategoryType;
};

export type CategoryUsageStat = {
  categoryId: string;
  count: number;
  lastOccurredAt: Date;
  type: PreferenceCategoryType;
};

export type DefaultCategoryIds = Record<PreferenceCategoryType, string>;

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

export function getRecentShanghaiNaturalDayWindow(now: Date, dayCount: number): { from: Date; to: Date } {
  const shanghaiTime = now.getTime() + SHANGHAI_OFFSET_MS;
  const shanghaiDayStart = new Date(shanghaiTime);
  shanghaiDayStart.setUTCHours(0, 0, 0, 0);

  return {
    from: new Date(shanghaiDayStart.getTime() - SHANGHAI_OFFSET_MS - (dayCount - 1) * 24 * 60 * 60 * 1000),
    to: now,
  };
}

export function orderCategoriesByUsage(
  categories: PreferenceCategory[],
  usageStats: CategoryUsageStat[],
): PreferenceCategory[] {
  const typeOrder = new Map<PreferenceCategoryType, number>();
  const categoryOrder = new Map<string, number>();
  const usageByCategoryId = new Map<string, CategoryUsageStat>();

  categories.forEach((category, index) => {
    if (!typeOrder.has(category.type)) {
      typeOrder.set(category.type, typeOrder.size);
    }
    categoryOrder.set(category.id, index);
  });

  usageStats.forEach((stat) => {
    usageByCategoryId.set(stat.categoryId, stat);
  });

  return [...categories].sort((left, right) => {
    const typeDifference = (typeOrder.get(left.type) ?? 0) - (typeOrder.get(right.type) ?? 0);
    if (typeDifference !== 0) {
      return typeDifference;
    }

    const leftUsage = usageByCategoryId.get(left.id);
    const rightUsage = usageByCategoryId.get(right.id);
    const leftCount = leftUsage?.type === left.type ? leftUsage.count : 0;
    const rightCount = rightUsage?.type === right.type ? rightUsage.count : 0;
    if (leftCount !== rightCount) {
      return rightCount - leftCount;
    }

    const leftLastOccurredAt = leftUsage?.type === left.type ? leftUsage.lastOccurredAt.getTime() : 0;
    const rightLastOccurredAt = rightUsage?.type === right.type ? rightUsage.lastOccurredAt.getTime() : 0;
    if (leftLastOccurredAt !== rightLastOccurredAt) {
      return rightLastOccurredAt - leftLastOccurredAt;
    }

    return (categoryOrder.get(left.id) ?? 0) - (categoryOrder.get(right.id) ?? 0);
  });
}

export function getDefaultCategoryIds(categories: PreferenceCategory[]): DefaultCategoryIds {
  return {
    expense: categories.find((category) => category.type === "expense")?.id ?? "",
    income: categories.find((category) => category.type === "income")?.id ?? "",
  };
}

export function getCollapsedCategoryIds(
  categories: PreferenceCategory[],
  selectedCategoryId: string | null | undefined,
  visibleLimit: number,
): string[] {
  const visibleCategoryIds = categories.slice(0, visibleLimit).map((category) => category.id);

  if (
    selectedCategoryId === null ||
    selectedCategoryId === undefined ||
    visibleCategoryIds.includes(selectedCategoryId) ||
    !categories.some((category) => category.id === selectedCategoryId)
  ) {
    return visibleCategoryIds;
  }

  return [...visibleCategoryIds.slice(0, Math.max(visibleLimit - 1, 0)), selectedCategoryId];
}
