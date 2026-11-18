# Add Expense Categories Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `Childcare` and `Parent Care` as default expense categories, shown as “育儿”和“孝心” in the Chinese UI.

**Architecture:** Keep default categories in `prisma/seed.ts`, matching the existing seed-driven category model. Keep category translation display-only in `src/lib/i18n.ts`; form submissions, filters, reports, and record editing continue to use `categoryId`.

**Tech Stack:** Next.js App Router, Prisma seed script, Vitest, Playwright, PostgreSQL seed data.

---

### File Structure

- Modify: `tests/unit/i18n.test.ts` - covers display-only Chinese category mappings and English fallback behavior.
- Create: `tests/integration/seed-categories.test.ts` - verifies seeded expense categories include `Childcare` and `Parent Care` in the intended order.
- Modify: `src/lib/i18n.ts` - maps built-in English category names to Chinese display names.
- Modify: `prisma/seed.ts` - adds default expense categories through the existing idempotent `upsert` loop.
- Keep: `package.json` and `package-lock.json` at `0.7.0`; the current local spec commit already bumped the feature version, so implementation should be amended into the same feature commit.

### Task 1: Add Failing i18n Mapping Coverage

**Files:**
- Modify: `tests/unit/i18n.test.ts`

- [ ] **Step 1: Extend the category display test**

In `tests/unit/i18n.test.ts`, replace the existing `maps built-in category names only at display time` test body with:

```ts
  it("maps built-in category names only at display time", () => {
    expect(getCategoryDisplayName("Groceries", "zh-CN")).toBe("买菜");
    expect(getCategoryDisplayName("Salary", "zh-CN")).toBe("工资");
    expect(getCategoryDisplayName("Childcare", "zh-CN")).toBe("育儿");
    expect(getCategoryDisplayName("Parent Care", "zh-CN")).toBe("孝心");
    expect(getCategoryDisplayName("Custom Family", "zh-CN")).toBe("Custom Family");
    expect(getCategoryDisplayName("Groceries", "en-US")).toBe("Groceries");
    expect(getCategoryDisplayName("Childcare", "en-US")).toBe("Childcare");
  });
```

- [ ] **Step 2: Run the focused unit test and verify RED**

Run:

```powershell
npm run test:unit -- tests/unit/i18n.test.ts
```

Expected: FAIL because `getCategoryDisplayName("Childcare", "zh-CN")` still returns `Childcare` instead of `育儿`.

### Task 2: Add Failing Seed Category Coverage

**Files:**
- Create: `tests/integration/seed-categories.test.ts`

- [ ] **Step 1: Create the seed category integration test**

Create `tests/integration/seed-categories.test.ts` with:

```ts
import { CategoryType } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";

describe("seed categories", () => {
  it("includes childcare and parent care as ordered expense categories", async () => {
    const categories = await db.category.findMany({
      where: {
        isActive: true,
        name: { in: ["Medical", "Childcare", "Parent Care", "Entertainment"] },
        type: CategoryType.EXPENSE,
      },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: { name: true, sortOrder: true },
    });

    expect(categories.map((category) => category.name)).toEqual([
      "Medical",
      "Childcare",
      "Parent Care",
      "Entertainment",
    ]);
  });
});
```

- [ ] **Step 2: Start the test database if needed**

Run:

```powershell
.\ops\podman\compose.ps1 -f podman-compose.dev.yml up -d db
```

Expected: PostgreSQL container is running and reachable through the configured `DATABASE_URL`.

- [ ] **Step 3: Apply migrations and seed current data**

Run:

```powershell
npx prisma migrate deploy
npm run prisma:seed
```

Expected: migrations finish with no pending migration errors, and seed exits with code 0.

- [ ] **Step 4: Run the seed category test and verify RED**

Run:

```powershell
npm run test:integration -- tests/integration/seed-categories.test.ts
```

Expected: FAIL because the current seed data has `Medical` and `Entertainment`, but not `Childcare` or `Parent Care`.

### Task 3: Implement the Minimal i18n Mapping

**Files:**
- Modify: `src/lib/i18n.ts`

- [ ] **Step 1: Add Chinese display names**

In `src/lib/i18n.ts`, update the `categoryDisplayNames["zh-CN"]` object so the relevant section reads:

```ts
  "zh-CN": {
    Bonus: "奖金",
    Childcare: "育儿",
    Dining: "餐饮",
    Entertainment: "娱乐",
    Groceries: "买菜",
    Home: "居家",
    Investment: "投资",
    Medical: "医疗",
    Other: "其他",
    "Parent Care": "孝心",
    Refund: "退款",
    Reimbursement: "报销",
    Salary: "工资",
    Social: "社交",
    Transport: "交通",
    Travel: "旅行",
    "Daily Use": "日用",
  },
```

- [ ] **Step 2: Run the focused unit test and verify GREEN**

Run:

```powershell
npm run test:unit -- tests/unit/i18n.test.ts
```

Expected: PASS for `tests/unit/i18n.test.ts`.

### Task 4: Implement the Minimal Seed Change

**Files:**
- Modify: `prisma/seed.ts`

- [ ] **Step 1: Add the two expense categories in the chosen order**

In `prisma/seed.ts`, update `expenseCategories` to:

```ts
const expenseCategories = [
  "Dining",
  "Groceries",
  "Transport",
  "Daily Use",
  "Home",
  "Medical",
  "Childcare",
  "Parent Care",
  "Entertainment",
  "Social",
  "Travel",
  "Other",
];
```

- [ ] **Step 2: Rerun seed so the database reflects the new defaults**

Run:

```powershell
npm run prisma:seed
```

Expected: seed exits with code 0 and upserts both new expense categories.

- [ ] **Step 3: Run the seed category test and verify GREEN**

Run:

```powershell
npm run test:integration -- tests/integration/seed-categories.test.ts
```

Expected: PASS, with category order `Medical`, `Childcare`, `Parent Care`, `Entertainment`.

### Task 5: Full Verification

**Files:**
- Test: `prisma/seed.ts`
- Test: `src/lib/i18n.ts`
- Test: `tests/unit/i18n.test.ts`
- Test: `tests/integration/seed-categories.test.ts`

- [ ] **Step 1: Run lint**

Run:

```powershell
npm run lint
```

Expected: PASS with zero ESLint warnings.

- [ ] **Step 2: Run the unit suite**

Run:

```powershell
npm run test:unit
```

Expected: PASS. This repository currently maps `test:unit` to `vitest run`, so database-backed tests may run if they are not filtered.

- [ ] **Step 3: Run the integration suite**

Run:

```powershell
npm run test:integration
```

Expected: PASS with the seeded PostgreSQL database available.

- [ ] **Step 4: Run the E2E suite**

Run:

```powershell
npm run test:e2e
```

Expected: PASS. Playwright starts or reuses `http://127.0.0.1:3000`.

### Task 6: Commit as One Feature Commit

**Files:**
- Modify: `prisma/seed.ts`
- Modify: `src/lib/i18n.ts`
- Modify: `tests/unit/i18n.test.ts`
- Create: `tests/integration/seed-categories.test.ts`
- Create: `docs/superpowers/plans/2026-04-30-add-expense-categories.md`
- Keep: `docs/superpowers/specs/2026-04-30-add-expense-categories-design.md`
- Keep: `package.json`
- Keep: `package-lock.json`

- [ ] **Step 1: Confirm version fields remain aligned**

Run:

```powershell
node -e "const fs=require('fs'); const p=JSON.parse(fs.readFileSync('package.json','utf8')); const l=JSON.parse(fs.readFileSync('package-lock.json','utf8')); console.log(p.version); console.log(l.version); console.log(l.packages[''].version);"
```

Expected output:

```text
0.7.0
0.7.0
0.7.0
```

- [ ] **Step 2: Check current branch difference from origin/master**

Run:

```powershell
git rev-list --left-right --count origin/master...HEAD
```

Expected before amend: `0	1`, because the local spec commit is already ahead of `origin/master`.

- [ ] **Step 3: Stage the complete feature**

Run:

```powershell
git add prisma/seed.ts src/lib/i18n.ts tests/unit/i18n.test.ts tests/integration/seed-categories.test.ts docs/superpowers/plans/2026-04-30-add-expense-categories.md docs/superpowers/specs/2026-04-30-add-expense-categories-design.md package.json package-lock.json
```

- [ ] **Step 4: Amend the existing local feature commit**

Run:

```powershell
git commit --amend -m "v0.7.0 添加育儿和孝心支出分类" -m "新增 Childcare 和 Parent Care 默认支出分类，补充中文显示映射、seed 覆盖测试和实现计划。"
```

Expected: one local feature commit remains ahead of `origin/master`, with version `0.7.0` and all design, plan, implementation, and tests included together.

- [ ] **Step 5: Confirm the final working tree is clean**

Run:

```powershell
git status --short
```

Expected: no output.
