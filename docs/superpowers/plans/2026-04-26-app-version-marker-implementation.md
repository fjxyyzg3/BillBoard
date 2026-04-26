# App Version Marker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show BillBoard's app version in the authenticated UI and maintain the version in `package.json` as `0.1.0`.

**Architecture:** `package.json` is the maintained version source. The server-side `AppShell` reads the package version, formats it with a small helper, and passes the resulting label into the existing desktop and mobile navigation components as a string prop.

**Tech Stack:** Next.js App Router, React 19, TypeScript, Vitest, ESLint.

---

## Scope Check

The approved spec covers one small subsystem: app version metadata and display. It does not include deployment tags, Git tags, release notes, CI injection, or Docker image tagging.

## File Structure

- Modify: `package.json` - add the maintained app version.
- Modify: `package-lock.json` - keep npm lock metadata consistent with `package.json`.
- Create: `src/lib/app-version.ts` - format raw package versions for display.
- Create: `tests/unit/app-version.test.ts` - verify version label formatting.
- Create: `tests/unit/navigation-version-marker.test.tsx` - verify both navigation components render the supplied version label.
- Modify: `src/components/app-shell.tsx` - read the package version on the server side and pass a formatted label to navigation.
- Modify: `src/components/desktop-nav.tsx` - render the desktop version marker.
- Modify: `src/components/bottom-nav.tsx` - render the mobile version marker.

### Task 1: Version Metadata And Formatter

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/lib/app-version.ts`
- Create: `tests/unit/app-version.test.ts`

- [ ] **Step 1: Write the failing formatter test**

Create `tests/unit/app-version.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { formatAppVersion } from "@/lib/app-version";

describe("formatAppVersion", () => {
  it("prefixes a package version for display", () => {
    expect(formatAppVersion("0.1.0")).toBe("v0.1.0");
  });

  it("falls back to v0.0.0 when the package version is empty", () => {
    expect(formatAppVersion("")).toBe("v0.0.0");
    expect(formatAppVersion(undefined)).toBe("v0.0.0");
  });
});
```

- [ ] **Step 2: Run the formatter test to verify it fails**

Run:

```bash
npm run test:unit -- tests/unit/app-version.test.ts
```

Expected: FAIL because `@/lib/app-version` does not exist.

- [ ] **Step 3: Add the app version metadata**

Update the top of `package.json` to include `version` after `name`:

```json
{
  "name": "billboard",
  "version": "0.1.0",
  "private": true,
  "scripts": {
```

Update the top of `package-lock.json` to keep lock metadata consistent:

```json
{
  "name": "billboard",
  "version": "0.1.0",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": {
      "name": "billboard",
      "version": "0.1.0",
      "dependencies": {
```

- [ ] **Step 4: Add the formatter implementation**

Create `src/lib/app-version.ts`:

```ts
export function formatAppVersion(version: string | undefined) {
  const normalizedVersion = version?.trim() || "0.0.0";

  return `v${normalizedVersion}`;
}
```

- [ ] **Step 5: Run the formatter test to verify it passes**

Run:

```bash
npm run test:unit -- tests/unit/app-version.test.ts
```

Expected: PASS for both `formatAppVersion` tests.

- [ ] **Step 6: Commit Task 1**

Run:

```bash
git add package.json package-lock.json src/lib/app-version.ts tests/unit/app-version.test.ts
git commit -m "feat: add app version metadata"
```

Expected: commit succeeds.

### Task 2: Navigation Version Markers

**Files:**
- Modify: `src/components/desktop-nav.tsx`
- Modify: `src/components/bottom-nav.tsx`
- Create: `tests/unit/navigation-version-marker.test.tsx`

- [ ] **Step 1: Write the failing navigation render test**

Create `tests/unit/navigation-version-marker.test.tsx`:

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BottomNav } from "@/components/bottom-nav";
import { DesktopNav } from "@/components/desktop-nav";

vi.mock("next/navigation", () => ({
  usePathname: () => "/home",
}));

vi.mock("@/components/app-filters-provider", () => ({
  useAppFilters: () => ({
    buildHref: (pathname: string) => pathname,
    navigateTo: () => undefined,
  }),
}));

describe("navigation version markers", () => {
  it("renders the version marker in desktop and mobile navigation", () => {
    const desktopMarkup = renderToStaticMarkup(<DesktopNav versionLabel="v0.1.0" />);
    const mobileMarkup = renderToStaticMarkup(<BottomNav versionLabel="v0.1.0" />);

    expect(desktopMarkup).toContain("v0.1.0");
    expect(mobileMarkup).toContain("v0.1.0");
  });
});
```

- [ ] **Step 2: Run the navigation test to verify it fails**

Run:

```bash
npm run test:unit -- tests/unit/navigation-version-marker.test.tsx
```

Expected: FAIL because the current navigation components do not render `v0.1.0`.

- [ ] **Step 3: Update desktop navigation**

Replace `src/components/desktop-nav.tsx` with:

```tsx
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAppFilters } from "@/components/app-filters-provider";

const items = [
  { href: "/home", label: "Home" },
  { href: "/add", label: "Add" },
  { href: "/records", label: "Records" },
] as const;

type DesktopNavProps = {
  versionLabel: string;
};

export function DesktopNav({ versionLabel }: DesktopNavProps) {
  const pathname = usePathname();
  const { buildHref, navigateTo } = useAppFilters();

  return (
    <aside className="hidden w-64 shrink-0 border-r border-stone-200 bg-white md:flex md:flex-col">
      <div className="border-b border-stone-200 px-6 py-6">
        <p className="text-lg font-semibold text-stone-900">BillBoard</p>
        <p className="mt-1 text-sm text-stone-500">Household accounting</p>
      </div>
      <nav className="flex-1 space-y-2 px-4 py-6">
        {items.map((item) => {
          const isActive = pathname === item.href;

          return (
            <Link
              key={item.href}
              aria-current={isActive ? "page" : undefined}
              className={`block rounded-2xl px-4 py-3 text-sm ${
                isActive
                  ? "bg-stone-900 text-white"
                  : "text-stone-600 transition hover:bg-stone-100 hover:text-stone-900"
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
              {item.label}
            </Link>
          );
        })}
      </nav>
      <p className="px-6 pb-6 text-xs text-stone-400">{versionLabel}</p>
    </aside>
  );
}
```

- [ ] **Step 4: Update mobile navigation**

Replace `src/components/bottom-nav.tsx` with:

```tsx
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAppFilters } from "@/components/app-filters-provider";

const items = [
  { href: "/home", label: "Home" },
  { href: "/add", label: "Add" },
  { href: "/records", label: "Records" },
] as const;

type BottomNavProps = {
  versionLabel: string;
};

export function BottomNav({ versionLabel }: BottomNavProps) {
  const pathname = usePathname();
  const { buildHref, navigateTo } = useAppFilters();

  return (
    <nav className="fixed inset-x-0 bottom-0 border-t border-stone-200 bg-white/95 backdrop-blur md:hidden">
      <p className="border-b border-stone-100 px-4 py-1 text-center text-[0.625rem] leading-none text-stone-400">
        {versionLabel}
      </p>
      <ul className="mx-auto grid max-w-6xl grid-cols-3">
        {items.map((item) => {
          const isActive = pathname === item.href;

          return (
            <li key={item.href}>
              <Link
                aria-current={isActive ? "page" : undefined}
                className={`flex justify-center px-4 py-3 text-sm ${
                  isActive ? "font-semibold text-stone-900" : "text-stone-500"
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
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
```

- [ ] **Step 5: Run the navigation test to verify it passes**

Run:

```bash
npm run test:unit -- tests/unit/navigation-version-marker.test.tsx
```

Expected: PASS for the desktop and mobile marker assertions.

- [ ] **Step 6: Commit Task 2**

Run:

```bash
git add src/components/desktop-nav.tsx src/components/bottom-nav.tsx tests/unit/navigation-version-marker.test.tsx
git commit -m "feat: show version in navigation"
```

Expected: commit succeeds.

### Task 3: App Shell Wiring And Final Verification

**Files:**
- Modify: `src/components/app-shell.tsx`

- [ ] **Step 1: Wire the package version into the app shell**

Replace `src/components/app-shell.tsx` with:

```tsx
import type { ReactNode } from "react";
import packageJson from "../../package.json";
import { AppFiltersProvider } from "@/components/app-filters-provider";
import { BottomNav } from "@/components/bottom-nav";
import { DesktopNav } from "@/components/desktop-nav";
import { formatAppVersion } from "@/lib/app-version";

type AppShellProps = {
  children: ReactNode;
};

export function AppShell({ children }: AppShellProps) {
  const versionLabel = formatAppVersion(packageJson.version);

  return (
    <AppFiltersProvider>
      <div className="mx-auto flex min-h-screen w-full max-w-6xl md:flex-row">
        <DesktopNav versionLabel={versionLabel} />
        <div className="flex min-h-screen flex-1 flex-col">
          <main className="flex-1 px-4 pb-24 pt-6 md:px-8 md:py-8">{children}</main>
          <BottomNav versionLabel={versionLabel} />
        </div>
      </div>
    </AppFiltersProvider>
  );
}
```

- [ ] **Step 2: Run all new unit tests**

Run:

```bash
npm run test:unit -- tests/unit/app-version.test.ts tests/unit/navigation-version-marker.test.tsx
```

Expected: PASS for formatter and navigation marker tests.

- [ ] **Step 3: Run lint**

Run:

```bash
npm run lint
```

Expected: PASS with zero warnings.

- [ ] **Step 4: Run the production build**

Run:

```bash
npm run build
```

Expected: PASS. This confirms the server component can import `package.json` and pass the formatted version label into client navigation components.

- [ ] **Step 5: Commit Task 3**

Run:

```bash
git add src/components/app-shell.tsx
git commit -m "feat: wire app version into shell"
```

Expected: commit succeeds.

## Final Verification

- Run `git status --short`.
- Expected: no uncommitted changes.
- Confirm the final commit history includes:
  - `feat: add app version metadata`
  - `feat: show version in navigation`
  - `feat: wire app version into shell`

