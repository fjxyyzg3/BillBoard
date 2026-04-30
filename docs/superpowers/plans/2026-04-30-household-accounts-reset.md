# Household Accounts Reset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把默认家庭账号、中文个人视角文案和当前数据库账本状态调整为已确认的新家庭配置。

**Architecture:** 账号默认值仍由 `.env.example` 和 `prisma/seed.ts` 驱动，UI 文案仍集中在 `src/lib/i18n.ts`。数据库清理只触碰 `Transaction` 表，避免影响用户、家庭成员和分类基础数据。

**Tech Stack:** Next.js, Prisma, PostgreSQL, Vitest, ESLint.

---

### Task 1: 固化中文视角标签

**Files:**
- Modify: `tests/unit/i18n.test.ts`
- Modify: `src/lib/i18n.ts`

- [ ] **Step 1: Write the failing test**

在 `tests/unit/i18n.test.ts` 的 `returns UI messages for both supported locales` 测试中加入：

```ts
expect(getMessages("zh-CN").perspective.me).toBe("老公");
expect(getMessages("zh-CN").perspective.spouse).toBe("老婆");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- tests/unit/i18n.test.ts`

Expected: FAIL，显示当前中文文案仍为 `我` 和 `伴侣`。

- [ ] **Step 3: Write minimal implementation**

把 `src/lib/i18n.ts` 中 `messages["zh-CN"].perspective.me` 改为 `老公`，`spouse` 改为 `老婆`。

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- tests/unit/i18n.test.ts`

Expected: PASS。

### Task 2: 更新默认 seed 账号

**Files:**
- Modify: `.env.example`
- Modify: `prisma/seed.ts`
- Modify: `README.md`

- [ ] **Step 1: Update env defaults**

把 `.env.example` 更新为：

```env
SEED_USER_A_EMAIL=lehary@home.com
SEED_USER_A_PASSWORD=10212286
SEED_USER_A_NAME=老公
SEED_USER_B_EMAIL=noma@home.com
SEED_USER_B_PASSWORD=10212286
SEED_USER_B_NAME=老婆
```

- [ ] **Step 2: Update seed fallback names**

把 `prisma/seed.ts` 里的账号 A 默认名改为 `老公`，账号 B 默认名改为 `老婆`。

- [ ] **Step 3: Update README login section**

把 README 默认登录信息同步为两个账号和统一密码。

- [ ] **Step 4: Verify static checks**

Run: `npm run test:unit`

Expected: PASS。

Run: `npm run lint`

Expected: PASS。

### Task 3: 更新当前数据库并清空记账记录

**Files:**
- No source files.

- [ ] **Step 1: Apply seed**

Run: `npm run prisma:seed`

Expected: exit code `0`，两个默认账号可被 upsert。

- [ ] **Step 2: Delete transactions**

Run a Prisma one-off command that executes:

```ts
await prisma.transaction.deleteMany({});
```

Expected: command exits with code `0` and reports deleted count.

- [ ] **Step 3: Verify empty ledger**

Run a Prisma one-off count query:

```ts
await prisma.transaction.count();
```

Expected: `0`。
