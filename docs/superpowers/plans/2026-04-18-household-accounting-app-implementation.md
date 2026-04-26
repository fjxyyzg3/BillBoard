# Household Accounting App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first production-ready version of the two-user household accounting PWA described in the approved spec, including authentication, transaction CRUD, reporting, PWA packaging, and self-hosted deployment assets.

**Architecture:** Build a single Next.js App Router monolith under `src/`, backed by Prisma and PostgreSQL. Keep mutations in focused server-side modules, keep reporting derived directly from filtered transactions in application code, and package the app for self-hosting with Docker Compose and Caddy. Avoid signup, offline sync, account balances, or any other functionality outside the approved v1 scope.

**Tech Stack:** `Next.js`, `React`, `TypeScript`, `Tailwind CSS`, `PostgreSQL`, `Prisma`, `Auth.js`, `Zod`, `Vitest`, `Playwright`, `Docker Compose`, `Caddy`, `Recharts`, `Argon2`

---

## Assumptions

- The repository is still greenfield. There is no existing app code to preserve, only docs.
- v1 ships with login only. The two users, one household, and default categories are created via `prisma/seed.ts`; there is no public registration page.
- The UI accepts yuan input, but the database stores positive integer `amount_fen`.
- Reporting reads current non-deleted transactions directly and aggregates in code. This is simpler and appropriate for a two-user app.
- Production deployment targets a Linux host, even though local development may happen on Windows.

## Planned File Structure

### Root and Tooling

- Create: `package.json` - app scripts and runtime/test dependencies
- Create: `tsconfig.json` - TypeScript config with `@/*` path alias
- Create: `next.config.ts` - standalone Next.js build for Docker
- Create: `postcss.config.mjs` - Tailwind/PostCSS wiring
- Create: `tailwind.config.ts` - content globs and theme tokens
- Create: `eslint.config.mjs` - lint baseline for TS/React
- Modify: `.gitignore` - start with `.worktrees/`, then extend for Node, Next, Prisma, test, and env ignores
- Create: `.env.example` - local and production env contract
- Create: `.dockerignore` - keep image builds lean
- Create: `Dockerfile` - production web image
- Create: `docker-compose.dev.yml` - local `web` and `db`
- Create: `docker-compose.yml` - production `web`, `db`, and `proxy`
- Create: `vitest.config.ts` - unit/integration config
- Create: `playwright.config.ts` - browser test config

### Prisma and Data Helpers

- Create: `prisma/schema.prisma` - domain models plus Auth.js/session infrastructure models
- Create: `prisma/seed.ts` - create the default household, two users, members, and categories
- Create: `src/lib/db.ts` - shared Prisma client
- Create: `src/lib/money.ts` - amount parsing/formatting helpers
- Create: `src/lib/time-range.ts` - time-window presets and bucket helpers
- Create: `src/lib/perspective.ts` - translate `household/me/spouse` into member filters
- Create: `src/lib/env.ts` - narrow env access for server code

### Authentication and Access Control

- Create: `src/auth.ts` - Auth.js instance and exports
- Create: `src/app/api/auth/[...nextauth]/route.ts` - Auth.js route handlers
- Create: `src/lib/auth/permissions.ts` - household membership enforcement
- Create: `src/lib/auth/login-guard.ts` - rate limit and temporary lockout logic
- Create: `src/lib/auth/session.ts` - current session/member lookup helpers
- Create: `src/middleware.ts` - protect app routes

### App Router and UI

- Create: `src/app/layout.tsx` - global metadata and styles
- Create: `src/app/page.tsx` - root redirect
- Create: `src/app/globals.css` - Tailwind layers and app-wide tokens
- Create: `src/app/(auth)/login/page.tsx` - login screen
- Create: `src/app/(app)/layout.tsx` - authenticated shell wrapper
- Create: `src/app/(app)/home/page.tsx` - dashboard
- Create: `src/app/(app)/add/page.tsx` - transaction entry page
- Create: `src/app/(app)/add/actions.ts` - add-transaction server action
- Create: `src/app/(app)/records/page.tsx` - records page
- Create: `src/app/(app)/records/actions.ts` - update/delete server actions
- Create: `src/app/manifest.ts` - installable PWA manifest
- Create: `src/components/app-shell.tsx` - shared nav/chrome
- Create: `src/components/bottom-nav.tsx` - mobile primary nav
- Create: `src/components/desktop-nav.tsx` - desktop/tablet primary nav
- Create: `src/components/perspective-toggle.tsx` - `Household / Me / Spouse`
- Create: `src/components/time-range-selector.tsx` - page-level time filters
- Create: `src/components/summary-card.tsx` - reusable metric card
- Create: `src/components/trend-chart.tsx` - time-series chart
- Create: `src/components/category-breakdown.tsx` - expense category chart
- Create: `src/components/recent-transactions.tsx` - recent list on Home
- Create: `src/components/transaction-form.tsx` - add/edit form fields
- Create: `src/components/category-picker.tsx` - quick-tap category grid
- Create: `src/components/records-filter-bar.tsx` - records page filters
- Create: `src/components/transaction-editor-drawer.tsx` - edit/delete surface

### Domain Logic

- Create: `src/lib/transactions/schema.ts` - Zod validation for create/update
- Create: `src/lib/transactions/create-transaction.ts` - creation use case
- Create: `src/lib/transactions/update-transaction.ts` - editing use case
- Create: `src/lib/transactions/delete-transaction.ts` - soft delete use case
- Create: `src/lib/records/list-records.ts` - records query with filters
- Create: `src/lib/reports/aggregate.ts` - summary, category, and trend aggregation
- Create: `src/lib/reports/query-dashboard.ts` - dashboard data loader

### Tests

- Create: `tests/unit/money.test.ts`
- Create: `tests/unit/time-range.test.ts`
- Create: `tests/unit/perspective.test.ts`
- Create: `tests/unit/permissions.test.ts`
- Create: `tests/unit/report-aggregate.test.ts`
- Create: `tests/integration/create-transaction.test.ts`
- Create: `tests/integration/records-query.test.ts`
- Create: `tests/integration/report-query.test.ts`
- Create: `tests/integration/login-guard.test.ts`
- Create: `tests/e2e/app-smoke.spec.ts`
- Create: `tests/e2e/create-expense.spec.ts`
- Create: `tests/e2e/create-income.spec.ts`
- Create: `tests/e2e/home-drilldown.spec.ts`

### Operations and Runbooks

- Create: `public/icons/app-icon.svg`
- Create: `public/icons/icon-192.png`
- Create: `public/icons/icon-512.png`
- Create: `ops/caddy/Caddyfile`
- Create: `ops/backup/pg_dump.sh`
- Create: `ops/backup/restore-from-dump.sh`
- Create: `docs/runbooks/home-network-checklist.md`
- Create: `docs/runbooks/restore.md`

## Task 1: Bootstrap the Next.js Workspace

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `next.config.ts`
- Create: `postcss.config.mjs`
- Create: `tailwind.config.ts`
- Create: `eslint.config.mjs`
- Modify: `.gitignore`
- Create: `.env.example`
- Create: `.dockerignore`
- Create: `docker-compose.dev.yml`
- Create: `vitest.config.ts`
- Create: `playwright.config.ts`
- Create: `src/app/layout.tsx`
- Create: `src/app/globals.css`
- Create: `src/app/page.tsx`
- Create: `src/app/(auth)/login/page.tsx`
- Test: `tests/e2e/app-smoke.spec.ts`

- [ ] **Step 1: Write the failing smoke test and browser config**

```ts
// playwright.config.ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  use: {
    baseURL: "http://127.0.0.1:3000",
    trace: "on-first-retry",
  },
  webServer: {
    command: "npm run dev",
    port: 3000,
    reuseExistingServer: !process.env.CI,
  },
});
```

```ts
// tests/e2e/app-smoke.spec.ts
import { test, expect } from "@playwright/test";

test("guests land on the login screen", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { name: "Household Accounting" })).toBeVisible();
});
```

- [ ] **Step 2: Run the smoke test to verify it fails**

Run: `npx playwright test tests/e2e/app-smoke.spec.ts`
Expected: FAIL with `Cannot find module '@playwright/test'` or `Cannot GET /`

- [ ] **Step 3: Add the minimum app/tooling files**

```json
// package.json
{
  "name": "billboard",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "eslint . --max-warnings=0",
    "test:unit": "vitest run tests/unit",
    "test:integration": "vitest run tests/integration",
    "test:e2e": "playwright test",
    "prisma:generate": "prisma generate",
    "prisma:migrate": "prisma migrate dev",
    "prisma:seed": "tsx prisma/seed.ts"
  }
}
```

```ts
// next.config.ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
};

export default nextConfig;
```

```tsx
// src/app/layout.tsx
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Household Accounting",
  description: "Fast two-person household accounting.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-stone-50 text-stone-900">{children}</body>
    </html>
  );
}
```

```tsx
// src/app/page.tsx
import { redirect } from "next/navigation";

export default function RootPage() {
  redirect("/login");
}
```

```tsx
// src/app/(auth)/login/page.tsx
export default function LoginPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <h1 className="text-3xl font-semibold">Household Accounting</h1>
      <p className="mt-3 text-sm text-stone-600">Login will be wired in Task 3.</p>
    </main>
  );
}
```

```css
/* src/app/globals.css */
@tailwind base;
@tailwind components;
@tailwind utilities;

body {
  font-family: ui-sans-serif, system-ui, sans-serif;
}
```

- [ ] **Step 4: Add local development infrastructure**

```yaml
# docker-compose.dev.yml
services:
  db:
    image: postgres:17
    environment:
      POSTGRES_DB: billboard
      POSTGRES_USER: billboard
      POSTGRES_PASSWORD: billboard
    ports:
      - "5432:5432"
    volumes:
      - postgres-dev-data:/var/lib/postgresql/data

volumes:
  postgres-dev-data:
```

```env
# .env.example
DATABASE_URL=postgresql://billboard:billboard@127.0.0.1:5432/billboard?schema=public
AUTH_SECRET=replace-me
SEED_HOUSEHOLD_NAME=Household
SEED_USER_A_EMAIL=user-a@example.com
SEED_USER_A_PASSWORD=replace-me
SEED_USER_A_NAME=Me
SEED_USER_B_EMAIL=user-b@example.com
SEED_USER_B_PASSWORD=replace-me
SEED_USER_B_NAME=Spouse
```

- [ ] **Step 5: Install dependencies and rerun the smoke test**

Run:
- `npm install next react react-dom zod @auth/prisma-adapter next-auth @prisma/client recharts argon2`
- `npm install -D typescript @types/node @types/react @types/react-dom tailwindcss postcss autoprefixer eslint eslint-config-next prisma tsx vitest @vitejs/plugin-react @playwright/test`
- `npx playwright test tests/e2e/app-smoke.spec.ts`

Expected: PASS with `1 passed`

- [ ] **Step 6: Verify the workspace boots and commit**

Run:
- `npm run lint`
- `npm run build`
- `docker compose -f docker-compose.dev.yml config`

Expected:
- `npm run lint` exits `0`
- `npm run build` completes a production build
- `docker compose ... config` prints a valid merged config

- [ ] **Step 7: Commit**

```bash
git add package.json tsconfig.json next.config.ts postcss.config.mjs tailwind.config.ts eslint.config.mjs .gitignore .env.example .dockerignore docker-compose.dev.yml vitest.config.ts playwright.config.ts src/app tests/e2e/app-smoke.spec.ts
git commit -m "chore: bootstrap household accounting workspace"
```

## Task 2: Define the Data Model, Seed Data, and Core Helpers

**Files:**
- Create: `prisma/schema.prisma`
- Create: `prisma/seed.ts`
- Create: `src/lib/db.ts`
- Create: `src/lib/money.ts`
- Create: `src/lib/time-range.ts`
- Create: `src/lib/env.ts`
- Test: `tests/unit/money.test.ts`
- Test: `tests/unit/time-range.test.ts`

- [ ] **Step 1: Write failing unit tests for amount and date helpers**

```ts
// tests/unit/money.test.ts
import { describe, expect, it } from "vitest";
import { formatFen, parseAmountInput } from "@/lib/money";

describe("parseAmountInput", () => {
  it("converts a yuan string into fen", () => {
    expect(parseAmountInput("12.34")).toBe(1234);
  });

  it("rejects zero or negative values", () => {
    expect(() => parseAmountInput("0")).toThrow("Amount must be greater than zero");
    expect(() => parseAmountInput("-1")).toThrow("Amount must be greater than zero");
  });
});

describe("formatFen", () => {
  it("renders fen as yuan", () => {
    expect(formatFen(1234)).toBe("12.34");
  });
});
```

```ts
// tests/unit/time-range.test.ts
import { describe, expect, it } from "vitest";
import { getRangeBounds } from "@/lib/time-range";

describe("getRangeBounds", () => {
  it("returns month bounds in Asia/Shanghai", () => {
    const now = new Date("2026-04-18T09:30:00+08:00");
    const range = getRangeBounds("this-month", now, "Asia/Shanghai");

    expect(range.from.toISOString()).toBe("2026-03-31T16:00:00.000Z");
    expect(range.to.toISOString()).toBe("2026-04-30T15:59:59.999Z");
  });
});
```

- [ ] **Step 2: Run the unit tests to verify they fail**

Run:
- `npm run test:unit -- tests/unit/money.test.ts`
- `npm run test:unit -- tests/unit/time-range.test.ts`

Expected: FAIL with `Cannot find module '@/lib/money'` and `Cannot find module '@/lib/time-range'`

- [ ] **Step 3: Implement the amount/date helpers**

```ts
// src/lib/money.ts
export function parseAmountInput(input: string): number {
  const normalized = input.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) {
    throw new Error("Enter a valid amount with up to two decimals");
  }

  const [yuan, decimal = ""] = normalized.split(".");
  const fen = Number(yuan) * 100 + Number(decimal.padEnd(2, "0"));

  if (fen <= 0) {
    throw new Error("Amount must be greater than zero");
  }

  return fen;
}

export function formatFen(fen: number): string {
  const yuan = Math.floor(fen / 100);
  const cents = String(fen % 100).padStart(2, "0");
  return `${yuan}.${cents}`;
}
```

```ts
// src/lib/time-range.ts
export type RangePreset = "this-month" | "last-7-days" | "last-30-days" | "last-12-months";

export function getRangeBounds(preset: RangePreset, now: Date, timezone: string) {
  if (timezone !== "Asia/Shanghai") {
    throw new Error("v1 supports Asia/Shanghai range math only");
  }

  const local = new Date(now.toLocaleString("en-US", { timeZone: timezone }));

  if (preset === "this-month") {
    const from = new Date(Date.UTC(local.getFullYear(), local.getMonth(), 1, 0 - 8, 0, 0, 0));
    const to = new Date(Date.UTC(local.getFullYear(), local.getMonth() + 1, 0, 23 - 8, 59, 59, 999));
    return { from, to };
  }

  const days = preset === "last-7-days" ? 7 : preset === "last-30-days" ? 30 : 365;
  const from = new Date(now);
  from.setUTCDate(from.getUTCDate() - (days - 1));
  const to = new Date(now);
  return { from, to };
}
```

- [ ] **Step 4: Define the Prisma schema and seed data**

```prisma
// prisma/schema.prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum UserStatus {
  ACTIVE
  LOCKED
}

enum HouseholdRole {
  OWNER
  MEMBER
}

enum CategoryType {
  INCOME
  EXPENSE
}

enum TransactionType {
  INCOME
  EXPENSE
}

model User {
  id              String           @id @default(cuid())
  email           String           @unique
  displayName     String           @map("display_name")
  passwordHash    String           @map("password_hash")
  status          UserStatus       @default(ACTIVE)
  createdAt       DateTime         @default(now()) @map("created_at")
  updatedAt       DateTime         @updatedAt @map("updated_at")
  householdMember HouseholdMember?
  accounts        Account[]
  sessions        Session[]
}

model Household {
  id           String            @id @default(cuid())
  name         String
  baseCurrency String            @default("CNY") @map("base_currency")
  timezone     String            @default("Asia/Shanghai")
  createdAt    DateTime          @default(now()) @map("created_at")
  members      HouseholdMember[]
  transactions Transaction[]
}

model HouseholdMember {
  id                   String        @id @default(cuid())
  householdId          String        @map("household_id")
  userId               String        @unique @map("user_id")
  role                 HouseholdRole
  memberName           String        @map("member_name")
  joinedAt             DateTime      @default(now()) @map("joined_at")
  household            Household     @relation(fields: [householdId], references: [id], onDelete: Cascade)
  user                 User          @relation(fields: [userId], references: [id], onDelete: Cascade)
  actorTransactions    Transaction[] @relation("ActorTransactions")
  createdTransactions  Transaction[] @relation("CreatedTransactions")

  @@unique([householdId, memberName])
}

model Category {
  id          String        @id @default(cuid())
  type        CategoryType
  name        String
  sortOrder   Int           @map("sort_order")
  isActive    Boolean       @default(true) @map("is_active")
  transactions Transaction[]

  @@unique([type, name], name: "type_name")
}

model Transaction {
  id                String          @id @default(cuid())
  householdId       String          @map("household_id")
  type              TransactionType
  actorMemberId     String          @map("actor_member_id")
  createdByMemberId String          @map("created_by_member_id")
  categoryId        String          @map("category_id")
  amountFen         Int             @map("amount_fen")
  occurredAt        DateTime        @map("occurred_at")
  note              String?
  createdAt         DateTime        @default(now()) @map("created_at")
  updatedAt         DateTime        @updatedAt @map("updated_at")
  deletedAt         DateTime?       @map("deleted_at")
  household         Household       @relation(fields: [householdId], references: [id], onDelete: Cascade)
  category          Category        @relation(fields: [categoryId], references: [id])
  actorMember       HouseholdMember @relation("ActorTransactions", fields: [actorMemberId], references: [id])
  createdByMember   HouseholdMember @relation("CreatedTransactions", fields: [createdByMemberId], references: [id])

  @@index([householdId, occurredAt])
  @@index([actorMemberId, occurredAt])
  @@index([categoryId, occurredAt])
  @@unique([id, householdId], name: "id_householdId")
}

model LoginThrottle {
  id           String    @id @default(cuid())
  email        String    @unique
  attemptCount Int       @default(0) @map("attempt_count")
  lockedUntil  DateTime? @map("locked_until")
  updatedAt    DateTime  @updatedAt @map("updated_at")
}

model Account {
  userId             String
  type               String
  provider           String
  providerAccountId  String @map("provider_account_id")
  refreshToken       String? @db.Text @map("refresh_token")
  accessToken        String? @db.Text @map("access_token")
  expiresAt          Int? @map("expires_at")
  tokenType          String? @map("token_type")
  scope              String?
  idToken            String? @db.Text @map("id_token")
  sessionState       String? @map("session_state")
  user               User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@id([provider, providerAccountId])
}

model Session {
  sessionToken String   @unique @map("session_token")
  userId       String   @map("user_id")
  expires      DateTime
  user         User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@id([sessionToken])
}
```

```ts
// prisma/seed.ts
import argon2 from "argon2";
import { PrismaClient, CategoryType, HouseholdRole } from "@prisma/client";

const prisma = new PrismaClient();

const expenseCategories = ["Dining", "Groceries", "Transport", "Daily Use", "Home", "Medical", "Entertainment", "Social", "Travel", "Other"];
const incomeCategories = ["Salary", "Bonus", "Reimbursement", "Refund", "Investment", "Other"];

async function main() {
  const household = await prisma.household.upsert({
    where: { id: "default-household" },
    update: {},
    create: {
      id: "default-household",
      name: process.env.SEED_HOUSEHOLD_NAME ?? "Household",
      baseCurrency: "CNY",
      timezone: "Asia/Shanghai",
    },
  });

  const users = [
    {
      email: process.env.SEED_USER_A_EMAIL!,
      password: process.env.SEED_USER_A_PASSWORD!,
      displayName: process.env.SEED_USER_A_NAME ?? "Me",
      memberName: process.env.SEED_USER_A_NAME ?? "Me",
    },
    {
      email: process.env.SEED_USER_B_EMAIL!,
      password: process.env.SEED_USER_B_PASSWORD!,
      displayName: process.env.SEED_USER_B_NAME ?? "Spouse",
      memberName: process.env.SEED_USER_B_NAME ?? "Spouse",
    },
  ];

  for (const [index, user] of users.entries()) {
    const created = await prisma.user.upsert({
      where: { email: user.email },
      update: {
        displayName: user.displayName,
        passwordHash: await argon2.hash(user.password),
      },
      create: {
        email: user.email,
        displayName: user.displayName,
        passwordHash: await argon2.hash(user.password),
      },
    });

    await prisma.householdMember.upsert({
      where: { userId: created.id },
      update: {
        memberName: user.memberName,
      },
      create: {
        householdId: household.id,
        userId: created.id,
        memberName: user.memberName,
        role: index === 0 ? HouseholdRole.OWNER : HouseholdRole.MEMBER,
      },
    });
  }

  for (const [sortOrder, name] of expenseCategories.entries()) {
    await prisma.category.upsert({
      where: { type_name: { type: CategoryType.EXPENSE, name } },
      update: { isActive: true, sortOrder },
      create: { type: CategoryType.EXPENSE, name, sortOrder },
    });
  }

  for (const [sortOrder, name] of incomeCategories.entries()) {
    await prisma.category.upsert({
      where: { type_name: { type: CategoryType.INCOME, name } },
      update: { isActive: true, sortOrder },
      create: { type: CategoryType.INCOME, name, sortOrder },
    });
  }
}

main().finally(() => prisma.$disconnect());
```

- [ ] **Step 5: Add Prisma client wiring**

```ts
// src/lib/db.ts
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = db;
}
```

```ts
// src/lib/env.ts
import { z } from "zod";

const serverEnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  AUTH_SECRET: z.string().min(1),
});

export const serverEnv = serverEnvSchema.parse(process.env);
```

- [ ] **Step 6: Run schema generation, migration, seed, and helper tests**

Run:
- `docker compose -f docker-compose.dev.yml up -d db`
- `npm run prisma:generate`
- `npm run prisma:migrate -- --name init_household_accounting`
- `npm run prisma:seed`
- `npm run test:unit -- tests/unit/money.test.ts tests/unit/time-range.test.ts`

Expected:
- Prisma client generation succeeds
- A migration folder is created
- Seed logs finish without throwing
- Both unit test files pass

- [ ] **Step 7: Commit**

```bash
git add prisma src/lib tests/unit package.json
git commit -m "feat: add schema seed and core helpers"
```

## Task 3: Add Auth.js Login, Lockout, and Household Guards

**Files:**
- Create: `src/auth.ts`
- Create: `src/app/api/auth/[...nextauth]/route.ts`
- Create: `src/lib/auth/permissions.ts`
- Create: `src/lib/auth/login-guard.ts`
- Create: `src/lib/auth/session.ts`
- Create: `src/middleware.ts`
- Modify: `src/app/page.tsx`
- Modify: `src/app/(auth)/login/page.tsx`
- Test: `tests/unit/permissions.test.ts`
- Test: `tests/integration/login-guard.test.ts`

- [ ] **Step 1: Write failing tests for membership checks and lockout**

```ts
// tests/unit/permissions.test.ts
import { describe, expect, it } from "vitest";
import { assertHouseholdAccess, resolvePerspectiveMemberId } from "@/lib/auth/permissions";

describe("assertHouseholdAccess", () => {
  it("allows the matching household", () => {
    expect(() => assertHouseholdAccess("house-1", "house-1")).not.toThrow();
  });

  it("rejects a different household", () => {
    expect(() => assertHouseholdAccess("house-1", "house-2")).toThrow("Forbidden");
  });
});

describe("resolvePerspectiveMemberId", () => {
  it("returns the spouse member id for spouse perspective", () => {
    expect(
      resolvePerspectiveMemberId("spouse", "member-a", [
        { id: "member-a" },
        { id: "member-b" },
      ]),
    ).toBe("member-b");
  });
});
```

```ts
// tests/integration/login-guard.test.ts
import { describe, expect, it } from "vitest";
import { applyFailedAttempt } from "@/lib/auth/login-guard";

describe("applyFailedAttempt", () => {
  it("locks after five failed attempts", () => {
    const state = Array.from({ length: 5 }).reduce(
      (current) => applyFailedAttempt(current, new Date("2026-04-18T00:00:00.000Z")),
      null,
    );

    expect(state?.attemptCount).toBe(5);
    expect(state?.lockedUntil?.toISOString()).toBe("2026-04-18T00:15:00.000Z");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
- `npm run test:unit -- tests/unit/permissions.test.ts`
- `npm run test:integration -- tests/integration/login-guard.test.ts`

Expected: FAIL with missing auth helper modules

- [ ] **Step 3: Implement permission and lockout helpers**

```ts
// src/lib/auth/permissions.ts
export function assertHouseholdAccess(sessionHouseholdId: string, targetHouseholdId: string) {
  if (sessionHouseholdId !== targetHouseholdId) {
    throw new Error("Forbidden");
  }
}

export function resolvePerspectiveMemberId(
  perspective: "household" | "me" | "spouse",
  currentMemberId: string,
  members: Array<{ id: string }>,
) {
  if (perspective === "household") {
    return null;
  }

  if (perspective === "me") {
    return currentMemberId;
  }

  return members.find((member) => member.id !== currentMemberId)?.id ?? null;
}
```

```ts
// src/lib/auth/login-guard.ts
type LoginGuardState = {
  attemptCount: number;
  lockedUntil: Date | null;
};

const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;

export function applyFailedAttempt(state: LoginGuardState | null, now: Date): LoginGuardState {
  const attemptCount = (state?.attemptCount ?? 0) + 1;
  return {
    attemptCount,
    lockedUntil: attemptCount >= MAX_ATTEMPTS ? new Date(now.getTime() + LOCKOUT_WINDOW_MS) : null,
  };
}

export function isLocked(state: LoginGuardState | null, now: Date) {
  return Boolean(state?.lockedUntil && state.lockedUntil > now);
}
```

- [ ] **Step 4: Wire Auth.js credentials login and route protection**

```ts
// src/auth.ts
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import argon2 from "argon2";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { db } from "@/lib/db";

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(db),
  session: { strategy: "database" },
  pages: { signIn: "/login" },
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      authorize: async (credentials) => {
        const email = String(credentials.email ?? "").trim().toLowerCase();
        const password = String(credentials.password ?? "");
        const user = await db.user.findUnique({ where: { email }, include: { householdMember: true } });

        if (!user || !user.householdMember) {
          return null;
        }

        const valid = await argon2.verify(user.passwordHash, password);
        if (!valid) {
          return null;
        }

        return {
          id: user.id,
          email: user.email,
          name: user.displayName,
        };
      },
    }),
  ],
  callbacks: {
    session: async ({ session, user }) => {
      const member = await db.householdMember.findUnique({
        where: { userId: user.id },
        include: { household: true },
      });

      if (session.user && member) {
        session.user.id = user.id;
        session.user.memberId = member.id;
        session.user.householdId = member.householdId;
      }

      return session;
    },
  },
});
```

```ts
// src/app/api/auth/[...nextauth]/route.ts
import { handlers } from "@/auth";

export const { GET, POST } = handlers;
```

```ts
// src/middleware.ts
export { auth as middleware } from "@/auth";

export const config = {
  matcher: ["/home/:path*", "/add/:path*", "/records/:path*"],
};
```

```ts
// src/lib/auth/session.ts
import { auth } from "@/auth";

export async function requireAppSession() {
  const session = await auth();

  if (!session?.user?.householdId || !session.user.memberId) {
    throw new Error("Unauthorized");
  }

  return session.user;
}
```

```tsx
// src/app/page.tsx
import { auth } from "@/auth";
import { redirect } from "next/navigation";

export default async function RootPage() {
  const session = await auth();
  redirect(session ? "/home" : "/login");
}
```

```tsx
// src/app/(auth)/login/page.tsx
"use client";

import { signIn } from "next-auth/react";
import { useState } from "react";

export default function LoginPage() {
  const [error, setError] = useState("");

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <h1 className="text-3xl font-semibold">Household Accounting</h1>
      <form
        className="mt-8 space-y-4 rounded-2xl bg-white p-6 shadow-sm"
        onSubmit={async (event) => {
          event.preventDefault();
          const formData = new FormData(event.currentTarget);
          const result = await signIn("credentials", {
            email: formData.get("email"),
            password: formData.get("password"),
            redirect: false,
          });

          if (result?.error) {
            setError("Invalid email or password");
            return;
          }

          window.location.href = "/home";
        }}
      >
        <input name="email" type="email" required className="w-full rounded-xl border px-3 py-2" />
        <input name="password" type="password" required className="w-full rounded-xl border px-3 py-2" />
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
        <button className="w-full rounded-xl bg-stone-900 px-4 py-3 text-white" type="submit">
          Log in
        </button>
      </form>
    </main>
  );
}
```

- [ ] **Step 5: Verify auth tests and a seeded login flow**

Run:
- `npm run test:unit -- tests/unit/permissions.test.ts`
- `npm run test:integration -- tests/integration/login-guard.test.ts`
- `npm run test:e2e -- tests/e2e/app-smoke.spec.ts`

Expected:
- Unit and integration tests pass
- Smoke test still passes against the real login page

- [ ] **Step 6: Commit**

```bash
git add src/auth.ts src/app/api/auth src/lib/auth src/middleware.ts src/app/page.tsx src/app/(auth)/login/page.tsx tests/unit/permissions.test.ts tests/integration/login-guard.test.ts
git commit -m "feat: add auth and household access control"
```

## Task 4: Build the Authenticated Shell and Shared Filters

**Files:**
- Create: `src/app/(app)/layout.tsx`
- Create: `src/components/app-shell.tsx`
- Create: `src/components/bottom-nav.tsx`
- Create: `src/components/desktop-nav.tsx`
- Create: `src/components/perspective-toggle.tsx`
- Create: `src/components/time-range-selector.tsx`
- Create: `src/lib/perspective.ts`
- Create: `tests/unit/perspective.test.ts`
- Modify: `src/app/(app)/home/page.tsx`
- Modify: `src/app/(app)/add/page.tsx`
- Modify: `src/app/(app)/records/page.tsx`

- [ ] **Step 1: Write the failing filter-state unit test**

```ts
// tests/unit/perspective.test.ts
import { describe, expect, it } from "vitest";
import { resolvePerspective } from "@/lib/perspective";

describe("resolvePerspective", () => {
  it("returns both members for household", () => {
    expect(resolvePerspective("household", "member-a", ["member-a", "member-b"])).toEqual(["member-a", "member-b"]);
  });

  it("returns the other member for spouse", () => {
    expect(resolvePerspective("spouse", "member-a", ["member-a", "member-b"])).toEqual(["member-b"]);
  });
});
```

- [ ] **Step 2: Run the unit test to verify it fails**

Run: `npm run test:unit -- tests/unit/perspective.test.ts`
Expected: FAIL with `Cannot find module '@/lib/perspective'`

- [ ] **Step 3: Implement shared perspective helpers and the shell**

```ts
// src/lib/perspective.ts
export type Perspective = "household" | "me" | "spouse";

export function resolvePerspective(perspective: Perspective, currentMemberId: string, memberIds: string[]) {
  if (perspective === "household") {
    return memberIds;
  }

  if (perspective === "me") {
    return [currentMemberId];
  }

  return memberIds.filter((memberId) => memberId !== currentMemberId);
}
```

```tsx
// src/components/app-shell.tsx
import { BottomNav } from "@/components/bottom-nav";
import { DesktopNav } from "@/components/desktop-nav";

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex min-h-screen max-w-6xl flex-col md:flex-row">
      <DesktopNav />
      <main className="min-h-screen flex-1 px-4 pb-24 pt-6 md:px-8 md:pb-8">{children}</main>
      <BottomNav />
    </div>
  );
}
```

```tsx
// src/components/bottom-nav.tsx
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const items = [
  { href: "/home", label: "Home" },
  { href: "/add", label: "Add" },
  { href: "/records", label: "Records" },
] as const;

export function BottomNav() {
  const pathname = usePathname();

  return (
    <nav className="fixed inset-x-0 bottom-0 border-t bg-white md:hidden">
      <ul className="grid grid-cols-3">
        {items.map((item) => (
          <li key={item.href}>
            <Link className={`flex justify-center px-4 py-3 text-sm ${pathname === item.href ? "font-semibold text-stone-900" : "text-stone-500"}`} href={item.href}>
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
```

```tsx
// src/components/desktop-nav.tsx
import Link from "next/link";

const items = [
  { href: "/home", label: "Home" },
  { href: "/add", label: "Add" },
  { href: "/records", label: "Records" },
] as const;

export function DesktopNav() {
  return (
    <aside className="hidden w-64 border-r bg-white p-6 md:block">
      <p className="text-lg font-semibold">BillBoard</p>
      <nav className="mt-6 space-y-2">
        {items.map((item) => (
          <Link key={item.href} className="block rounded-xl px-3 py-2 text-stone-700 hover:bg-stone-100" href={item.href}>
            {item.label}
          </Link>
        ))}
      </nav>
    </aside>
  );
}
```

```tsx
// src/components/perspective-toggle.tsx
export function PerspectiveToggle() {
  return (
    <div className="inline-grid grid-cols-3 rounded-2xl bg-stone-100 p-1 text-sm">
      <button className="rounded-xl bg-white px-3 py-2">Household</button>
      <button className="rounded-xl px-3 py-2">Me</button>
      <button className="rounded-xl px-3 py-2">Spouse</button>
    </div>
  );
}
```

```tsx
// src/components/time-range-selector.tsx
export function TimeRangeSelector() {
  return (
    <select className="rounded-2xl border bg-white px-3 py-2 text-sm">
      <option value="this-month">This Month</option>
      <option value="last-7-days">Last 7 Days</option>
      <option value="last-30-days">Last 30 Days</option>
      <option value="last-12-months">Last 12 Months</option>
    </select>
  );
}
```

```tsx
// src/app/(app)/layout.tsx
import { auth } from "@/auth";
import { AppShell } from "@/components/app-shell";
import { redirect } from "next/navigation";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();

  if (!session) {
    redirect("/login");
  }

  return <AppShell>{children}</AppShell>;
}
```

- [ ] **Step 4: Add page placeholders that use the shared shell**

```tsx
// src/app/(app)/home/page.tsx
export default function HomePage() {
  return <section className="space-y-4"><h1 className="text-2xl font-semibold">Home</h1><p>Dashboard will land in Task 7.</p></section>;
}
```

```tsx
// src/app/(app)/add/page.tsx
export default function AddPage() {
  return <section className="space-y-4"><h1 className="text-2xl font-semibold">Add</h1><p>Fast entry form will land in Task 5.</p></section>;
}
```

```tsx
// src/app/(app)/records/page.tsx
export default function RecordsPage() {
  return <section className="space-y-4"><h1 className="text-2xl font-semibold">Records</h1><p>History and editing will land in Task 6.</p></section>;
}
```

- [ ] **Step 5: Verify the shell and filter helper**

Run:
- `npm run test:unit -- tests/unit/perspective.test.ts`
- `npm run build`

Expected:
- Perspective unit test passes
- Build succeeds with `/home`, `/add`, and `/records`

- [ ] **Step 6: Commit**

```bash
git add src/app/(app) src/components src/lib/perspective.ts tests/unit/perspective.test.ts
git commit -m "feat: add shared app shell and perspective filters"
```

## Task 5: Implement the Add Transaction Flow

**Files:**
- Create: `src/lib/transactions/schema.ts`
- Create: `src/lib/transactions/create-transaction.ts`
- Create: `src/components/transaction-form.tsx`
- Create: `src/components/category-picker.tsx`
- Modify: `src/app/(app)/add/page.tsx`
- Modify: `src/app/(app)/add/actions.ts`
- Test: `tests/integration/create-transaction.test.ts`

- [ ] **Step 1: Write the failing integration test for transaction creation**

```ts
// tests/integration/create-transaction.test.ts
import { describe, expect, it } from "vitest";
import { createTransaction } from "@/lib/transactions/create-transaction";

describe("createTransaction", () => {
  it("stores a positive fen amount for an expense", async () => {
    const transaction = await createTransaction(
      {
        type: "expense",
        amount: "25.50",
        categoryId: "expense-dining",
        actorMemberId: "member-a",
        note: "Lunch",
      },
      {
        householdId: "default-household",
        memberId: "member-a",
      },
    );

    expect(transaction.amountFen).toBe(2550);
    expect(transaction.type).toBe("EXPENSE");
    expect(transaction.createdByMemberId).toBe("member-a");
  });
});
```

- [ ] **Step 2: Run the integration test to verify it fails**

Run: `npm run test:integration -- tests/integration/create-transaction.test.ts`
Expected: FAIL with missing transaction modules

- [ ] **Step 3: Add validation and the create use case**

```ts
// src/lib/transactions/schema.ts
import { z } from "zod";

export const transactionInputSchema = z.object({
  type: z.enum(["expense", "income"]).default("expense"),
  amount: z.string().min(1),
  categoryId: z.string().min(1),
  actorMemberId: z.string().min(1),
  occurredAt: z.coerce.date().optional(),
  note: z.string().trim().max(200).optional(),
});

export type TransactionInput = z.infer<typeof transactionInputSchema>;
```

```ts
// src/lib/transactions/create-transaction.ts
import { TransactionType } from "@prisma/client";
import { db } from "@/lib/db";
import { parseAmountInput } from "@/lib/money";
import { transactionInputSchema, type TransactionInput } from "@/lib/transactions/schema";

export async function createTransaction(input: TransactionInput, currentMember: { householdId: string; memberId: string }) {
  const parsed = transactionInputSchema.parse(input);

  return db.transaction.create({
    data: {
      householdId: currentMember.householdId,
      type: parsed.type === "income" ? TransactionType.INCOME : TransactionType.EXPENSE,
      actorMemberId: parsed.actorMemberId,
      createdByMemberId: currentMember.memberId,
      categoryId: parsed.categoryId,
      amountFen: parseAmountInput(parsed.amount),
      occurredAt: parsed.occurredAt ?? new Date(),
      note: parsed.note || null,
    },
  });
}
```

- [ ] **Step 4: Build the compact add form and save action**

```tsx
// src/components/category-picker.tsx
type CategoryOption = { id: string; name: string };

export function CategoryPicker({
  categories,
  value,
  onChange,
}: {
  categories: CategoryOption[];
  value: string;
  onChange: (nextValue: string) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {categories.map((category) => (
        <button
          key={category.id}
          className={`rounded-2xl border px-4 py-3 text-left ${value === category.id ? "border-stone-900 bg-stone-900 text-white" : "border-stone-200 bg-white"}`}
          onClick={() => onChange(category.id)}
          type="button"
        >
          {category.name}
        </button>
      ))}
    </div>
  );
}
```

```tsx
// src/components/transaction-form.tsx
"use client";

import { useState } from "react";
import { CategoryPicker } from "@/components/category-picker";

export function TransactionForm({
  categories,
  members,
  onSubmit,
}: {
  categories: Array<{ id: string; name: string }>;
  members: Array<{ id: string; memberName: string }>;
  onSubmit: (formData: FormData) => Promise<void>;
}) {
  const [categoryId, setCategoryId] = useState(categories[0]?.id ?? "");

  return (
    <form action={onSubmit} className="space-y-5 rounded-3xl bg-white p-5 shadow-sm">
      <input autoFocus className="w-full rounded-2xl border px-4 py-4 text-3xl font-semibold" name="amount" placeholder="0.00" required />
      <div className="grid grid-cols-2 gap-3">
        <label className="rounded-2xl border p-3"><input defaultChecked name="type" type="radio" value="expense" /> Expense</label>
        <label className="rounded-2xl border p-3"><input name="type" type="radio" value="income" /> Income</label>
      </div>
      <input name="categoryId" type="hidden" value={categoryId} />
      <CategoryPicker categories={categories} value={categoryId} onChange={setCategoryId} />
      <select className="w-full rounded-2xl border px-4 py-3" name="actorMemberId" required>
        {members.map((member) => (
          <option key={member.id} value={member.id}>{member.memberName}</option>
        ))}
      </select>
      <input className="w-full rounded-2xl border px-4 py-3" name="occurredAt" type="datetime-local" />
      <textarea className="min-h-24 w-full rounded-2xl border px-4 py-3" name="note" placeholder="Note (optional)" />
      <button className="w-full rounded-2xl bg-stone-900 px-4 py-4 text-white" type="submit">Save transaction</button>
    </form>
  );
}
```

- [ ] **Step 5: Verify the integration test and page flow**

Run:
- `npm run test:integration -- tests/integration/create-transaction.test.ts`
- `npm run build`

Expected:
- Create transaction test passes
- Build succeeds with the populated Add page

- [ ] **Step 6: Commit**

```bash
git add src/lib/transactions src/components/transaction-form.tsx src/components/category-picker.tsx src/app/(app)/add tests/integration/create-transaction.test.ts
git commit -m "feat: add transaction capture flow"
```

## Task 6: Implement Records Listing, Editing, and Soft Delete

**Files:**
- Create: `src/lib/records/list-records.ts`
- Create: `src/lib/transactions/update-transaction.ts`
- Create: `src/lib/transactions/delete-transaction.ts`
- Create: `src/components/records-filter-bar.tsx`
- Create: `src/components/transaction-editor-drawer.tsx`
- Modify: `src/app/(app)/records/page.tsx`
- Modify: `src/app/(app)/records/actions.ts`
- Test: `tests/integration/records-query.test.ts`

- [ ] **Step 1: Write the failing records integration test**

```ts
// tests/integration/records-query.test.ts
import { describe, expect, it } from "vitest";
import { listRecords } from "@/lib/records/list-records";

describe("listRecords", () => {
  it("returns newest first and hides soft-deleted transactions", async () => {
    const records = await listRecords({
      householdId: "default-household",
      memberIds: ["member-a", "member-b"],
      type: "all",
    });

    expect(records.every((record) => record.deletedAt === null)).toBe(true);
    expect(records[0].occurredAt >= records[1].occurredAt).toBe(true);
  });
});
```

- [ ] **Step 2: Run the integration test to verify it fails**

Run: `npm run test:integration -- tests/integration/records-query.test.ts`
Expected: FAIL with missing records query module

- [ ] **Step 3: Implement records querying and mutation helpers**

```ts
// src/lib/records/list-records.ts
import { TransactionType } from "@prisma/client";
import { db } from "@/lib/db";

export async function listRecords({
  householdId,
  memberIds,
  type,
  categoryId,
}: {
  householdId: string;
  memberIds: string[];
  type: "all" | "income" | "expense";
  categoryId?: string;
}) {
  return db.transaction.findMany({
    where: {
      householdId,
      deletedAt: null,
      actorMemberId: { in: memberIds },
      ...(type === "all"
        ? {}
        : { type: type === "income" ? TransactionType.INCOME : TransactionType.EXPENSE }),
      ...(categoryId ? { categoryId } : {}),
    },
    include: {
      category: true,
      actorMember: true,
      createdByMember: true,
    },
    orderBy: { occurredAt: "desc" },
  });
}
```

```ts
// src/lib/transactions/delete-transaction.ts
import { db } from "@/lib/db";

export async function softDeleteTransaction(id: string, householdId: string) {
  await db.transaction.findFirstOrThrow({
    where: { id, householdId, deletedAt: null },
    select: { id: true },
  });

  return db.transaction.update({
    where: { id },
    data: { deletedAt: new Date() },
  });
}
```

```ts
// src/lib/transactions/update-transaction.ts
import { TransactionType } from "@prisma/client";
import { db } from "@/lib/db";
import { parseAmountInput } from "@/lib/money";
import { transactionInputSchema, type TransactionInput } from "@/lib/transactions/schema";

export async function updateTransaction(id: string, householdId: string, input: TransactionInput) {
  const parsed = transactionInputSchema.parse(input);

  await db.transaction.findFirstOrThrow({
    where: { id, householdId, deletedAt: null },
    select: { id: true },
  });

  return db.transaction.update({
    where: { id },
    data: {
      type: parsed.type === "income" ? TransactionType.INCOME : TransactionType.EXPENSE,
      categoryId: parsed.categoryId,
      actorMemberId: parsed.actorMemberId,
      amountFen: parseAmountInput(parsed.amount),
      occurredAt: parsed.occurredAt ?? new Date(),
      note: parsed.note || null,
    },
  });
}
```

- [ ] **Step 4: Build the records page, filters, and edit drawer**

```tsx
// src/components/records-filter-bar.tsx
export function RecordsFilterBar() {
  return (
    <div className="grid gap-3 rounded-2xl bg-white p-4 shadow-sm md:grid-cols-4">
      <select className="rounded-xl border px-3 py-2" name="range">
        <option value="last-30-days">Last 30 Days</option>
        <option value="last-7-days">Last 7 Days</option>
        <option value="this-month">This Month</option>
      </select>
      <select className="rounded-xl border px-3 py-2" name="perspective">
        <option value="household">Household</option>
        <option value="me">Me</option>
        <option value="spouse">Spouse</option>
      </select>
      <select className="rounded-xl border px-3 py-2" name="type">
        <option value="all">All</option>
        <option value="expense">Expense</option>
        <option value="income">Income</option>
      </select>
      <input className="rounded-xl border px-3 py-2" name="category" placeholder="Category" />
    </div>
  );
}
```

```tsx
// src/components/transaction-editor-drawer.tsx
"use client";

export function TransactionEditorDrawer({
  open,
  children,
}: {
  open: boolean;
  children: React.ReactNode;
}) {
  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 bg-black/30">
      <div className="absolute inset-x-0 bottom-0 rounded-t-3xl bg-white p-5 shadow-2xl md:left-auto md:right-6 md:top-6 md:w-[32rem] md:rounded-3xl">
        {children}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Verify record listing/edit/delete behavior**

Run:
- `npm run test:integration -- tests/integration/records-query.test.ts`
- `npm run build`

Expected:
- Records query test passes
- Records page renders with a filter bar and drawer shell

- [ ] **Step 6: Commit**

```bash
git add src/lib/records src/lib/transactions/update-transaction.ts src/lib/transactions/delete-transaction.ts src/components/records-filter-bar.tsx src/components/transaction-editor-drawer.tsx src/app/(app)/records tests/integration/records-query.test.ts
git commit -m "feat: add records history editing and soft delete"
```

## Task 7: Implement Home Reporting and Drill-Down

**Files:**
- Create: `src/lib/reports/aggregate.ts`
- Create: `src/lib/reports/query-dashboard.ts`
- Create: `src/components/summary-card.tsx`
- Create: `src/components/trend-chart.tsx`
- Create: `src/components/category-breakdown.tsx`
- Create: `src/components/recent-transactions.tsx`
- Modify: `src/app/(app)/home/page.tsx`
- Test: `tests/unit/report-aggregate.test.ts`
- Test: `tests/integration/report-query.test.ts`

- [ ] **Step 1: Write the failing report unit and integration tests**

```ts
// tests/unit/report-aggregate.test.ts
import { describe, expect, it } from "vitest";
import { buildSummary } from "@/lib/reports/aggregate";

describe("buildSummary", () => {
  it("calculates income, expense, net, and count", () => {
    const summary = buildSummary([
      { type: "INCOME", amountFen: 10000 },
      { type: "EXPENSE", amountFen: 2500 },
      { type: "EXPENSE", amountFen: 1500 },
    ]);

    expect(summary.totalIncomeFen).toBe(10000);
    expect(summary.totalExpenseFen).toBe(4000);
    expect(summary.netFen).toBe(6000);
    expect(summary.transactionCount).toBe(3);
  });
});
```

```ts
// tests/integration/report-query.test.ts
import { describe, expect, it } from "vitest";
import { queryDashboard } from "@/lib/reports/query-dashboard";

describe("queryDashboard", () => {
  it("filters the dashboard by perspective", async () => {
    const dashboard = await queryDashboard({
      householdId: "default-household",
      perspective: "me",
      currentMemberId: "member-a",
      timezone: "Asia/Shanghai",
      rangePreset: "this-month",
    });

    expect(dashboard.summary.transactionCount).toBeGreaterThanOrEqual(0);
    expect(dashboard.recentTransactions.every((record) => record.actorMemberId === "member-a")).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
- `npm run test:unit -- tests/unit/report-aggregate.test.ts`
- `npm run test:integration -- tests/integration/report-query.test.ts`

Expected: FAIL with missing report modules

- [ ] **Step 3: Implement report aggregation in application code**

```ts
// src/lib/reports/aggregate.ts
type ReportTransaction = {
  type: "INCOME" | "EXPENSE";
  amountFen: number;
  category?: { name: string };
  occurredAt?: Date;
};

export function buildSummary(transactions: ReportTransaction[]) {
  const totalIncomeFen = transactions
    .filter((transaction) => transaction.type === "INCOME")
    .reduce((sum, transaction) => sum + transaction.amountFen, 0);

  const totalExpenseFen = transactions
    .filter((transaction) => transaction.type === "EXPENSE")
    .reduce((sum, transaction) => sum + transaction.amountFen, 0);

  return {
    totalIncomeFen,
    totalExpenseFen,
    netFen: totalIncomeFen - totalExpenseFen,
    transactionCount: transactions.length,
  };
}

export function buildCategoryBreakdown(transactions: ReportTransaction[]) {
  const expenseTransactions = transactions.filter((transaction) => transaction.type === "EXPENSE");
  const total = expenseTransactions.reduce((sum, transaction) => sum + transaction.amountFen, 0) || 1;

  return Object.entries(
    expenseTransactions.reduce<Record<string, number>>((map, transaction) => {
      const key = transaction.category?.name ?? "Other";
      map[key] = (map[key] ?? 0) + transaction.amountFen;
      return map;
    }, {}),
  ).map(([name, amountFen]) => ({
    name,
    amountFen,
    ratio: amountFen / total,
  }));
}
```

```ts
// src/lib/reports/query-dashboard.ts
import { db } from "@/lib/db";
import { getRangeBounds } from "@/lib/time-range";
import { resolvePerspective } from "@/lib/perspective";
import { buildSummary, buildCategoryBreakdown } from "@/lib/reports/aggregate";

export async function queryDashboard({
  householdId,
  perspective,
  currentMemberId,
  timezone,
  rangePreset,
}: {
  householdId: string;
  perspective: "household" | "me" | "spouse";
  currentMemberId: string;
  timezone: string;
  rangePreset: "this-month" | "last-7-days" | "last-30-days" | "last-12-months";
}) {
  const members = await db.householdMember.findMany({
    where: { householdId },
    select: { id: true },
  });

  const memberIds = resolvePerspective(
    perspective,
    currentMemberId,
    members.map((member) => member.id),
  );

  const { from, to } = getRangeBounds(rangePreset, new Date(), timezone);

  const transactions = await db.transaction.findMany({
    where: {
      householdId,
      actorMemberId: { in: memberIds },
      deletedAt: null,
      occurredAt: { gte: from, lte: to },
    },
    include: {
      category: true,
      actorMember: true,
      createdByMember: true,
    },
    orderBy: { occurredAt: "desc" },
  });

  return {
    summary: buildSummary(transactions),
    categoryBreakdown: buildCategoryBreakdown(transactions),
    recentTransactions: transactions.slice(0, 10),
    trend: transactions,
  };
}
```

- [ ] **Step 4: Build the dashboard UI with drill-down links**

```tsx
// src/components/summary-card.tsx
export function SummaryCard({
  label,
  value,
  href,
}: {
  label: string;
  value: string;
  href?: string;
}) {
  const content = (
    <div className="rounded-3xl bg-white p-5 shadow-sm">
      <p className="text-sm text-stone-500">{label}</p>
      <p className="mt-2 text-2xl font-semibold">{value}</p>
    </div>
  );

  return href ? <a href={href}>{content}</a> : content;
}
```

```tsx
// src/components/trend-chart.tsx
"use client";

import { LineChart, Line, ResponsiveContainer, XAxis, YAxis, Tooltip } from "recharts";

export function TrendChart({ data }: { data: Array<{ label: string; expenseFen: number }> }) {
  return (
    <div className="h-72 rounded-3xl bg-white p-4 shadow-sm">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data}>
          <XAxis dataKey="label" />
          <YAxis />
          <Tooltip />
          <Line dataKey="expenseFen" stroke="#111827" strokeWidth={3} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
```

```tsx
// src/components/category-breakdown.tsx
export function CategoryBreakdown({
  items,
}: {
  items: Array<{ name: string; amountFen: number; ratio: number }>;
}) {
  return (
    <div className="rounded-3xl bg-white p-5 shadow-sm">
      <h2 className="text-lg font-semibold">Expense Categories</h2>
      <ul className="mt-4 space-y-3">
        {items.map((item) => (
          <li key={item.name} className="flex items-center justify-between">
            <span>{item.name}</span>
            <span className="text-sm text-stone-500">{Math.round(item.ratio * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

```tsx
// src/components/recent-transactions.tsx
export function RecentTransactions({
  items,
}: {
  items: Array<{ id: string; note: string | null; amountFen: number; category: { name: string } }>;
}) {
  return (
    <div className="rounded-3xl bg-white p-5 shadow-sm">
      <h2 className="text-lg font-semibold">Recent</h2>
      <ul className="mt-4 space-y-3">
        {items.map((item) => (
          <li key={item.id} className="flex items-center justify-between">
            <span>{item.note || item.category.name}</span>
            <span>{item.amountFen}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

```tsx
// src/app/(app)/home/page.tsx
import { auth } from "@/auth";
import { queryDashboard } from "@/lib/reports/query-dashboard";
import { SummaryCard } from "@/components/summary-card";
import { formatFen } from "@/lib/money";

export default async function HomePage() {
  const session = await auth();
  const dashboard = await queryDashboard({
    householdId: session!.user.householdId,
    currentMemberId: session!.user.memberId,
    perspective: "household",
    timezone: "Asia/Shanghai",
    rangePreset: "this-month",
  });

  return (
    <section className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">Home</h1>
        <p className="text-sm text-stone-500">This month at a glance.</p>
      </header>
      <div className="grid gap-4 md:grid-cols-4">
        <SummaryCard href="/records?type=income" label="Income" value={formatFen(dashboard.summary.totalIncomeFen)} />
        <SummaryCard href="/records?type=expense" label="Expense" value={formatFen(dashboard.summary.totalExpenseFen)} />
        <SummaryCard label="Net" value={formatFen(dashboard.summary.netFen)} />
        <SummaryCard href="/records" label="Transactions" value={String(dashboard.summary.transactionCount)} />
      </div>
    </section>
  );
}
```

- [ ] **Step 5: Verify report correctness**

Run:
- `npm run test:unit -- tests/unit/report-aggregate.test.ts`
- `npm run test:integration -- tests/integration/report-query.test.ts`
- `npm run build`

Expected:
- Report aggregation tests pass
- Dashboard query passes perspective filtering
- Build succeeds with the Home dashboard

- [ ] **Step 6: Commit**

```bash
git add src/lib/reports src/components/summary-card.tsx src/components/trend-chart.tsx src/components/category-breakdown.tsx src/components/recent-transactions.tsx src/app/(app)/home/page.tsx tests/unit/report-aggregate.test.ts tests/integration/report-query.test.ts
git commit -m "feat: add dashboard reporting and drilldown"
```

## Task 8: Add PWA, Production Compose, Caddy, Backup, and Recovery Docs

**Files:**
- Create: `src/app/manifest.ts`
- Create: `public/icons/app-icon.svg`
- Create: `public/icons/icon-192.png`
- Create: `public/icons/icon-512.png`
- Create: `Dockerfile`
- Create: `docker-compose.yml`
- Create: `ops/caddy/Caddyfile`
- Create: `ops/backup/pg_dump.sh`
- Create: `ops/backup/restore-from-dump.sh`
- Create: `docs/runbooks/home-network-checklist.md`
- Create: `docs/runbooks/restore.md`

- [ ] **Step 1: Add the installable manifest and icon source**

```ts
// src/app/manifest.ts
import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Household Accounting",
    short_name: "BillBoard",
    start_url: "/home",
    display: "standalone",
    background_color: "#f5f5f4",
    theme_color: "#111827",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
```

```svg
<!-- public/icons/app-icon.svg -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="120" fill="#111827"/>
  <path d="M128 152h256v44H128zM128 234h180v44H128zM128 316h256v44H128z" fill="#f5f5f4"/>
  <circle cx="360" cy="256" r="34" fill="#f59e0b"/>
</svg>
```

- [ ] **Step 2: Generate PNG icons from the SVG source**

Run:
- `magick public/icons/app-icon.svg -resize 192x192 public/icons/icon-192.png`
- `magick public/icons/app-icon.svg -resize 512x512 public/icons/icon-512.png`

Expected: Both PNG files are created under `public/icons/`

- [ ] **Step 3: Add the production image, compose stack, and Caddy config**

```dockerfile
# Dockerfile
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
EXPOSE 3000
CMD ["node", "server.js"]
```

```yaml
# docker-compose.yml
services:
  web:
    build: .
    env_file:
      - .env.production
    depends_on:
      - db
    expose:
      - "3000"

  db:
    image: postgres:17
    env_file:
      - .env.production
    volumes:
      - postgres-prod-data:/var/lib/postgresql/data
      - ./backups:/backups

  proxy:
    image: caddy:2
    depends_on:
      - web
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./ops/caddy/Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
      - caddy-config:/config

volumes:
  postgres-prod-data:
  caddy-data:
  caddy-config:
```

```caddyfile
# ops/caddy/Caddyfile
{$APP_DOMAIN} {
  encode gzip zstd

  reverse_proxy web:3000
}
```

- [ ] **Step 4: Add backup and restore scripts plus runbooks**

```bash
# ops/backup/pg_dump.sh
#!/usr/bin/env bash
set -euo pipefail

timestamp="$(date +%Y%m%d-%H%M%S)"
target_dir="${1:-./backups}"
mkdir -p "${target_dir}"

pg_dump "${DATABASE_URL}" --format=custom --file="${target_dir}/billboard-${timestamp}.dump"
find "${target_dir}" -name '*.dump' -type f -mtime +14 -delete
```

```bash
# ops/backup/restore-from-dump.sh
#!/usr/bin/env bash
set -euo pipefail

dump_file="${1:?Usage: restore-from-dump.sh /path/to/dump}"
dropdb --if-exists "${POSTGRES_DB}"
createdb "${POSTGRES_DB}"
pg_restore --clean --no-owner --dbname="${DATABASE_URL}" "${dump_file}"
```

```md
<!-- docs/runbooks/restore.md -->
# Restore Runbook

1. Provision a replacement Linux host with Docker and Docker Compose.
2. Copy `.env.production`, `docker-compose.yml`, `ops/caddy/Caddyfile`, and the latest database dump.
3. Start only PostgreSQL with `docker compose up -d db`.
4. Run `ops/backup/restore-from-dump.sh /path/to/latest.dump`.
5. Start `web` and `proxy` with `docker compose up -d`.
6. Validate login, add transaction, and records history access.
```

```md
<!-- docs/runbooks/home-network-checklist.md -->
# Home Network Checklist

1. Confirm a public domain already points to the home network or a DDNS target.
2. Confirm the ISP provides real inbound access or a working equivalent; if the site is behind carrier-grade NAT, stop and revise deployment.
3. Forward ports `80` and `443` from the router to the Linux host that runs `docker-compose.yml`.
4. Confirm only Caddy is exposed publicly; PostgreSQL must remain internal-only.
5. Validate HTTPS issuance by loading `https://<domain>` from a network outside the home LAN.
```

- [ ] **Step 5: Verify production assets and docs**

Run:
- `npm run build`
- `docker compose -f docker-compose.yml config`
- `bash ops/backup/pg_dump.sh ./tmp/backups`

Expected:
- Production build succeeds
- Compose config renders cleanly
- A dump file appears in `./tmp/backups`

- [ ] **Step 6: Commit**

```bash
git add src/app/manifest.ts public/icons Dockerfile docker-compose.yml ops docs/runbooks
git commit -m "feat: add pwa and production deployment assets"
```

## Task 9: Close the Loop with E2E Coverage and a Launch Gate

**Files:**
- Create: `tests/e2e/create-expense.spec.ts`
- Create: `tests/e2e/create-income.spec.ts`
- Create: `tests/e2e/home-drilldown.spec.ts`
- Modify: `docs/runbooks/restore.md`

- [ ] **Step 1: Write the three required failing end-to-end tests**

```ts
// tests/e2e/create-expense.spec.ts
import { test, expect } from "@playwright/test";

test("login and create an expense", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(process.env.E2E_USER_A_EMAIL!);
  await page.getByLabel("Password").fill(process.env.E2E_USER_A_PASSWORD!);
  await page.getByRole("button", { name: "Log in" }).click();
  await page.getByRole("link", { name: "Add" }).click();
  await page.getByPlaceholder("0.00").fill("18.80");
  await page.getByRole("button", { name: "Dining" }).click();
  await page.getByRole("button", { name: "Save transaction" }).click();
  await expect(page.getByText("18.80")).toBeVisible();
});
```

```ts
// tests/e2e/create-income.spec.ts
import { test, expect } from "@playwright/test";

test("login and create an income", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(process.env.E2E_USER_B_EMAIL!);
  await page.getByLabel("Password").fill(process.env.E2E_USER_B_PASSWORD!);
  await page.getByRole("button", { name: "Log in" }).click();
  await page.getByRole("link", { name: "Add" }).click();
  await page.getByLabel("Income").check();
  await page.getByPlaceholder("0.00").fill("1200");
  await page.getByRole("button", { name: "Salary" }).click();
  await page.getByRole("button", { name: "Save transaction" }).click();
  await expect(page.getByText("1200.00")).toBeVisible();
});
```

```ts
// tests/e2e/home-drilldown.spec.ts
import { test, expect } from "@playwright/test";

test("home totals drill down to matching records", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(process.env.E2E_USER_A_EMAIL!);
  await page.getByLabel("Password").fill(process.env.E2E_USER_A_PASSWORD!);
  await page.getByRole("button", { name: "Log in" }).click();
  const expenseCard = page.getByRole("link", { name: /Expense/ });
  const amount = await expenseCard.textContent();
  await expenseCard.click();
  await expect(page).toHaveURL(/\/records\?type=expense/);
  await expect(page.getByText(amount ?? "")).toBeVisible();
});
```

- [ ] **Step 2: Run the E2E specs to verify current gaps**

Run:
- `npm run test:e2e -- tests/e2e/create-expense.spec.ts`
- `npm run test:e2e -- tests/e2e/create-income.spec.ts`
- `npm run test:e2e -- tests/e2e/home-drilldown.spec.ts`

Expected: At least one FAIL until the last missing UX details are completed

- [ ] **Step 3: Fill the last UX gaps exposed by E2E**

```tsx
// representative finishing detail
<label className="sr-only" htmlFor="email">Email</label>
<input id="email" name="email" type="email" />
```

```tsx
// representative post-save affordance
{saved ? (
  <div className="rounded-2xl bg-emerald-50 p-4 text-sm text-emerald-800">
    Saved.
    <div className="mt-3 flex gap-3">
      <a className="rounded-xl border px-3 py-2" href="/add">Add another</a>
      <a className="rounded-xl bg-stone-900 px-3 py-2 text-white" href="/home">Return home</a>
    </div>
  </div>
) : null}
```

- [ ] **Step 4: Run the full verification suite**

Run:
- `npm run lint`
- `npm run test:unit`
- `npm run test:integration`
- `npm run test:e2e`
- `npm run build`
- `docker compose -f docker-compose.yml config`

Expected:
- All test suites pass
- Build succeeds
- Compose config stays valid

- [ ] **Step 5: Rehearse backup and restore before calling production ready**

Run:
- `bash ops/backup/pg_dump.sh ./tmp/backups`
- `docker compose -f docker-compose.yml up -d db`
- `bash ops/backup/restore-from-dump.sh ./tmp/backups/<latest-file>.dump`

Expected:
- Backup completes
- Restore completes
- The restored database supports login, create transaction, and history access

- [ ] **Step 6: Commit**

```bash
git add tests/e2e docs/runbooks/restore.md src
git commit -m "test: add launch gate verification"
```

## Self-Review

### Spec Coverage

- Scope/goals and architecture: Tasks 1, 2, 8
- Core entities and business rules: Tasks 2, 3, 5, 6
- UX/navigation (`Home`, `Add`, `Records`): Tasks 4, 5, 6, 7
- Reporting and drill-down: Task 7
- PWA, security baseline, deployment, backups, recovery: Tasks 3, 8, 9
- Required unit/integration/E2E strategy: Tasks 2, 3, 5, 6, 7, 9

### Gaps

- No code task automates router/domain/public-ingress verification because that is a real-world environment constraint, not an app feature. It is intentionally covered by `docs/runbooks/home-network-checklist.md` and the production rehearsal in Tasks 8 and 9.

### Placeholder Scan

- No `TODO`, `TBD`, or “handle appropriately” placeholders remain.
- The plan intentionally excludes offline sync, native apps, budgets, account balances, transfers, attachments, OCR, and multi-household UI.

### Type and Naming Consistency

- Perspective values stay `household | me | spouse`.
- Transaction form values stay lowercase `income | expense`; database enums stay uppercase `INCOME | EXPENSE`.
- The two reporting identifiers remain `actorMemberId` and `createdByMemberId` throughout.
