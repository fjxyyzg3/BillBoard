# Add Success Toast Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the bulky add-transaction success panel with a lightweight top toast that shows the saved transaction type and amount, then auto-hides after 2.5 seconds.

**Architecture:** Keep the existing server redirect and URL parameter flow. `src/app/(app)/add/page.tsx` continues to derive success text from `created`, `type`, and `amountFen`; `src/components/transaction-form.tsx` only changes the presentation from an inline panel with links to a fixed toast with local visibility state.

**Tech Stack:** Next.js App Router, React client component state/effects, Tailwind CSS, Playwright E2E tests.

---

### Task 1: Update E2E Expectations First

**Files:**
- Modify: `tests/e2e/create-expense.spec.ts`
- Modify: `tests/e2e/create-income.spec.ts`
- Modify: `tests/integration/create-transaction.test.ts`

- [ ] **Step 1: Change the expense success assertions**

Replace the old link visibility assertions in `tests/e2e/create-expense.spec.ts` with assertions that the saved detail is visible and the redundant links are absent:

```ts
  await expect(page.getByText("支出：12.34")).toBeVisible();
  await expect(page.getByRole("link", { name: "再记一笔" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "返回首页" })).toHaveCount(0);
```

- [ ] **Step 2: Change the income success assertions**

Replace the old link visibility assertions in `tests/e2e/create-income.spec.ts` with assertions that the saved detail is visible and the redundant links are absent:

```ts
  await expect(page.getByText("收入：4,321.09")).toBeVisible();
  await expect(page.getByRole("link", { name: "再记一笔" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "返回首页" })).toHaveCount(0);
```

- [ ] **Step 3: Run the focused E2E tests and verify RED**

- [ ] **Step 3: Update the source-level integration assertion**

Replace the old assertion that required add-another and return-home links with an assertion that requires the toast implementation and rejects the old link props:

```ts
  it("uses a lightweight toast without follow-up action links after a successful save", () => {
    const source = readFileSync(
      path.resolve(process.cwd(), "src/components/transaction-form.tsx"),
      "utf8",
    );

    expect(source).toContain("function SuccessToast");
    expect(source).toContain("window.setTimeout");
    expect(source).toContain("2500");
    expect(source).not.toContain("labels.common.addAnother");
    expect(source).not.toContain("href={nextAddHref}");
    expect(source).not.toContain("labels.common.returnHome");
    expect(source).not.toContain("href={homeHref}");
  });
```

- [ ] **Step 4: Run the focused E2E tests and verify RED**

Run:

```bash
npm run test:e2e -- tests/e2e/create-expense.spec.ts tests/e2e/create-income.spec.ts
```

Expected: FAIL because the current implementation still renders the two links.

### Task 2: Replace the Success Panel with a Toast

**Files:**
- Modify: `src/components/transaction-form.tsx`

- [ ] **Step 1: Remove unused navigation props and import**

Remove `Link` from imports. Remove `homeHref` and `nextAddHref` from `TransactionFormProps` and from the component parameter destructuring.

- [ ] **Step 2: Add a local success toast component**

Import `useEffect` from React and add a file-local toast component. The component starts visible on mount and only changes state inside the timeout callback, which keeps it compatible with React hook lint rules:

```tsx
function SuccessToast({ detail, message }: { detail?: string; message: string }) {
  const [isVisible, setIsVisible] = useState(true);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setIsVisible(false);
    }, 2500);

    return () => window.clearTimeout(timeoutId);
  }, []);

  if (!isVisible) {
    return null;
  }

  return (
    <div
      aria-live="polite"
      className="fixed left-4 right-4 top-[calc(env(safe-area-inset-top)+1rem)] z-50 mx-auto max-w-md rounded-2xl border border-emerald-200 bg-white/95 px-4 py-3 text-sm text-emerald-800 shadow-[0_12px_32px_rgba(15,23,42,0.16)] backdrop-blur"
      role="status"
    >
      <p className="font-medium">{message}</p>
      {detail ? <p>{detail}</p> : null}
    </div>
  );
}
```

- [ ] **Step 3: Replace inline success panel markup**

Replace the existing success panel block with a top fixed toast:

```tsx
      {successMessage && state.status === "idle" ? (
        <SuccessToast
          detail={successDetail}
          key={`${successMessage}-${successDetail ?? ""}`}
          message={successMessage}
        />
      ) : null}
```

### Task 3: Clean Up Add Page Props

**Files:**
- Modify: `src/app/(app)/add/page.tsx`

- [ ] **Step 1: Remove unused href imports and props**

If `TransactionForm` no longer accepts navigation props, remove `buildAppHref`, `sharedParamReader`, `homeHref`, and `nextAddHref` usage that only existed for the success links. Keep `sharedFilters` so the server action still preserves `perspective` and `range`.

### Task 4: Verify

**Files:**
- Test: `tests/e2e/create-expense.spec.ts`
- Test: `tests/e2e/create-income.spec.ts`
- Test: `src/components/transaction-form.tsx`
- Test: `src/app/(app)/add/page.tsx`

- [ ] **Step 1: Run the focused E2E tests and verify GREEN**

Run:

```bash
npm run test:e2e -- tests/e2e/create-expense.spec.ts tests/e2e/create-income.spec.ts
```

Expected: PASS.

- [ ] **Step 2: Run lint**

Run:

```bash
npm run lint
```

Expected: PASS with no lint errors.
