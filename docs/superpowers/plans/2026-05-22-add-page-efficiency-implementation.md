# Add Page Efficiency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 优化 `/add` 记一笔页面，让分类选择以登录成员最近 30 个上海自然日的高频分类优先，并统一表单控件观感、减少移动端滑动成本。

**Architecture:** 用纯函数负责分类排序、默认选中和折叠列表计算；用 server-only Prisma 查询读取当前 session 家庭内登录成员的分类使用统计；`/add` 页面把已排序分类和默认分类传给 client form，client 只处理本页交互状态。时间控件通过一个小型 `IosDateTimeInput` 组件复用现有 iOS 风格表单 CSS，不引入自定义日期时间选择器。

**Tech Stack:** Next.js App Router, React 19, Prisma, Vitest, Playwright, Tailwind CSS, `lucide-react`.

---

## Scope Check

该计划只覆盖 `/add` 记一笔页面效率优化，属于一个可独立测试的子系统。它不改变数据库结构、认证授权、导入流程、记录编辑抽屉或首页报表。

仓库规则优先级：

- 代码和代码注释使用英文；本文档、验证记录和提交说明使用中文。
- 实现提交前运行完整验证：`npm run lint`、`npm run test:unit`、`npm run test:integration`、`npm run test:e2e`。
- 实现提交前执行 `skills/billboard-security-review/SKILL.md` 安全审查。
- 当前已发布版本是 `1.17.0`。本实现是 feature，最终提交时将 `package.json` 和 `package-lock.json` 更新为 `1.18.0`。
- 中间任务不创建 Git 提交；完成全部实现和验证后创建一个版本号一致的提交，避免同一 feature 被拆成多个同类型提交。

## File Structure

- Create `src/lib/transactions/category-preferences.ts`
  - 纯函数：上海最近自然日窗口、分类使用统计排序、默认分类、折叠态分类列表。
  - 不导入 `db`，允许 client component 和 server page 共用。
- Create `src/lib/transactions/query-category-preferences.ts`
  - server-only Prisma 查询：按当前 session 派生的 `householdId` 和登录成员 `memberId` 查询最近 30 个上海自然日内的有效交易统计。
- Modify `src/app/(app)/add/page.tsx`
  - 加载分类、家庭成员和使用统计。
  - 传入排序后的 `categories` 和 `defaultCategoryIds`。
- Modify `src/components/transaction-form.tsx`
  - 接收 `defaultCategoryIds`。
  - 切换支出/收入时用该类型默认分类。
  - 备注改成单行输入。
  - 时间控件改用 `IosDateTimeInput`。
- Modify `src/components/category-picker.tsx`
  - 支持 5 个 chip 折叠态、当前选中项挤入、更多/收起和切换类型后收起。
- Create `src/components/ios-datetime-input.tsx`
  - 包装原生 `datetime-local`，提供统一边框、高度和右侧 chevron。
- Modify `src/app/globals.css`
  - 添加 `.ios-datetime` 系列样式；微调分类 chip 尺寸。
- Modify `src/lib/i18n.ts`
  - 在 `common` 增加 `more` 和 `collapse` 中英文文案。
- Create `tests/unit/category-preferences.test.ts`
  - 覆盖排序、默认分类、折叠态和上海自然日窗口。
- Create `tests/unit/ios-datetime-input.test.tsx`
  - 覆盖原生 `datetime-local` 和 chevron 结构。
- Modify `tests/unit/i18n.test.ts`
  - 覆盖新增中英文文案。
- Modify `tests/integration/create-transaction.test.ts`
  - 保留现有 transaction form follow-up tests，并更新 CategoryPicker props。
- Create `tests/integration/category-preferences-query.test.ts`
  - 覆盖 Prisma 查询按家庭、成员、软删除和最近 30 个上海自然日过滤。
- Create `tests/integration/add-page-category-preferences.test.tsx`
  - 覆盖 `/add` 页面传入排序分类和默认分类。
- Modify `tests/e2e/create-expense.spec.ts`
  - 保持创建支出主流程，追加必要的“更多/收起”或紧凑分类断言。

---

## Task 1: Pure Category Preference Helpers

**Files:**
- Create: `src/lib/transactions/category-preferences.ts`
- Create: `tests/unit/category-preferences.test.ts`

- [ ] **Step 1: Write failing unit tests**

Create `tests/unit/category-preferences.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  getCollapsedCategoryIds,
  getDefaultCategoryIds,
  getRecentShanghaiNaturalDayWindow,
  orderCategoriesByUsage,
  type CategoryUsageStat,
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
    });
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
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```powershell
npm run test:unit -- tests/unit/category-preferences.test.ts
```

Expected: FAIL with an import error for `@/lib/transactions/category-preferences`.

- [ ] **Step 3: Implement the helper module**

Create `src/lib/transactions/category-preferences.ts`:

```ts
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

export type PreferenceCategoryType = "income" | "expense";

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

function toShanghaiDateParts(date: Date) {
  const shanghaiDate = new Date(date.getTime() + SHANGHAI_OFFSET_MS);

  return {
    day: shanghaiDate.getUTCDate(),
    month: shanghaiDate.getUTCMonth(),
    year: shanghaiDate.getUTCFullYear(),
  };
}

function startOfShanghaiDateUtc(year: number, month: number, day: number) {
  return new Date(Date.UTC(year, month, day, -8, 0, 0, 0));
}

export function getRecentShanghaiNaturalDayWindow(now: Date = new Date(), days = 30) {
  const parts = toShanghaiDateParts(now);
  const from = startOfShanghaiDateUtc(parts.year, parts.month, parts.day - (days - 1));

  return { from, to: now };
}

export function orderCategoriesByUsage(
  categories: PreferenceCategory[],
  usageStats: CategoryUsageStat[],
) {
  const defaultIndexById = new Map(categories.map((category, index) => [category.id, index]));
  const statsByCategoryId = new Map(usageStats.map((stat) => [stat.categoryId, stat]));

  return [...categories].sort((left, right) => {
    if (left.type !== right.type) {
      return defaultIndexById.get(left.id)! - defaultIndexById.get(right.id)!;
    }

    const leftStat = statsByCategoryId.get(left.id);
    const rightStat = statsByCategoryId.get(right.id);
    const leftCount = leftStat?.count ?? 0;
    const rightCount = rightStat?.count ?? 0;

    if (leftCount !== rightCount) {
      return rightCount - leftCount;
    }

    const leftTime = leftStat?.lastOccurredAt.getTime() ?? 0;
    const rightTime = rightStat?.lastOccurredAt.getTime() ?? 0;

    if (leftTime !== rightTime) {
      return rightTime - leftTime;
    }

    return defaultIndexById.get(left.id)! - defaultIndexById.get(right.id)!;
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
  selectedCategoryId: string,
  visibleLimit = 5,
) {
  const visible = categories.slice(0, visibleLimit);
  const selected = categories.find((category) => category.id === selectedCategoryId);

  if (!selected || visible.some((category) => category.id === selectedCategoryId)) {
    return visible.map((category) => category.id);
  }

  return [...visible.slice(0, Math.max(visibleLimit - 1, 0)), selected].map(
    (category) => category.id,
  );
}
```

- [ ] **Step 4: Run unit test and verify it passes**

Run:

```powershell
npm run test:unit -- tests/unit/category-preferences.test.ts
```

Expected: PASS.

- [ ] **Step 5: Checkpoint**

Run:

```powershell
git diff -- src/lib/transactions/category-preferences.ts tests/unit/category-preferences.test.ts
```

Expected: diff only contains the new helper and its tests.

---

## Task 2: Server Query For Recent Category Usage

**Files:**
- Create: `src/lib/transactions/query-category-preferences.ts`
- Create: `tests/integration/category-preferences-query.test.ts`

- [ ] **Step 1: Write failing integration tests**

Create `tests/integration/category-preferences-query.test.ts`:

```ts
import { existsSync } from "node:fs";

if (existsSync(".env")) {
  process.loadEnvFile?.(".env");
}

if (existsSync(".env.example")) {
  process.loadEnvFile?.(".env.example");
}

import { CategoryType, HouseholdRole, TransactionType } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

let db: typeof import("@/lib/db").db;
let queryRecentCategoryUsage: typeof import("@/lib/transactions/query-category-preferences").queryRecentCategoryUsage;

const createdTransactionIds: string[] = [];
const createdHouseholdIds: string[] = [];
const createdMemberIds: string[] = [];
const createdUserIds: string[] = [];

beforeAll(async () => {
  ({ db } = await import("@/lib/db"));
  ({ queryRecentCategoryUsage } = await import("@/lib/transactions/query-category-preferences"));
});

afterEach(async () => {
  await db.transaction.deleteMany({ where: { id: { in: createdTransactionIds.splice(0) } } });
  await db.householdMember.deleteMany({ where: { id: { in: createdMemberIds.splice(0) } } });
  await db.user.deleteMany({ where: { id: { in: createdUserIds.splice(0) } } });
  await db.household.deleteMany({ where: { id: { in: createdHouseholdIds.splice(0) } } });
});

afterAll(async () => {
  await db.$disconnect();
});

async function getSeedFixture() {
  const ownerEmail = process.env.SEED_USER_A_EMAIL ?? "user-a@example.com";
  const [ownerMember, spouseMember, dining, shopping] = await Promise.all([
    db.householdMember.findFirstOrThrow({
      where: { user: { email: ownerEmail } },
    }),
    db.householdMember.findFirstOrThrow({
      where: { user: { email: process.env.SEED_USER_B_EMAIL ?? ownerEmail } },
    }),
    db.category.findUniqueOrThrow({
      where: { type_name: { type: CategoryType.EXPENSE, name: "Dining" } },
    }),
    db.category.findUniqueOrThrow({
      where: { type_name: { type: CategoryType.EXPENSE, name: "Shopping" } },
    }),
  ]);

  return { dining, ownerMember, shopping, spouseMember };
}

async function createOutsideMember() {
  const suffix = Date.now().toString(36);
  const household = await db.household.create({ data: { name: `Outside ${suffix}` } });
  createdHouseholdIds.push(household.id);

  const user = await db.user.create({
    data: {
      displayName: `Outside ${suffix}`,
      email: `outside-${suffix}@example.com`,
      passwordHash: "not-used",
    },
  });
  createdUserIds.push(user.id);

  const member = await db.householdMember.create({
    data: {
      householdId: household.id,
      memberName: `Outside ${suffix}`,
      role: HouseholdRole.MEMBER,
      userId: user.id,
    },
  });
  createdMemberIds.push(member.id);

  return { household, member };
}

async function createTransaction(input: {
  actorMemberId: string;
  categoryId: string;
  createdByMemberId: string;
  deletedAt?: Date | null;
  householdId: string;
  occurredAt: Date;
}) {
  const transaction = await db.transaction.create({
    data: {
      actorMemberId: input.actorMemberId,
      amountFen: 100,
      categoryId: input.categoryId,
      createdByMemberId: input.createdByMemberId,
      deletedAt: input.deletedAt ?? null,
      householdId: input.householdId,
      occurredAt: input.occurredAt,
      type: TransactionType.EXPENSE,
    },
  });
  createdTransactionIds.push(transaction.id);

  return transaction;
}

describe("queryRecentCategoryUsage", () => {
  it("counts only active transactions for the current household and login member", async () => {
    const { dining, ownerMember, shopping, spouseMember } = await getSeedFixture();
    const outside = await createOutsideMember();
    const now = new Date("2026-05-22T15:30:00.000Z");

    await createTransaction({
      actorMemberId: ownerMember.id,
      categoryId: shopping.id,
      createdByMemberId: ownerMember.id,
      householdId: ownerMember.householdId,
      occurredAt: new Date("2026-05-21T02:00:00.000Z"),
    });
    await createTransaction({
      actorMemberId: ownerMember.id,
      categoryId: shopping.id,
      createdByMemberId: ownerMember.id,
      householdId: ownerMember.householdId,
      occurredAt: new Date("2026-05-20T02:00:00.000Z"),
    });
    await createTransaction({
      actorMemberId: ownerMember.id,
      categoryId: dining.id,
      createdByMemberId: ownerMember.id,
      householdId: ownerMember.householdId,
      occurredAt: new Date("2026-04-22T16:00:00.000Z"),
    });
    await createTransaction({
      actorMemberId: ownerMember.id,
      categoryId: dining.id,
      createdByMemberId: ownerMember.id,
      deletedAt: new Date("2026-05-21T03:00:00.000Z"),
      householdId: ownerMember.householdId,
      occurredAt: new Date("2026-05-21T03:00:00.000Z"),
    });
    await createTransaction({
      actorMemberId: spouseMember.id,
      categoryId: dining.id,
      createdByMemberId: ownerMember.id,
      householdId: ownerMember.householdId,
      occurredAt: new Date("2026-05-21T04:00:00.000Z"),
    });
    await createTransaction({
      actorMemberId: outside.member.id,
      categoryId: shopping.id,
      createdByMemberId: outside.member.id,
      householdId: outside.household.id,
      occurredAt: new Date("2026-05-21T05:00:00.000Z"),
    });

    await expect(
      queryRecentCategoryUsage({
        householdId: ownerMember.householdId,
        memberId: ownerMember.id,
        now,
      }),
    ).resolves.toEqual([
      {
        categoryId: shopping.id,
        count: 2,
        lastOccurredAt: new Date("2026-05-21T02:00:00.000Z"),
        type: "expense",
      },
      {
        categoryId: dining.id,
        count: 1,
        lastOccurredAt: new Date("2026-04-22T16:00:00.000Z"),
        type: "expense",
      },
    ]);
  });
});
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```powershell
npm run test:integration -- tests/integration/category-preferences-query.test.ts
```

Expected: FAIL with an import error for `@/lib/transactions/query-category-preferences`.

- [ ] **Step 3: Implement server query**

Create `src/lib/transactions/query-category-preferences.ts`:

```ts
import "server-only";
import { TransactionType } from "@prisma/client";
import { db } from "@/lib/db";
import {
  getRecentShanghaiNaturalDayWindow,
  type CategoryUsageStat,
} from "@/lib/transactions/category-preferences";

type QueryRecentCategoryUsageInput = {
  householdId: string;
  memberId: string;
  now?: Date;
};

const transactionTypeMap = {
  [TransactionType.EXPENSE]: "expense",
  [TransactionType.INCOME]: "income",
} as const;

export async function queryRecentCategoryUsage({
  householdId,
  memberId,
  now = new Date(),
}: QueryRecentCategoryUsageInput): Promise<CategoryUsageStat[]> {
  const window = getRecentShanghaiNaturalDayWindow(now, 30);
  const rows = await db.transaction.groupBy({
    by: ["categoryId", "type"],
    where: {
      actorMemberId: memberId,
      deletedAt: null,
      householdId,
      occurredAt: {
        gte: window.from,
        lte: window.to,
      },
    },
    _count: { _all: true },
    _max: { occurredAt: true },
  });

  return rows
    .map((row) => ({
      categoryId: row.categoryId,
      count: row._count._all,
      lastOccurredAt: row._max.occurredAt ?? window.from,
      type: transactionTypeMap[row.type],
    }))
    .sort((left, right) => {
      if (left.type !== right.type) {
        return left.type === "expense" ? -1 : 1;
      }

      if (left.count !== right.count) {
        return right.count - left.count;
      }

      return right.lastOccurredAt.getTime() - left.lastOccurredAt.getTime();
    });
}
```

- [ ] **Step 4: Run integration test and verify it passes**

Run:

```powershell
npm run test:integration -- tests/integration/category-preferences-query.test.ts
```

Expected: PASS.

- [ ] **Step 5: Checkpoint**

Run:

```powershell
git diff -- src/lib/transactions/query-category-preferences.ts tests/integration/category-preferences-query.test.ts
```

Expected: diff only contains query code and the integration test.

---

## Task 3: Wire Preferences Into `/add` Page

**Files:**
- Modify: `src/app/(app)/add/page.tsx`
- Create: `tests/integration/add-page-category-preferences.test.tsx`

- [ ] **Step 1: Write failing page wiring test**

Create `tests/integration/add-page-category-preferences.test.tsx`:

```tsx
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  categoryFindManyMock,
  householdMemberFindManyMock,
  queryRecentCategoryUsageMock,
  recordAppEventMock,
  requireAppSessionMock,
  transactionFormMock,
} = vi.hoisted(() => ({
  categoryFindManyMock: vi.fn(),
  householdMemberFindManyMock: vi.fn(),
  queryRecentCategoryUsageMock: vi.fn(),
  recordAppEventMock: vi.fn(),
  requireAppSessionMock: vi.fn(),
  transactionFormMock: vi.fn(() => createElement("div", { "data-testid": "transaction-form" })),
}));

vi.mock("@/components/transaction-form", () => ({
  TransactionForm: transactionFormMock,
}));

vi.mock("@/lib/auth/session", () => ({
  requireAppSession: requireAppSessionMock,
}));

vi.mock("@/lib/db", () => ({
  db: {
    category: { findMany: categoryFindManyMock },
    householdMember: { findMany: householdMemberFindManyMock },
  },
}));

vi.mock("@/lib/i18n-server", () => ({
  getServerLocale: vi.fn(async () => "zh-CN"),
}));

vi.mock("@/lib/ops/record-event", () => ({
  recordAppEvent: recordAppEventMock,
}));

vi.mock("@/lib/transactions/query-category-preferences", () => ({
  queryRecentCategoryUsage: queryRecentCategoryUsageMock,
}));

describe("AddPage category preferences", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-22T15:30:00.000Z"));
    categoryFindManyMock.mockReset();
    householdMemberFindManyMock.mockReset();
    queryRecentCategoryUsageMock.mockReset();
    recordAppEventMock.mockReset();
    requireAppSessionMock.mockReset();
    transactionFormMock.mockClear();
  });

  it("passes categories ordered by recent usage and default category ids to the form", async () => {
    requireAppSessionMock.mockResolvedValue({
      householdId: "household-1",
      id: "user-1",
      memberId: "member-1",
    });
    categoryFindManyMock.mockResolvedValue([
      { id: "dining", name: "Dining", type: "EXPENSE" },
      { id: "shopping", name: "Shopping", type: "EXPENSE" },
      { id: "salary", name: "Salary", type: "INCOME" },
      { id: "bonus", name: "Bonus", type: "INCOME" },
    ]);
    householdMemberFindManyMock.mockResolvedValue([{ id: "member-1", memberName: "Me" }]);
    queryRecentCategoryUsageMock.mockResolvedValue([
      {
        categoryId: "shopping",
        count: 4,
        lastOccurredAt: new Date("2026-05-21T02:00:00.000Z"),
        type: "expense",
      },
      {
        categoryId: "bonus",
        count: 1,
        lastOccurredAt: new Date("2026-05-20T02:00:00.000Z"),
        type: "income",
      },
    ]);

    const { default: AddPage } = await import("@/app/(app)/add/page");
    renderToStaticMarkup(await AddPage({ searchParams: Promise.resolve({}) }));

    expect(queryRecentCategoryUsageMock).toHaveBeenCalledWith({
      householdId: "household-1",
      memberId: "member-1",
      now: new Date("2026-05-22T15:30:00.000Z"),
    });
    expect(transactionFormMock).toHaveBeenCalledWith(
      expect.objectContaining({
        categories: [
          { id: "shopping", name: "Shopping", type: "expense" },
          { id: "dining", name: "Dining", type: "expense" },
          { id: "bonus", name: "Bonus", type: "income" },
          { id: "salary", name: "Salary", type: "income" },
        ],
        defaultCategoryIds: {
          expense: "shopping",
          income: "bonus",
        },
      }),
      undefined,
    );
  });
});
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```powershell
npm run test:integration -- tests/integration/add-page-category-preferences.test.tsx
```

Expected: FAIL because `TransactionForm` does not yet receive `defaultCategoryIds` and `/add` does not call `queryRecentCategoryUsage`.

- [ ] **Step 3: Update AddPage imports and data loading**

Modify `src/app/(app)/add/page.tsx` imports:

```ts
import {
  getDefaultCategoryIds,
  orderCategoriesByUsage,
  type PreferenceCategory,
} from "@/lib/transactions/category-preferences";
import { queryRecentCategoryUsage } from "@/lib/transactions/query-category-preferences";
```

Replace the existing `Promise.all` block and category prop construction with:

```tsx
  const now = new Date();
  const [categories, householdMembers, categoryUsageStats] = await Promise.all([
    db.category.findMany({
      where: { isActive: true },
      orderBy: [{ type: "asc" }, { sortOrder: "asc" }, { name: "asc" }],
      select: { id: true, name: true, type: true },
    }),
    db.householdMember.findMany({
      where: { householdId: user.householdId },
      orderBy: [{ joinedAt: "asc" }, { memberName: "asc" }],
      select: { id: true, memberName: true },
    }),
    queryRecentCategoryUsage({
      householdId: user.householdId,
      memberId: user.memberId,
      now,
    }),
  ]);
  const categoryOptions: PreferenceCategory[] = categories.map((category) => ({
    id: category.id,
    name: category.name,
    type: category.type === "INCOME" ? "income" : "expense",
  }));
  const orderedCategories = orderCategoriesByUsage(categoryOptions, categoryUsageStats);
```

Pass the new props:

```tsx
      <TransactionForm
        categories={orderedCategories}
        currentMemberId={user.memberId}
        defaultCategoryIds={getDefaultCategoryIds(orderedCategories)}
        householdMembers={householdMembers}
        labels={{ add: { save: messages.add.save }, common: messages.common }}
        locale={locale}
        sharedFilters={sharedParams}
        successDetail={readSuccessDetail(resolvedSearchParams, locale, messages)}
        successMessage={resolvedSearchParams?.created === "1" ? messages.add.successMessage : undefined}
      />
```

- [ ] **Step 4: Run page wiring test and verify it passes**

Run:

```powershell
npm run test:integration -- tests/integration/add-page-category-preferences.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Checkpoint**

Run:

```powershell
git diff -- 'src/app/(app)/add/page.tsx' tests/integration/add-page-category-preferences.test.tsx
```

Expected: diff only wires usage stats into `/add`.

---

## Task 4: I18n And DateTime Control Foundation

**Files:**
- Modify: `src/lib/i18n.ts`
- Modify: `tests/unit/i18n.test.ts`
- Create: `src/components/ios-datetime-input.tsx`
- Create: `tests/unit/ios-datetime-input.test.tsx`
- Modify: `src/app/globals.css`

- [ ] **Step 1: Write failing i18n expectations**

Modify `tests/unit/i18n.test.ts` in `returns UI messages for both supported locales`:

```ts
    expect(getMessages("zh-CN").common.more).toBe("更多");
    expect(getMessages("zh-CN").common.collapse).toBe("收起");
    expect(getMessages("en-US").common.more).toBe("More");
    expect(getMessages("en-US").common.collapse).toBe("Collapse");
```

- [ ] **Step 2: Write failing DateTime component test**

Create `tests/unit/ios-datetime-input.test.tsx`:

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { IosDateTimeInput } from "@/components/ios-datetime-input";

describe("IosDateTimeInput", () => {
  it("renders a native datetime-local input with the shared iOS control wrapper", () => {
    const markup = renderToStaticMarkup(
      <IosDateTimeInput defaultValue="2026-05-22T23:29" name="occurredAt" required />,
    );

    expect(markup).toContain('class="ios-datetime"');
    expect(markup).toContain('type="datetime-local"');
    expect(markup).toContain('class="ios-datetime__native"');
    expect(markup).toContain('class="ios-datetime__icon"');
    expect(markup).toContain('name="occurredAt"');
  });
});
```

- [ ] **Step 3: Run tests and verify they fail**

Run:

```powershell
npm run test:unit -- tests/unit/i18n.test.ts tests/unit/ios-datetime-input.test.tsx
```

Expected: FAIL because `common.more`, `common.collapse`, and `IosDateTimeInput` do not exist.

- [ ] **Step 4: Add i18n labels**

Modify `src/lib/i18n.ts` `messages["zh-CN"].common`:

```ts
      collapse: "收起",
      more: "更多",
```

Modify `messages["en-US"].common`:

```ts
      collapse: "Collapse",
      more: "More",
```

- [ ] **Step 5: Add DateTime component**

Create `src/components/ios-datetime-input.tsx`:

```tsx
"use client";

import { ChevronDown } from "lucide-react";
import type { InputHTMLAttributes } from "react";

type IosDateTimeInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "className" | "type"> & {
  className?: string;
};

export function IosDateTimeInput({ className, ...props }: IosDateTimeInputProps) {
  const classNames = ["ios-datetime", className ?? ""].filter(Boolean).join(" ");

  return (
    <span className={classNames}>
      <input {...props} className="ios-datetime__native" type="datetime-local" />
      <ChevronDown aria-hidden="true" className="ios-datetime__icon" strokeWidth={2.35} />
    </span>
  );
}
```

- [ ] **Step 6: Add DateTime CSS**

Modify `src/app/globals.css` inside `@layer components` after `.ios-select` rules:

```css
  .ios-datetime {
    align-items: center;
    background: #ffffff;
    border: 1px solid rgba(0, 0, 0, 0.1);
    border-radius: 1rem;
    color: #1d1d1f;
    display: inline-flex;
    min-height: 2.75rem;
    min-width: 0;
    position: relative;
    transition: border-color 150ms ease, box-shadow 150ms ease;
    width: 100%;
  }

  .ios-datetime__native {
    appearance: none;
    background: transparent;
    border: 0;
    border-radius: inherit;
    color: inherit;
    font-size: 0.875rem;
    line-height: 1.25rem;
    min-height: 2.75rem;
    padding: 0.75rem 2.6875rem 0.75rem 1rem;
    width: 100%;
  }

  .ios-datetime__native:focus {
    outline: none;
  }

  .ios-datetime__native::-webkit-calendar-picker-indicator {
    cursor: pointer;
    inset: 0;
    opacity: 0;
    position: absolute;
    width: 100%;
  }

  .ios-datetime__icon {
    color: #1d1d1f;
    height: 1.375rem;
    pointer-events: none;
    position: absolute;
    right: 0.5625rem;
    top: 50%;
    transform: translateY(-50%);
    width: 1.375rem;
  }

  .ios-datetime:focus-within {
    border-color: var(--ios-blue);
    box-shadow: 0 0 0 4px rgba(0, 122, 255, 0.12);
  }

  .ios-datetime:has(.ios-datetime__native:focus-visible) {
    outline: 3px solid rgba(0, 122, 255, 0.28);
    outline-offset: 2px;
  }
```

- [ ] **Step 7: Run tests and verify they pass**

Run:

```powershell
npm run test:unit -- tests/unit/i18n.test.ts tests/unit/ios-datetime-input.test.tsx
```

Expected: PASS.

---

## Task 5: Compact CategoryPicker With More/Collapse

**Files:**
- Modify: `src/components/category-picker.tsx`
- Modify: `tests/integration/create-transaction.test.ts`

- [ ] **Step 1: Update existing CategoryPicker test to fail on new props and compact controls**

Modify the `renders categories as quick-tap buttons instead of a select` test props in `tests/integration/create-transaction.test.ts`:

```ts
        labels: {
          collapse: "Collapse",
          more: "More",
        },
```

Add these expectations after the existing button assertions:

```ts
    expect(markup).toContain(">More</button>");
    expect(markup).toContain("category-picker__chip");
    expect(markup).not.toContain('min-h-12');
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```powershell
npm run test:integration -- tests/integration/create-transaction.test.ts
```

Expected: FAIL because `CategoryPicker` does not accept `labels` and does not render the compact class.

- [ ] **Step 3: Implement compact CategoryPicker**

Modify `src/components/category-picker.tsx`:

```tsx
"use client";

import { useEffect, useMemo, useState } from "react";
import {
  getCollapsedCategoryIds,
  type PreferenceCategory,
} from "@/lib/transactions/category-preferences";
import { getCategoryDisplayName, type Locale, type Messages } from "@/lib/i18n";

type TransactionCategory = PreferenceCategory;

type CategoryPickerProps = {
  categories: TransactionCategory[];
  label: Messages["common"]["category"];
  labels: Pick<Messages["common"], "collapse" | "more">;
  locale: Locale;
  selectedType: TransactionCategory["type"];
  selectedCategoryId: string;
  onSelect: (categoryId: string) => void;
};

export type { TransactionCategory };

const collapsedLimit = 5;

export function CategoryPicker({
  categories,
  label,
  labels,
  locale,
  selectedType,
  selectedCategoryId,
  onSelect,
}: CategoryPickerProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const availableCategories = useMemo(
    () => categories.filter((category) => category.type === selectedType),
    [categories, selectedType],
  );
  const visibleCategoryIds = isExpanded
    ? availableCategories.map((category) => category.id)
    : getCollapsedCategoryIds(availableCategories, selectedCategoryId, collapsedLimit);
  const visibleCategoryIdSet = new Set(visibleCategoryIds);
  const visibleCategories = availableCategories.filter((category) =>
    visibleCategoryIdSet.has(category.id),
  );
  const canToggle = availableCategories.length > collapsedLimit;

  useEffect(() => {
    setIsExpanded(false);
  }, [selectedType]);

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-[var(--ios-text)]">{label}</span>
      </div>
      <input name="categoryId" readOnly required type="hidden" value={selectedCategoryId} />
      <div className="grid grid-cols-3 gap-2">
        {visibleCategories.map((category) => (
          <button
            className={`category-picker__chip rounded-xl border px-2.5 py-2 text-sm font-semibold transition ${
              selectedCategoryId === category.id
                ? "border-[var(--ios-blue)] bg-[var(--ios-blue-soft)] text-[var(--ios-blue)]"
                : "border-black/10 bg-white text-[var(--ios-text)] hover:border-black/20 hover:bg-black/[0.03]"
            }`}
            key={category.id}
            onClick={() => onSelect(category.id)}
            type="button"
          >
            {getCategoryDisplayName(category.name, locale)}
          </button>
        ))}
        {canToggle ? (
          <button
            className="category-picker__chip rounded-xl border border-dashed border-black/15 bg-white px-2.5 py-2 text-sm font-semibold text-[var(--ios-muted)] transition hover:border-black/25 hover:bg-black/[0.03]"
            onClick={() => setIsExpanded((current) => !current)}
            type="button"
          >
            {isExpanded ? labels.collapse : labels.more}
          </button>
        ) : null}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run integration test and verify it passes**

Run:

```powershell
npm run test:integration -- tests/integration/create-transaction.test.ts
```

Expected: PASS.

---

## Task 6: TransactionForm Uses Defaults, Compact Note, And DateTime Control

**Files:**
- Modify: `src/components/transaction-form.tsx`
- Modify: `tests/integration/create-transaction.test.ts`

- [ ] **Step 1: Add failing follow-up UI assertions**

Append this test to `describe("transaction form follow-up UI requirements", ...)` in `tests/integration/create-transaction.test.ts`:

```ts
  it("uses the shared datetime control and compact note field", () => {
    const source = readFileSync(
      path.resolve(process.cwd(), "src/components/transaction-form.tsx"),
      "utf8",
    );

    expect(source).toContain("IosDateTimeInput");
    expect(source).toContain('type="text"');
    expect(source).not.toContain("min-h-24");
    expect(source).not.toContain("<textarea");
  });
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```powershell
npm run test:integration -- tests/integration/create-transaction.test.ts
```

Expected: FAIL because `TransactionForm` still uses `textarea` and raw `datetime-local` input.

- [ ] **Step 3: Update TransactionForm props and imports**

Modify `src/components/transaction-form.tsx` imports:

```tsx
import { IosDateTimeInput } from "@/components/ios-datetime-input";
import type { DefaultCategoryIds } from "@/lib/transactions/category-preferences";
```

Update `TransactionFormProps`:

```ts
  defaultCategoryIds: DefaultCategoryIds;
```

Update function params:

```ts
  defaultCategoryIds,
```

Replace initial category state:

```ts
  const [selectedCategoryId, setSelectedCategoryId] = useState(defaultCategoryIds[defaultType]);
```

Replace `handleTypeChange`:

```ts
  function handleTypeChange(type: TransactionCategory["type"]) {
    setSelectedType(type);
    setSelectedCategoryId(defaultCategoryIds[type]);
  }
```

Pass labels into `CategoryPicker`:

```tsx
      <CategoryPicker
        categories={categories}
        label={labels.common.category}
        labels={{
          collapse: labels.common.collapse,
          more: labels.common.more,
        }}
        locale={locale}
        onSelect={setSelectedCategoryId}
        selectedCategoryId={selectedCategoryId}
        selectedType={selectedType}
      />
```

- [ ] **Step 4: Replace time and note controls**

Replace the raw time input with:

```tsx
        <IosDateTimeInput
          defaultValue={occurredAtDefault}
          name="occurredAt"
          required
        />
```

Replace the `textarea` with:

```tsx
        <input
          className="ios-field w-full"
          name="note"
          placeholder={labels.common.optional}
          type="text"
        />
```

- [ ] **Step 5: Run focused tests and verify they pass**

Run:

```powershell
npm run test:integration -- tests/integration/create-transaction.test.ts tests/integration/add-page-category-preferences.test.tsx
```

Expected: PASS.

---

## Task 7: E2E Flow And Mobile UI Smoke

**Files:**
- Modify: `tests/e2e/create-expense.spec.ts`

- [ ] **Step 1: Update E2E expectations**

In `tests/e2e/create-expense.spec.ts`, after `await page.goto("/add?perspective=spouse&mode=month");`, add:

```ts
  await expect(page.getByRole("button", { name: "更多" })).toBeVisible();
  await expect(page.getByLabel("时间")).toBeVisible();
```

Keep the existing `购物` click. It remains in the default seed first five expense categories, so the test still exercises quick-tap creation without needing “更多”.

- [ ] **Step 2: Run focused E2E and verify it passes**

Run:

```powershell
npm run test:e2e -- tests/e2e/create-expense.spec.ts
```

Expected: PASS.

- [ ] **Step 3: Start dev server for manual mobile smoke if Playwright did not already leave one available**

If no dev server is running, start:

```powershell
$env:DATABASE_URL=$env:DATABASE_URL; $env:AUTH_SECRET='replace-me'; npm run dev
```

Expected: local dev serves `http://127.0.0.1:2500`.

- [ ] **Step 4: Browser smoke checklist**

Open `http://127.0.0.1:2500/add` through the browser tool after login and inspect a mobile viewport:

- 分类区折叠态为 5 个 chip 加“更多”。
- 成员和时间控件高度、边框、右侧图标视觉一致。
- 分类 label、成员 label、时间 label 与控件之间间距一致。
- 备注是单行输入。
- 底部提交按钮不被主导航遮挡。

Expected: all checklist items pass.

---

## Task 8: Final Verification, Security Review, Version, Commit, Push, Restart

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `tests/unit/security-config.test.ts`

- [ ] **Step 1: Bump implementation version**

Change `package.json`:

```json
  "version": "1.18.0",
```

Change the root and package entry in `package-lock.json`:

```json
  "version": "1.18.0",
```

Change the expected package and lockfile versions in `tests/unit/security-config.test.ts`:

```ts
    expect(packageJson.version).toBe("1.18.0");
    expect(packageLock.version).toBe("1.18.0");
    expect(packageLock.packages[""].version).toBe("1.18.0");
```

- [ ] **Step 2: Run complete verification**

Run:

```powershell
npm run lint
npm run test:unit
npm run test:integration
npm run test:e2e
```

Expected: all commands pass.

- [ ] **Step 3: Run security review scans**

Run:

```powershell
rg -n "AUTH_SECRET|NEXTAUTH_SECRET|POSTGRES_PASSWORD|DATABASE_URL|NEXT_ALLOWED_DEV_ORIGINS|APP_BASE_PATH|frp|nginx|ECS|password|secret|token" .
rg -n "deletedAt|householdId|memberId|sourceFingerprint|amountFen|Asia/Shanghai" src tests prisma
```

Expected:

- No real credentials, production host, public IP, private URL, or secret values in tracked changes.
- New transaction usage query includes `householdId`, `actorMemberId`, `deletedAt: null`, and `Asia/Shanghai` window logic.
- No amount persistence changes outside existing `amountFen` flow.

- [ ] **Step 4: Inspect Git state and origin diff**

Run:

```powershell
git status --short
git fetch origin master
git branch --show-current
git rev-list --left-right --count origin/master...HEAD
git diff --stat
git diff --check
```

Expected:

- Branch is `master`.
- Worktree changes are only planned files.
- `git diff --check` passes.
- Local branch is not behind `origin/master`.

- [ ] **Step 5: Commit**

Run:

```powershell
git add src tests package.json package-lock.json docs/superpowers/plans/2026-05-22-add-page-efficiency-implementation.md
git commit -m "v1.18.0 优化记一笔效率" -m "添加常用分类优先、紧凑分类选择、统一时间控件和备注单行输入，提升移动端快速记账效率。"
```

Expected: commit succeeds and message version matches `package.json`.

- [ ] **Step 6: Push and restart production**

Run:

```powershell
git push origin master
.\ops\windows\start-production.ps1
```

Expected: push succeeds and production restart script exits successfully.

- [ ] **Step 7: Production smoke check**

Run:

```powershell
try {
  $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3000/login' -TimeoutSec 20
  "StatusCode=$($response.StatusCode)"
  if ($response.Content -match 'BillBoard|登录|Login') { 'LoginPage=matched' } else { 'LoginPage=not-matched' }
} catch {
  "ERROR=$($_.Exception.Message)"
  exit 1
}
```

Expected:

```text
StatusCode=200
LoginPage=matched
```

## Self-Review

- Spec coverage: 页面结构、常用分类排序、折叠/展开、选中项挤入、时间控件一致性、备注单行、i18n、验证和安全要求均有对应任务。
- Placeholder scan: 本计划未留下待补内容、临时标记或未解释的空步骤。
- Type consistency: `PreferenceCategory`、`CategoryUsageStat`、`DefaultCategoryIds`、`queryRecentCategoryUsage`、`IosDateTimeInput`、`labels.more` 和 `labels.collapse` 在任务间保持一致。
