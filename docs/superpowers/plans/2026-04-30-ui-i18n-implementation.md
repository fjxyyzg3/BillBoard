# UI i18n Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `BillBoard` 默认显示中文 UI，并支持当前浏览器内一键切换 `zh-CN` 与 `en-US`。

**Architecture:** 使用 cookie 作为唯一语言来源，服务端读取 cookie 后把 locale 和 messages 传入页面与组件；客户端 `LanguageToggle` 写 cookie 并刷新当前 route。业务数据、数据库分类名、权限、查询、URL 筛选参数保持不变，分类中文名只在展示层映射。

**Tech Stack:** Next.js App Router, React client/server components, TypeScript, Next cookies API, Vitest, Playwright, Prisma/PostgreSQL.

---

## File Structure

- Create `src/lib/i18n.ts`: 纯 TypeScript i18n 核心，包含 locale 类型、cookie 名、词典、分类显示映射、数字与日期 locale helper、action 错误文案映射。
- Create `src/lib/i18n-server.ts`: Next server-only helper，读取 `cookies()` 并返回当前 locale。
- Create `src/components/language-toggle.tsx`: client component，写语言 cookie 并 `router.refresh()`。
- Create `src/components/login-form.tsx`: client component，保留登录交互，把登录页 server component 化。
- Modify `src/app/layout.tsx`: 根据 cookie 设置 `<html lang>` 与 metadata。
- Modify `src/app/(auth)/login/page.tsx`: 读取 locale/messages，渲染语言切换与 `LoginForm`。
- Modify `src/components/app-shell.tsx`, `src/components/desktop-nav.tsx`, `src/components/bottom-nav.tsx`: 全局导航使用 messages 并放置切换按钮。
- Modify `src/components/time-range-selector.tsx`, `src/components/perspective-toggle.tsx`, `src/components/records-filter-bar.tsx`, `src/components/category-picker.tsx`: 筛选和分类控件使用 messages 与分类显示映射。
- Modify `src/components/transaction-form.tsx`, `src/components/transaction-editor-drawer.tsx`: 表单、编辑抽屉、隐藏 locale、按钮和错误显示使用 messages。
- Modify `src/components/summary-card.tsx`, `src/components/trend-chart.tsx`, `src/components/category-breakdown.tsx`, `src/components/recent-transactions.tsx`: 报表组件显示文案、日期和分类映射。
- Modify `src/app/(app)/home/page.tsx`, `src/app/(app)/add/page.tsx`, `src/app/(app)/records/page.tsx`: 页面读取 locale/messages 并传入组件，日期/数字格式按 locale 显示。
- Modify `src/app/(app)/add/actions.ts`, `src/app/(app)/records/actions.ts`: action 从隐藏 locale 读取 UI 错误语言，业务逻辑不变。
- Modify tests under `tests/unit`, `tests/integration`, `tests/e2e`: 默认中文断言、英文切换断言、i18n helper 单元测试。
- Modify `package.json`, `package-lock.json`: 实现提交前版本升到 `0.5.0`。

---

### Task 1: Core i18n Helpers

**Files:**
- Create: `src/lib/i18n.ts`
- Create: `src/lib/i18n-server.ts`
- Create: `tests/unit/i18n.test.ts`

- [ ] **Step 1: Write the failing unit test**

Create `tests/unit/i18n.test.ts` with this content:

```ts
import { describe, expect, it } from "vitest";
import {
  LOCALE_COOKIE_NAME,
  formatLocaleDateTime,
  formatLocaleNumber,
  getCategoryDisplayName,
  getMessages,
  getValidationMessage,
  parseLocale,
} from "@/lib/i18n";

describe("i18n helpers", () => {
  it("defaults unsupported locale values to Chinese", () => {
    expect(LOCALE_COOKIE_NAME).toBe("billboard-locale");
    expect(parseLocale(undefined)).toBe("zh-CN");
    expect(parseLocale("")).toBe("zh-CN");
    expect(parseLocale("fr-FR")).toBe("zh-CN");
    expect(parseLocale("en-US")).toBe("en-US");
  });

  it("returns UI messages for both supported locales", () => {
    expect(getMessages("zh-CN").nav.home).toBe("首页");
    expect(getMessages("zh-CN").login.submit).toBe("登录");
    expect(getMessages("en-US").nav.home).toBe("Home");
    expect(getMessages("en-US").login.submit).toBe("Log in");
  });

  it("maps built-in category names only at display time", () => {
    expect(getCategoryDisplayName("Groceries", "zh-CN")).toBe("买菜");
    expect(getCategoryDisplayName("Salary", "zh-CN")).toBe("工资");
    expect(getCategoryDisplayName("Custom Family", "zh-CN")).toBe("Custom Family");
    expect(getCategoryDisplayName("Groceries", "en-US")).toBe("Groceries");
  });

  it("formats numbers and dates with the selected locale", () => {
    expect(formatLocaleNumber(1234, "zh-CN")).toBe("1,234");
    expect(formatLocaleNumber(1234, "en-US")).toBe("1,234");
    expect(formatLocaleDateTime(new Date("2026-04-29T14:10:00.000Z"), "zh-CN")).toContain("4月29日");
    expect(formatLocaleDateTime(new Date("2026-04-29T14:10:00.000Z"), "en-US")).toContain("Apr");
  });

  it("maps known validation messages to the selected locale", () => {
    expect(getValidationMessage("Select a category", "zh-CN", "save")).toBe("请选择分类");
    expect(getValidationMessage("Select a category", "en-US", "save")).toBe("Select a category");
    expect(getValidationMessage("Database unavailable", "zh-CN", "save")).toBe("Database unavailable");
    expect(getValidationMessage(undefined, "zh-CN", "delete")).toBe("无法删除记录");
  });
});
```

- [ ] **Step 2: Run the new test and verify it fails**

Run:

```powershell
npx vitest run tests/unit/i18n.test.ts
```

Expected result: fail with an import error for `@/lib/i18n`.

- [ ] **Step 3: Add the i18n core implementation**

Create `src/lib/i18n.ts` with this content:

```ts
export const LOCALE_COOKIE_NAME = "billboard-locale";

export const supportedLocales = ["zh-CN", "en-US"] as const;
export type Locale = (typeof supportedLocales)[number];

export type ActionErrorKind = "save" | "update" | "delete";

const categoryDisplayNames = {
  "zh-CN": {
    Bonus: "奖金",
    Dining: "餐饮",
    Entertainment: "娱乐",
    Groceries: "买菜",
    Home: "居家",
    Investment: "投资",
    Medical: "医疗",
    Other: "其他",
    Refund: "退款",
    Reimbursement: "报销",
    Salary: "工资",
    Social: "社交",
    Transport: "交通",
    Travel: "旅行",
    "Daily Use": "日用",
  },
  "en-US": {},
} as const;

export const messages = {
  "zh-CN": {
    metadata: {
      title: "家庭记账",
      description: "快速记录两人家庭收支。",
    },
    app: {
      brand: "BillBoard",
      tagline: "家庭记账",
    },
    language: {
      switchLanguage: "切换语言",
      target: "EN",
    },
    nav: {
      home: "首页",
      add: "记一笔",
      records: "记录",
    },
    common: {
      addAnother: "再记一笔",
      allCategories: "全部分类",
      allTypes: "全部类型",
      amount: "金额",
      actor: "记账人",
      category: "分类",
      close: "关闭",
      createdBy: "创建人",
      expense: "支出",
      income: "收入",
      noNote: "无备注",
      note: "备注",
      optional: "可选",
      returnHome: "返回首页",
      saving: "保存中...",
      type: "类型",
      view: "查看",
      when: "时间",
      who: "成员",
      tx: "笔",
    },
    range: {
      label: "范围",
      thisMonth: "本月",
      last7Days: "最近 7 天",
      last30Days: "最近 30 天",
      last12Months: "最近 12 个月",
    },
    perspective: {
      household: "家庭",
      me: "我",
      spouse: "伴侣",
    },
    login: {
      eyebrow: "BillBoard",
      title: "家庭记账",
      description: "登录你的家庭共享账本。",
      email: "邮箱",
      password: "密码",
      submit: "登录",
      invalidCredentials: "邮箱或密码不正确",
    },
    home: {
      eyebrow: "家庭概览",
      title: "首页",
      description: "按选择的时间范围和成员视角即时查看家庭收支。",
      addTransaction: "记一笔",
      transactionCount: (count: number) => `${count} 笔记录`,
      summary: {
        incomeTitle: "收入",
        incomeDetail: "查看当前视图的收入记录",
        expenseTitle: "支出",
        expenseDetail: "查看当前视图的支出记录",
        netTitle: "结余",
        netDetail: "收入减支出的净额",
        transactionsTitle: "记录",
        transactionsDetail: "打开当前筛选下的记录列表",
      },
    },
    trend: {
      title: "趋势",
      empty: "当前筛选下还没有记录。",
      daily: "每日收入和支出合计。",
      monthly: "每月收入和支出合计。",
      income: "收入",
      expense: "支出",
    },
    categories: {
      title: "支出分类",
      description: "当前范围内支出集中在哪里。",
      empty: "当前筛选下还没有支出记录。",
      transactionCount: (count: number) => `${count} 笔记录`,
    },
    recent: {
      title: "近期记录",
      description: "直接查看影响当前视图的记录。",
      empty: "当前筛选下还没有记录。",
    },
    add: {
      eyebrow: "快速记录",
      title: "记一笔",
      description: "快速记录家庭收入和支出，不离开当前应用。",
      successMessage: "记录已保存",
      successDetail: (typeLabel: string, amount: string) => `${typeLabel}：${amount}`,
      save: "保存记录",
    },
    records: {
      eyebrow: "历史",
      title: "记录",
      description: "快速筛选、查看并修改家庭历史记录。",
      empty: "当前筛选下没有记录。试试扩大时间范围或清除筛选。",
    },
    editor: {
      title: "编辑记录",
      createdBy: (date: string, member: string) => `${date} · 创建人 ${member}`,
      saveChanges: "保存修改",
      deleteRecord: "删除记录",
      deleting: "删除中...",
      deleteConfirm: "删除这条记录？",
    },
    actions: {
      couldNotSave: "无法保存记录",
      couldNotUpdate: "无法更新记录",
      couldNotDelete: "无法删除记录",
      validation: {
        "Select income or expense": "请选择收入或支出",
        "Enter a valid amount": "请输入有效金额",
        "Amount must be greater than 0": "金额必须大于 0",
        "Select a category": "请选择分类",
        "Select who made the transaction": "请选择成员",
        "Choose when the transaction happened": "请选择记录发生时间",
        "Choose a valid date and time": "请选择有效日期和时间",
      },
    },
  },
  "en-US": {
    metadata: {
      title: "Household Accounting",
      description: "Fast two-person household accounting.",
    },
    app: {
      brand: "BillBoard",
      tagline: "Household accounting",
    },
    language: {
      switchLanguage: "Switch language",
      target: "中文",
    },
    nav: {
      home: "Home",
      add: "Add",
      records: "Records",
    },
    common: {
      addAnother: "Add another",
      allCategories: "All categories",
      allTypes: "All types",
      amount: "Amount",
      actor: "Actor",
      category: "Category",
      close: "Close",
      createdBy: "Created by",
      expense: "Expense",
      income: "Income",
      noNote: "No note",
      note: "Note",
      optional: "Optional",
      returnHome: "Return home",
      saving: "Saving...",
      type: "Type",
      view: "View",
      when: "When",
      who: "Who",
      tx: "tx",
    },
    range: {
      label: "Range",
      thisMonth: "This Month",
      last7Days: "Last 7 Days",
      last30Days: "Last 30 Days",
      last12Months: "Last 12 Months",
    },
    perspective: {
      household: "Household",
      me: "Me",
      spouse: "Spouse",
    },
    login: {
      eyebrow: "BillBoard",
      title: "Household Accounting",
      description: "Sign in to your shared household ledger.",
      email: "Email",
      password: "Password",
      submit: "Log in",
      invalidCredentials: "Invalid email or password",
    },
    home: {
      eyebrow: "Household overview",
      title: "Home",
      description: "Household reporting updates instantly with the selected range and perspective.",
      addTransaction: "Add transaction",
      transactionCount: (count: number) => `${count} transaction${count === 1 ? "" : "s"} in view`,
      summary: {
        incomeTitle: "Income",
        incomeDetail: "Review income records for this view",
        expenseTitle: "Expense",
        expenseDetail: "Review expense records for this view",
        netTitle: "Net",
        netDetail: "Net across income and expenses",
        transactionsTitle: "Transactions",
        transactionsDetail: "Open the records list with these filters",
      },
    },
    trend: {
      title: "Trend",
      empty: "No activity yet for the selected filters.",
      daily: "Daily income and expense totals.",
      monthly: "Monthly income and expense totals.",
      income: "Income",
      expense: "Expense",
    },
    categories: {
      title: "Expense categories",
      description: "Where spending is concentrated in this range.",
      empty: "No expense activity yet for the selected filters.",
      transactionCount: (count: number) => `${count} transaction${count === 1 ? "" : "s"}`,
    },
    recent: {
      title: "Recent transactions",
      description: "Jump straight into the records that shaped this view.",
      empty: "No transactions yet for the selected filters.",
    },
    add: {
      eyebrow: "Quick entry",
      title: "Add transaction",
      description: "Capture household income and expenses without leaving the app shell.",
      successMessage: "Transaction saved",
      successDetail: (typeLabel: string, amount: string) => `${typeLabel}: ${amount}`,
      save: "Save transaction",
    },
    records: {
      eyebrow: "History",
      title: "Records",
      description: "Review household history, filter it quickly, and adjust records in place.",
      empty: "No records match the current filters. Try a wider range or clear a filter.",
    },
    editor: {
      title: "Edit record",
      createdBy: (date: string, member: string) => `${date} • created by ${member}`,
      saveChanges: "Save changes",
      deleteRecord: "Delete record",
      deleting: "Deleting...",
      deleteConfirm: "Delete this record?",
    },
    actions: {
      couldNotSave: "Could not save the transaction",
      couldNotUpdate: "Could not update the record",
      couldNotDelete: "Could not delete the record",
      validation: {},
    },
  },
} as const;

export type Messages = (typeof messages)[Locale];

export function parseLocale(value: unknown): Locale {
  return value === "en-US" ? "en-US" : "zh-CN";
}

export function getMessages(locale: Locale) {
  return messages[locale];
}

export function getCategoryDisplayName(categoryName: string, locale: Locale) {
  const displayNames = categoryDisplayNames[locale] as Partial<Record<string, string>>;

  return displayNames[categoryName] ?? categoryName;
}

export function formatLocaleNumber(value: number, locale: Locale) {
  return new Intl.NumberFormat(locale).format(value);
}

export function formatLocaleDateTime(date: Date, locale: Locale) {
  return new Intl.DateTimeFormat(locale, {
    timeZone: "Asia/Shanghai",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function getValidationMessage(
  message: string | undefined,
  locale: Locale,
  kind: ActionErrorKind,
) {
  const actionMessages = messages[locale].actions;

  if (!message) {
    return kind === "delete"
      ? actionMessages.couldNotDelete
      : kind === "update"
        ? actionMessages.couldNotUpdate
        : actionMessages.couldNotSave;
  }

  if (locale === "zh-CN") {
    const validationMessages = actionMessages.validation as Partial<Record<string, string>>;

    return validationMessages[message] ?? message;
  }

  return message;
}
```

Create `src/lib/i18n-server.ts` with this content:

```ts
import { cookies } from "next/headers";
import { LOCALE_COOKIE_NAME, parseLocale } from "@/lib/i18n";

export async function getServerLocale() {
  const cookieStore = await cookies();

  return parseLocale(cookieStore.get(LOCALE_COOKIE_NAME)?.value);
}
```

- [ ] **Step 4: Run the i18n unit test and verify it passes**

Run:

```powershell
npx vitest run tests/unit/i18n.test.ts
```

Expected result: pass.

---

### Task 2: Language Toggle And Root Locale

**Files:**
- Create: `src/components/language-toggle.tsx`
- Modify: `src/app/layout.tsx`

- [ ] **Step 1: Create the language toggle component**

Create `src/components/language-toggle.tsx` with this content:

```tsx
"use client";

import { Languages } from "lucide-react";
import { useRouter } from "next/navigation";
import { LOCALE_COOKIE_NAME, type Locale } from "@/lib/i18n";

type LanguageToggleProps = {
  labels: {
    switchLanguage: string;
    target: string;
  };
  locale: Locale;
};

const cookieMaxAgeSeconds = 60 * 60 * 24 * 365;

export function LanguageToggle({ labels, locale }: LanguageToggleProps) {
  const router = useRouter();
  const nextLocale: Locale = locale === "zh-CN" ? "en-US" : "zh-CN";

  return (
    <button
      aria-label={labels.switchLanguage}
      className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-full border border-black/[0.08] bg-white/80 px-3 text-xs font-semibold text-stone-700 shadow-sm transition hover:bg-white hover:text-stone-950"
      onClick={() => {
        document.cookie = `${LOCALE_COOKIE_NAME}=${encodeURIComponent(nextLocale)}; Path=/; Max-Age=${cookieMaxAgeSeconds}; SameSite=Lax`;
        router.refresh();
      }}
      type="button"
    >
      <Languages aria-hidden="true" className="h-3.5 w-3.5" strokeWidth={2.2} />
      <span>{labels.target}</span>
    </button>
  );
}
```

- [ ] **Step 2: Make the root layout locale-aware**

Replace `src/app/layout.tsx` with this content:

```tsx
import type { Metadata } from "next";
import { getMessages } from "@/lib/i18n";
import { getServerLocale } from "@/lib/i18n-server";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getServerLocale();
  const messages = getMessages(locale);

  return {
    title: messages.metadata.title,
    description: messages.metadata.description,
  };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getServerLocale();

  return (
    <html lang={locale}>
      <body className="min-h-screen bg-[var(--ios-bg)] text-[var(--ios-text)] antialiased">{children}</body>
    </html>
  );
}
```

- [ ] **Step 3: Run lint for the new imports and client component**

Run:

```powershell
npm run lint
```

Expected result: pass.

---

### Task 3: Localized App Shell Navigation

**Files:**
- Modify: `src/components/app-shell.tsx`
- Modify: `src/components/desktop-nav.tsx`
- Modify: `src/components/bottom-nav.tsx`
- Modify: `tests/unit/navigation-version-marker.test.tsx`

- [ ] **Step 1: Update the navigation unit test first**

Replace `tests/unit/navigation-version-marker.test.tsx` with this content:

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BottomNav } from "@/components/bottom-nav";
import { DesktopNav } from "@/components/desktop-nav";
import { getMessages } from "@/lib/i18n";

vi.mock("next/navigation", () => ({
  usePathname: () => "/home",
  useRouter: () => ({
    refresh: () => undefined,
  }),
}));

vi.mock("@/components/app-filters-provider", () => ({
  useAppFilters: () => ({
    buildHref: (pathname: string) => pathname,
    navigateTo: () => undefined,
  }),
}));

describe("navigation version markers", () => {
  it("renders localized labels and the version marker in desktop and mobile navigation", () => {
    const messages = getMessages("zh-CN");
    const desktopMarkup = renderToStaticMarkup(
      <DesktopNav labels={{ app: messages.app, language: messages.language, nav: messages.nav }} locale="zh-CN" versionLabel="v0.1.0" />,
    );
    const mobileMarkup = renderToStaticMarkup(
      <BottomNav labels={{ language: messages.language, nav: messages.nav }} locale="zh-CN" versionLabel="v0.1.0" />,
    );

    expect(desktopMarkup).toContain("v0.1.0");
    expect(desktopMarkup).toContain("首页");
    expect(desktopMarkup).toContain("家庭记账");
    expect(mobileMarkup).toContain("v0.1.0");
    expect(mobileMarkup).toContain("记录");
  });
});
```

- [ ] **Step 2: Run the navigation unit test and verify it fails**

Run:

```powershell
npx vitest run tests/unit/navigation-version-marker.test.tsx
```

Expected result: fail because `DesktopNav` and `BottomNav` do not accept localized props yet.

- [ ] **Step 3: Make `AppShell` read locale and pass localized nav props**

Replace `src/components/app-shell.tsx` with this content:

```tsx
import type { ReactNode } from "react";
import packageJson from "../../package.json";
import { AppFiltersProvider } from "@/components/app-filters-provider";
import { BottomNav } from "@/components/bottom-nav";
import { DesktopNav } from "@/components/desktop-nav";
import { formatAppVersion } from "@/lib/app-version";
import { getMessages } from "@/lib/i18n";
import { getServerLocale } from "@/lib/i18n-server";

type AppShellProps = {
  children: ReactNode;
};

export async function AppShell({ children }: AppShellProps) {
  const locale = await getServerLocale();
  const messages = getMessages(locale);
  const versionLabel = formatAppVersion(packageJson.version);

  return (
    <AppFiltersProvider>
      <div className="mx-auto flex min-h-screen w-full max-w-7xl bg-[var(--ios-bg)] md:flex-row">
        <DesktopNav
          labels={{ app: messages.app, language: messages.language, nav: messages.nav }}
          locale={locale}
          versionLabel={versionLabel}
        />
        <div className="flex min-h-screen min-w-0 flex-1 flex-col">
          <main className="min-w-0 flex-1 px-4 pb-[calc(7rem+env(safe-area-inset-bottom))] pt-5 sm:px-6 md:px-8 md:py-8">
            {children}
          </main>
          <BottomNav
            labels={{ language: messages.language, nav: messages.nav }}
            locale={locale}
            versionLabel={versionLabel}
          />
        </div>
      </div>
    </AppFiltersProvider>
  );
}
```

- [ ] **Step 4: Update `DesktopNav`**

Replace `src/components/desktop-nav.tsx` with this content:

```tsx
"use client";

import { Home, List, PlusCircle, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LanguageToggle } from "@/components/language-toggle";
import { useAppFilters } from "@/components/app-filters-provider";
import type { Locale, Messages } from "@/lib/i18n";

type DesktopNavProps = {
  labels: {
    app: Messages["app"];
    language: Messages["language"];
    nav: Messages["nav"];
  };
  locale: Locale;
  versionLabel: string;
};

type NavItem = {
  href: "/home" | "/add" | "/records";
  label: string;
  Icon: LucideIcon;
};

export function DesktopNav({ labels, locale, versionLabel }: DesktopNavProps) {
  const pathname = usePathname();
  const { buildHref, navigateTo } = useAppFilters();
  const items: NavItem[] = [
    { href: "/home", label: labels.nav.home, Icon: Home },
    { href: "/add", label: labels.nav.add, Icon: PlusCircle },
    { href: "/records", label: labels.nav.records, Icon: List },
  ];

  return (
    <aside className="sticky top-0 hidden h-screen w-64 shrink-0 border-r border-black/[0.08] bg-white/70 backdrop-blur-xl md:flex md:flex-col">
      <div className="border-b border-black/[0.06] px-6 py-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-base font-semibold text-stone-900">{labels.app.brand}</p>
            <p className="mt-1 text-xs text-stone-500">{labels.app.tagline}</p>
          </div>
          <LanguageToggle labels={labels.language} locale={locale} />
        </div>
      </div>
      <nav className="flex-1 space-y-1 px-4 py-5">
        {items.map((item) => {
          const isActive = pathname === item.href;
          const Icon = item.Icon;

          return (
            <Link
              key={item.href}
              aria-current={isActive ? "page" : undefined}
              className={`flex items-center gap-3 rounded-2xl px-4 py-3 text-sm font-medium transition ${
                isActive
                  ? "bg-[var(--ios-blue-soft)] text-[var(--ios-blue)]"
                  : "text-stone-600 hover:bg-black/[0.04] hover:text-stone-900"
              }`}
              href={buildHref(item.href)}
              onClick={(event) => {
                if (
                  event.button !== 0 ||
                  event.altKey ||
                  event.ctrlKey ||
                  event.metaKey ||
                  event.shiftKey
                ) {
                  return;
                }

                event.preventDefault();
                navigateTo(item.href);
              }}
            >
              <Icon aria-hidden="true" className="h-5 w-5" strokeWidth={2.2} />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>
      <p className="px-6 pb-6 text-xs text-stone-400">{versionLabel}</p>
    </aside>
  );
}
```

- [ ] **Step 5: Update `BottomNav`**

Replace `src/components/bottom-nav.tsx` with this content:

```tsx
"use client";

import { Home, List, PlusCircle, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LanguageToggle } from "@/components/language-toggle";
import { useAppFilters } from "@/components/app-filters-provider";
import type { Locale, Messages } from "@/lib/i18n";

type BottomNavProps = {
  labels: {
    language: Messages["language"];
    nav: Messages["nav"];
  };
  locale: Locale;
  versionLabel: string;
};

type NavItem = {
  href: "/home" | "/add" | "/records";
  label: string;
  Icon: LucideIcon;
};

export function BottomNav({ labels, locale, versionLabel }: BottomNavProps) {
  const pathname = usePathname();
  const { buildHref, navigateTo } = useAppFilters();
  const items: NavItem[] = [
    { href: "/home", label: labels.nav.home, Icon: Home },
    { href: "/add", label: labels.nav.add, Icon: PlusCircle },
    { href: "/records", label: labels.nav.records, Icon: List },
  ];

  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-black/[0.08] bg-white/90 pb-[env(safe-area-inset-bottom)] shadow-[0_-10px_30px_rgba(0,0,0,0.06)] backdrop-blur-xl md:hidden">
      <div className="flex items-center justify-between gap-3 border-b border-black/[0.06] px-4 py-1.5">
        <p className="text-[0.625rem] leading-none text-stone-400">{versionLabel}</p>
        <LanguageToggle labels={labels.language} locale={locale} />
      </div>
      <ul className="mx-auto grid max-w-7xl grid-cols-3 px-3 py-2">
        {items.map((item) => {
          const isActive = pathname === item.href;
          const Icon = item.Icon;

          return (
            <li key={item.href}>
              <Link
                aria-current={isActive ? "page" : undefined}
                className={`flex min-h-14 flex-col items-center justify-center gap-1 rounded-2xl px-3 py-2 text-xs font-medium transition ${
                  isActive
                    ? "bg-[var(--ios-blue-soft)] text-[var(--ios-blue)]"
                    : "text-stone-500 hover:bg-black/[0.04] hover:text-stone-800"
                }`}
                href={buildHref(item.href)}
                onClick={(event) => {
                  if (
                    event.button !== 0 ||
                    event.altKey ||
                    event.ctrlKey ||
                    event.metaKey ||
                    event.shiftKey
                  ) {
                    return;
                  }

                  event.preventDefault();
                  navigateTo(item.href);
                }}
              >
                <Icon aria-hidden="true" className="h-5 w-5" strokeWidth={2.2} />
                <span>{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
```

- [ ] **Step 6: Run the navigation unit test and lint**

Run:

```powershell
npx vitest run tests/unit/navigation-version-marker.test.tsx
npm run lint
```

Expected result: both pass.

---

### Task 4: Localized Login Page

**Files:**
- Create: `src/components/login-form.tsx`
- Modify: `src/app/(auth)/login/page.tsx`
- Modify: `tests/e2e/app-smoke.spec.ts`

- [ ] **Step 1: Update the smoke e2e assertion first**

Replace `tests/e2e/app-smoke.spec.ts` with this content:

```ts
import { expect, test } from "@playwright/test";

test("guests land on the default Chinese login screen", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { name: "家庭记账" })).toBeVisible();
  await expect(page.getByRole("button", { name: "切换语言" })).toBeVisible();
});

test("guests can switch the login screen to English", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("button", { name: "切换语言" }).click();

  await expect(page.getByRole("heading", { name: "Household Accounting" })).toBeVisible();
  await expect(page.getByLabel("Email")).toBeVisible();

  await page.reload();
  await expect(page.getByRole("heading", { name: "Household Accounting" })).toBeVisible();
});
```

- [ ] **Step 2: Run the smoke e2e file and verify it fails**

Run:

```powershell
npm run test:e2e -- tests/e2e/app-smoke.spec.ts
```

Expected result: fail because login UI is still hard-coded in English.

- [ ] **Step 3: Move login form behavior into a client component**

Create `src/components/login-form.tsx` with this content:

```tsx
"use client";

import { signIn } from "next-auth/react";
import { useState } from "react";
import type { Messages } from "@/lib/i18n";

type LoginFormProps = {
  labels: Messages["login"];
};

export function LoginForm({ labels }: LoginFormProps) {
  const [error, setError] = useState("");

  return (
    <form
      className="ios-panel space-y-4 p-5"
      onSubmit={async (event) => {
        event.preventDefault();
        setError("");

        const formData = new FormData(event.currentTarget);
        const result = await signIn("credentials", {
          email: formData.get("email"),
          password: formData.get("password"),
          redirect: false,
        });

        if (result?.error) {
          setError(labels.invalidCredentials);
          return;
        }

        window.location.href = "/home";
      }}
    >
      <label className="block space-y-2">
        <span className="text-sm font-medium text-[var(--ios-text)]">{labels.email}</span>
        <input className="ios-field w-full" name="email" required type="email" />
      </label>
      <label className="block space-y-2">
        <span className="text-sm font-medium text-[var(--ios-text)]">{labels.password}</span>
        <input className="ios-field w-full" name="password" required type="password" />
      </label>
      {error ? <p className="text-sm text-[var(--ios-red)]">{error}</p> : null}
      <button
        className="w-full rounded-2xl bg-[var(--ios-blue)] px-4 py-3 text-sm font-semibold text-white shadow-[0_10px_24px_rgba(0,122,255,0.22)] transition hover:bg-[#006ee6]"
        type="submit"
      >
        {labels.submit}
      </button>
    </form>
  );
}
```

- [ ] **Step 4: Convert login page to a server component that reads locale**

Replace `src/app/(auth)/login/page.tsx` with this content:

```tsx
import { LanguageToggle } from "@/components/language-toggle";
import { LoginForm } from "@/components/login-form";
import { getMessages } from "@/lib/i18n";
import { getServerLocale } from "@/lib/i18n-server";

export default async function LoginPage() {
  const locale = await getServerLocale();
  const messages = getMessages(locale);

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-5 py-10">
      <header className="mb-8 space-y-2">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-2">
            <p className="text-sm font-medium text-[var(--ios-muted)]">{messages.login.eyebrow}</p>
            <h1 className="text-3xl font-semibold tracking-normal text-[var(--ios-text)]">
              {messages.login.title}
            </h1>
          </div>
          <LanguageToggle labels={messages.language} locale={locale} />
        </div>
        <p className="text-sm text-[var(--ios-muted)]">{messages.login.description}</p>
      </header>
      <LoginForm labels={messages.login} />
    </main>
  );
}
```

- [ ] **Step 5: Run the smoke e2e file**

Run:

```powershell
npm run test:e2e -- tests/e2e/app-smoke.spec.ts
```

Expected result: pass.

---

### Task 5: Localized Shared Controls And Forms

**Files:**
- Modify: `src/components/time-range-selector.tsx`
- Modify: `src/components/perspective-toggle.tsx`
- Modify: `src/components/records-filter-bar.tsx`
- Modify: `src/components/category-picker.tsx`
- Modify: `src/components/transaction-form.tsx`
- Modify: `src/components/transaction-editor-drawer.tsx`
- Modify: `src/app/(app)/add/actions.ts`
- Modify: `src/app/(app)/records/actions.ts`

- [ ] **Step 1: Update selector components to receive labels**

Replace `src/components/time-range-selector.tsx` with this content:

```tsx
"use client";

import { useAppFilters } from "@/components/app-filters-provider";
import { IosSelect } from "@/components/ios-select";
import type { Messages } from "@/lib/i18n";
import type { RangePreset } from "@/lib/time-range";

type TimeRangeSelectorProps = {
  labels: Messages["range"];
};

export function TimeRangeSelector({ labels }: TimeRangeSelectorProps) {
  const { rangePreset, setRangePreset } = useAppFilters();
  const options: Array<{ value: RangePreset; label: string }> = [
    { value: "this-month", label: labels.thisMonth },
    { value: "last-7-days", label: labels.last7Days },
    { value: "last-30-days", label: labels.last30Days },
    { value: "last-12-months", label: labels.last12Months },
  ];

  return (
    <label className="flex min-w-0 items-center gap-2 text-sm text-[var(--ios-muted)]">
      <span className="shrink-0 font-medium">{labels.label}</span>
      <IosSelect
        onChange={(event) => {
          setRangePreset(event.target.value as RangePreset);
        }}
        options={options}
        value={rangePreset}
        variant="pill"
      />
    </label>
  );
}
```

Replace `src/components/perspective-toggle.tsx` with this content:

```tsx
"use client";

import { useAppFilters } from "@/components/app-filters-provider";
import type { Messages } from "@/lib/i18n";
import type { Perspective } from "@/lib/perspective";

type PerspectiveToggleProps = {
  labels: Messages["perspective"];
};

export function PerspectiveToggle({ labels }: PerspectiveToggleProps) {
  const { perspective, setPerspective } = useAppFilters();
  const items: Array<{ value: Perspective; label: string }> = [
    { value: "household", label: labels.household },
    { value: "me", label: labels.me },
    { value: "spouse", label: labels.spouse },
  ];

  return (
    <div className="inline-grid max-w-full grid-cols-3 rounded-full bg-[#e8e8ed] p-1 text-sm text-[var(--ios-muted)]">
      {items.map((item) => {
        const isActive = perspective === item.value;

        return (
          <button
            aria-pressed={isActive}
            className={`min-h-10 rounded-full px-4 text-center font-medium transition ${
              isActive
                ? "bg-white text-[var(--ios-text)] shadow-[0_1px_4px_rgba(0,0,0,0.14)]"
                : "hover:text-[var(--ios-text)]"
            }`}
            key={item.value}
            onClick={() => {
              setPerspective(item.value);
            }}
            type="button"
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Update records filter and category picker**

In `src/components/records-filter-bar.tsx`, add `locale` and `labels` props, import `getCategoryDisplayName`, and use this category options block:

```tsx
type RecordsFilterBarProps = {
  categories: CategoryOption[];
  labels: {
    common: Messages["common"];
  };
  locale: Locale;
};

export function RecordsFilterBar({ categories, labels, locale }: RecordsFilterBarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const selectedType = parseType(searchParams.get("type"));
  const selectedCategoryId = searchParams.get("category") ?? "";
  const visibleCategories = categories.filter(
    (category) => !selectedType || category.type === selectedType,
  );
  const categoryOptions = [
    { value: "", label: labels.common.allCategories },
    ...visibleCategories.map((category) => ({
      value: category.id,
      label: getCategoryDisplayName(category.name, locale),
    })),
  ];
```

Use these labels in the JSX:

```tsx
<span className="text-sm font-medium text-[var(--ios-muted)]">{labels.common.type}</span>
options={[
  { value: "", label: labels.common.allTypes },
  { value: "expense", label: labels.common.expense },
  { value: "income", label: labels.common.income },
]}
<span className="text-sm font-medium text-[var(--ios-muted)]">{labels.common.category}</span>
```

In `src/components/category-picker.tsx`, add imports and props:

```tsx
import { getCategoryDisplayName, type Locale, type Messages } from "@/lib/i18n";

type CategoryPickerProps = {
  categories: TransactionCategory[];
  selectedType: TransactionCategory["type"];
  selectedCategoryId: string;
  onSelect: (categoryId: string) => void;
  label: Messages["common"]["category"];
  locale: Locale;
};
```

Use `label` and mapped names:

```tsx
<span className="text-sm font-medium text-stone-700">{label}</span>
...
{getCategoryDisplayName(category.name, locale)}
```

- [ ] **Step 3: Update transaction form props and hidden locale**

In `src/components/transaction-form.tsx`, import `Locale` and `Messages`, then extend props:

```tsx
  labels: {
    add: Messages["add"];
    common: Messages["common"];
  };
  locale: Locale;
```

Add hidden locale inside the form:

```tsx
<input name="locale" type="hidden" value={locale} />
```

Replace hard-coded text with these labels:

```tsx
{labels.common.type}
{type === "expense" ? labels.common.expense : labels.common.income}
{labels.common.amount}
<CategoryPicker
  categories={categories}
  label={labels.common.category}
  locale={locale}
  onSelect={setSelectedCategoryId}
  selectedCategoryId={selectedCategoryId}
  selectedType={selectedType}
/>
{labels.common.who}
{labels.common.when}
{labels.common.note}
placeholder={labels.common.optional}
{labels.common.addAnother}
{labels.common.returnHome}
{isPending ? labels.common.saving : labels.add.save}
```

- [ ] **Step 4: Update editor drawer props and hidden locale**

In `src/components/transaction-editor-drawer.tsx`, import `Locale` and `Messages`, then extend props:

```tsx
  labels: {
    common: Messages["common"];
    editor: Messages["editor"];
  };
  locale: Locale;
```

Use these replacements:

```tsx
<h2 className="text-xl font-semibold text-[var(--ios-text)]">{labels.editor.title}</h2>
<p className="text-sm text-[var(--ios-muted)]">
  {labels.editor.createdBy(record.occurredAtLabel, record.createdByMemberName)}
</p>
...
{labels.common.close}
...
<input name="locale" type="hidden" value={locale} />
...
{labels.common.type}
{type === "expense" ? labels.common.expense : labels.common.income}
{labels.common.amount}
{labels.common.category}
{labels.common.who}
{labels.common.when}
{labels.common.note}
placeholder={labels.common.optional}
{isUpdating ? labels.common.saving : labels.editor.saveChanges}
...
if (!window.confirm(labels.editor.deleteConfirm)) {
...
{isDeleting ? labels.editor.deleting : labels.editor.deleteRecord}
```

Map category options with:

```tsx
const categoryOptions = visibleCategories.map((category) => ({
  value: category.id,
  label: getCategoryDisplayName(category.name, locale),
}));
```

- [ ] **Step 5: Localize action fallback and validation messages**

In `src/app/(app)/add/actions.ts`, import i18n helpers:

```ts
import { getMessages, getValidationMessage, parseLocale } from "@/lib/i18n";
```

Inside `submitTransaction`, before the `try`, add:

```ts
const locale = parseLocale(String(formData.get("locale") ?? ""));
const messages = getMessages(locale);
```

Replace Zod and fallback returns with:

```ts
if (error instanceof ZodError) {
  return {
    status: "error",
    message: getValidationMessage(error.issues[0]?.message, locale, "save"),
  };
}

return {
  status: "error",
  message: error instanceof Error ? getValidationMessage(error.message, locale, "save") : messages.actions.couldNotSave,
};
```

In `src/app/(app)/records/actions.ts`, import the same helpers, add `locale` and `messages` at the top of both `submitRecordUpdate` and `submitRecordDelete`, and use:

```ts
message: getValidationMessage(error.issues[0]?.message, locale, "update")
```

```ts
message: error instanceof Error ? getValidationMessage(error.message, locale, "update") : messages.actions.couldNotUpdate
```

```ts
message: error instanceof Error ? getValidationMessage(error.message, locale, "delete") : messages.actions.couldNotDelete
```

- [ ] **Step 6: Run focused checks**

Run:

```powershell
npm run lint
npx vitest run tests/integration/transaction-datetime-and-action.test.ts tests/integration/records-page-and-actions.test.ts
```

Expected result: both commands pass.

---

### Task 6: Localized Dashboard And Records Display

**Files:**
- Modify: `src/components/summary-card.tsx`
- Modify: `src/components/trend-chart.tsx`
- Modify: `src/components/category-breakdown.tsx`
- Modify: `src/components/recent-transactions.tsx`
- Modify: `src/app/(app)/home/page.tsx`
- Modify: `src/app/(app)/add/page.tsx`
- Modify: `src/app/(app)/records/page.tsx`

- [ ] **Step 1: Update display components to accept localized labels**

In `src/components/summary-card.tsx`, add `viewLabel` and use it:

```tsx
type SummaryCardProps = {
  detail: string;
  href?: string;
  title: string;
  tone?: "income" | "expense" | "neutral";
  value: string;
  viewLabel: string;
};
...
{href ? <span className="shrink-0 text-sm text-stone-400">{viewLabel}</span> : null}
```

In `src/components/trend-chart.tsx`, add:

```tsx
import type { Messages } from "@/lib/i18n";

type TrendChartProps = {
  getPointHref?: (point: ReportTrendPoint) => string | undefined;
  granularity: "day" | "month";
  labels: Messages["trend"] & { tx: string };
  points: ReportTrendPoint[];
};
```

Replace title, empty text, legend, subtitle, and `tx`:

```tsx
{labels.title}
{labels.empty}
{granularity === "month" ? labels.monthly : labels.daily}
{labels.income}
{labels.expense}
{point.transactionCount} {labels.tx}
```

In `src/components/category-breakdown.tsx`, add `labels` and `locale`, map category names:

```tsx
import { getCategoryDisplayName, type Locale, type Messages } from "@/lib/i18n";
...
labels: Messages["categories"];
locale: Locale;
...
<h2 className="text-lg font-semibold text-stone-900">{labels.title}</h2>
<p className="text-sm text-stone-500">{labels.description}</p>
...
<p className="mt-5 text-sm text-stone-500">{labels.empty}</p>
...
<p className="text-sm font-medium text-stone-900">{getCategoryDisplayName(item.categoryName, locale)}</p>
<p className="text-xs text-stone-500">{labels.transactionCount(item.transactionCount)}</p>
```

In `src/components/recent-transactions.tsx`, add `labels` and `locale`, use `formatLocaleDateTime`, `getCategoryDisplayName`, and localized labels:

```tsx
import { formatLocaleDateTime, getCategoryDisplayName, type Locale, type Messages } from "@/lib/i18n";
...
labels: {
  common: Messages["common"];
  recent: Messages["recent"];
};
locale: Locale;
...
return labels.common.noNote;
...
<h2 className="text-lg font-semibold text-stone-900">{labels.recent.title}</h2>
<p className="text-sm text-stone-500">{labels.recent.description}</p>
...
<p className="text-sm text-stone-500">{labels.recent.empty}</p>
...
{transaction.type === "income" ? labels.common.income : labels.common.expense}
{getCategoryDisplayName(transaction.categoryName, locale)}
<span>{labels.common.actor}: {transaction.actorMemberName}</span>
<span>{labels.common.createdBy}: {transaction.createdByMemberName}</span>
<p className="shrink-0 text-sm text-stone-500">{formatLocaleDateTime(transaction.occurredAt, locale)}</p>
```

- [ ] **Step 2: Update Home page to read locale/messages**

In `src/app/(app)/home/page.tsx`, import:

```ts
import { formatLocaleNumber, getMessages } from "@/lib/i18n";
import { getServerLocale } from "@/lib/i18n-server";
```

Inside `HomePage`, after session:

```ts
const locale = await getServerLocale();
const messages = getMessages(locale);
```

Replace UI text and component props:

```tsx
{messages.home.eyebrow}
{messages.home.title}
{messages.home.description}
<TimeRangeSelector labels={messages.range} />
{messages.home.addTransaction}
<PerspectiveToggle labels={messages.perspective} />
{messages.home.transactionCount(dashboard.summary.transactionCount)}
...
detail={messages.home.summary.incomeDetail}
title={messages.home.summary.incomeTitle}
viewLabel={messages.common.view}
...
value={formatLocaleNumber(dashboard.summary.transactionCount, locale)}
...
<TrendChart
  labels={{ ...messages.trend, tx: messages.common.tx }}
  ...
/>
<CategoryBreakdown
  labels={messages.categories}
  locale={locale}
  ...
/>
<RecentTransactions
  labels={{ common: messages.common, recent: messages.recent }}
  locale={locale}
  ...
/>
```

- [ ] **Step 3: Update Add page to read locale/messages**

In `src/app/(app)/add/page.tsx`, import `Locale`, `getMessages`, and `getServerLocale`. Change `formatSuccessAmount` to:

```ts
function formatSuccessAmount(amountFen: number, locale: Locale) {
  return new Intl.NumberFormat(locale, {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  }).format(amountFen / 100);
}
```

Change `readSuccessDetail` signature:

```ts
function readSuccessDetail(
  searchParams:
    | {
        amountFen?: string;
        created?: string;
        type?: string;
      }
    | undefined,
  locale: Locale,
  messages: ReturnType<typeof getMessages>,
) {
```

Return:

```ts
const typeLabel = searchParams.type === "expense" ? messages.common.expense : messages.common.income;

return messages.add.successDetail(typeLabel, formatSuccessAmount(amountFen, locale));
```

Inside `AddPage`, add locale/messages and replace UI text:

```tsx
const locale = await getServerLocale();
const messages = getMessages(locale);
...
{messages.add.eyebrow}
{messages.add.title}
{messages.add.description}
...
labels={{ add: messages.add, common: messages.common }}
locale={locale}
successDetail={readSuccessDetail(resolvedSearchParams, locale, messages)}
successMessage={resolvedSearchParams?.created === "1" ? messages.add.successMessage : undefined}
```

- [ ] **Step 4: Update Records page to read locale/messages**

In `src/app/(app)/records/page.tsx`, import:

```ts
import { formatLocaleDateTime, getCategoryDisplayName, getMessages } from "@/lib/i18n";
import { getServerLocale } from "@/lib/i18n-server";
```

Change `formatOccurredAt` to accept locale:

```ts
function formatOccurredAt(date: Date, locale: Locale) {
  return formatLocaleDateTime(date, locale);
}
```

Change `getNoteExcerpt` to accept the no-note label:

```ts
function getNoteExcerpt(note: string | null, noNoteLabel: string) {
  if (!note) {
    return noNoteLabel;
  }
```

Inside `RecordsPage`, add:

```ts
const locale = await getServerLocale();
const messages = getMessages(locale);
```

Replace UI text and props:

```tsx
{messages.records.eyebrow}
{messages.records.title}
{messages.records.description}
<TimeRangeSelector labels={messages.range} />
<PerspectiveToggle labels={messages.perspective} />
<RecordsFilterBar categories={categoryOptions} labels={{ common: messages.common }} locale={locale} />
{messages.records.empty}
{record.type === "income" ? messages.common.income : messages.common.expense}
{getCategoryDisplayName(record.categoryName, locale)}
{getNoteExcerpt(record.note, messages.common.noNote)}
<span>{messages.common.actor}: {record.actorMemberName}</span>
<span>{messages.common.createdBy}: {record.createdByMemberName}</span>
{formatOccurredAt(record.occurredAt, locale)}
...
occurredAtLabel: formatOccurredAt(selectedRecord.occurredAt, locale)
labels={{ common: messages.common, editor: messages.editor }}
locale={locale}
```

- [ ] **Step 5: Run focused unit and integration checks**

Run:

```powershell
npm run lint
npx vitest run tests/unit/navigation-version-marker.test.tsx tests/integration/records-page-and-actions.test.ts
```

Expected result: both commands pass.

---

### Task 7: E2E Coverage For Default Chinese And English Toggle

**Files:**
- Modify: `tests/e2e/create-expense.spec.ts`
- Modify: `tests/e2e/create-income.spec.ts`
- Modify: `tests/e2e/filter-navigation.spec.ts`
- Modify: `tests/e2e/home-drilldown.spec.ts`
- Modify: `tests/e2e/ui-layout.spec.ts`

- [ ] **Step 1: Update e2e login helpers to default Chinese labels**

In each e2e helper that logs in, replace:

```ts
await page.getByLabel("Email").fill(requireEnv("SEED_USER_A_EMAIL"));
await page.getByLabel("Password").fill(requireEnv("SEED_USER_A_PASSWORD"));
await page.getByRole("button", { name: "Log in" }).click();
```

with:

```ts
await page.getByLabel("邮箱").fill(requireEnv("SEED_USER_A_EMAIL"));
await page.getByLabel("密码").fill(requireEnv("SEED_USER_A_PASSWORD"));
await page.getByRole("button", { name: "登录" }).click();
```

In `tests/e2e/filter-navigation.spec.ts`, replace direct login selectors with:

```ts
await page.locator('input[name="email"]').fill("spouse@example.com");
await page.locator('input[name="password"]').fill("change-me");
await page.getByRole("button", { name: "登录" }).click();
```

- [ ] **Step 2: Update create flow labels**

In create-income and layout tests, replace:

```ts
await page.getByLabel("Income").check({ force: true });
await page.getByLabel("Amount").fill("4321.09");
await page.getByRole("button", { name: "Salary" }).click();
await page.getByLabel("Note").fill(note);
await page.getByRole("button", { name: "Save transaction" }).click();
await expect(page.getByText("Transaction saved")).toBeVisible();
```

with:

```ts
await page.getByLabel("收入").check({ force: true });
await page.getByLabel("金额").fill("4321.09");
await page.getByRole("button", { name: "工资" }).click();
await page.getByLabel("备注").fill(note);
await page.getByRole("button", { name: "保存记录" }).click();
await expect(page.getByText("记录已保存")).toBeVisible();
```

In create-expense, replace:

```ts
await page.getByLabel("Amount").fill("12.34");
await page.getByRole("button", { name: "Groceries" }).click();
await page.getByLabel("Who").selectOption({ label: requireEnv("SEED_USER_B_NAME") });
await page.getByLabel("Note").fill(note);
await page.getByRole("button", { name: "Save transaction" }).click();
await expect(page.getByText("Transaction saved")).toBeVisible();
await expect(page.getByText("Expense: 12.34")).toBeVisible();
await expect(page.getByRole("link", { name: "Add another" })).toBeVisible();
await expect(page.getByRole("link", { name: "Return home" })).toBeVisible();
```

with:

```ts
await page.getByLabel("金额").fill("12.34");
await page.getByRole("button", { name: "买菜" }).click();
await page.getByLabel("成员").selectOption({ label: requireEnv("SEED_USER_B_NAME") });
await page.getByLabel("备注").fill(note);
await page.getByRole("button", { name: "保存记录" }).click();
await expect(page.getByText("记录已保存")).toBeVisible();
await expect(page.getByText("支出：12.34")).toBeVisible();
await expect(page.getByRole("link", { name: "再记一笔" })).toBeVisible();
await expect(page.getByRole("link", { name: "返回首页" })).toBeVisible();
```

- [ ] **Step 3: Update navigation assertions**

Replace nav link names:

```ts
await page.getByRole("link", { name: "Add", exact: true }).click();
await page.getByRole("link", { name: "Records" }).click();
await expect(page.getByRole("link", { name: "Home", exact: true })).toBeVisible();
await expect(page.getByRole("link", { name: "Add", exact: true })).toBeVisible();
await expect(page.getByRole("link", { name: "Records", exact: true })).toBeVisible();
```

with:

```ts
await page.getByRole("link", { name: "记一笔", exact: true }).click();
await page.getByRole("link", { name: "记录", exact: true }).click();
await expect(page.getByRole("link", { name: "首页", exact: true })).toBeVisible();
await expect(page.getByRole("link", { name: "记一笔", exact: true })).toBeVisible();
await expect(page.getByRole("link", { name: "记录", exact: true })).toBeVisible();
```

- [ ] **Step 4: Add an English app-shell toggle e2e assertion**

Append this test to `tests/e2e/filter-navigation.spec.ts`:

```ts
test("language toggle switches the app shell to English without changing filters", async ({ page }) => {
  await page.goto("/login");
  await page.locator('input[name="email"]').fill("spouse@example.com");
  await page.locator('input[name="password"]').fill("change-me");
  await page.getByRole("button", { name: "登录" }).click();

  await page.goto("/home?perspective=spouse&range=last-30-days");
  await page.getByRole("button", { name: "切换语言" }).first().click();

  await expect(page.getByRole("link", { name: "Home", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Add", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Records", exact: true })).toBeVisible();
  await expect(page).toHaveURL(/perspective=spouse/);
  await expect(page).toHaveURL(/range=last-30-days/);
});
```

- [ ] **Step 5: Run e2e tests**

Run:

```powershell
npm run test:e2e
```

Expected result: all e2e tests pass.

---

### Task 8: Version, Full Verification, And Commit

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Update version fields for the implementation feature**

Change root version fields from `0.4.0` to `0.5.0` in:

```json
{
  "version": "0.5.0"
}
```

Apply this to:

- `package.json`
- root `version` in `package-lock.json`
- root package entry `packages[""].version` in `package-lock.json`

- [ ] **Step 2: Prepare database and seed data**

Run:

```powershell
.\ops\podman\compose.ps1 -f podman-compose.dev.yml up -d db
npm run prisma:seed
```

Expected result: database container is running and seed exits with code `0`.

- [ ] **Step 3: Run full verification**

Run:

```powershell
npm run lint
npm run test:unit
npm run test:integration
npm run test:e2e
```

Expected result: all commands pass. For Vitest, expected current baseline is 19 test files and 58 tests before adding the i18n tests; after this plan, the total increases by the new i18n unit test file and its test cases.

- [ ] **Step 4: Check final diff and status**

Run:

```powershell
git status --short --branch
git diff --check
git diff --stat
```

Expected result: only files from this plan are modified, `git diff --check` exits with code `0`, and existing unrelated `.superpowers/` remains untracked if it is still present.

- [ ] **Step 5: Commit the implementation**

Run:

```powershell
git add -- src tests package.json package-lock.json
git commit -m "v0.5.0 支持 UI 中英文切换" -m "默认中文 UI，使用浏览器 cookie 一键切换英文；分类仅做显示层翻译，保留现有数据库、URL 筛选和业务逻辑。"
```

Expected result: commit succeeds on `master` with version `0.5.0`.

---

## Self-Review

- Spec coverage: plan covers cookie locale, default Chinese, language toggle placement, centralized messages, category display mapping, server/client data flow, action errors, URL preservation, and full verification.
- Scope control: plan does not modify Prisma schema, seed category data, auth session shape, report aggregation, record query semantics, or URL parameter semantics.
- Type consistency: `Locale`, `Messages`, `getMessages`, `getServerLocale`, `LanguageToggle`, and localized component props are introduced before they are used by pages and tests.
- Test path: TDD starts with unit tests for helpers, navigation unit test changes before nav code, smoke e2e changes before login code, then full e2e after page/component wiring.
