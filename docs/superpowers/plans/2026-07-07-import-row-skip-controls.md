# Import Row Skip Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users mark individual import draft rows as not imported, including rows that still need category mapping, without blocking confirmation.

**Architecture:** Reuse the existing `ImportRowDecision` and `USER_SKIPPED` state. Service logic treats user-skipped rows as excluded from missing mapping, member mapping, and confirmation checks; the import page adds a capped row-detail decision form for pending drafts and a completed summary.

**Tech Stack:** Next.js App Router server components/actions, Prisma, Vitest integration tests, Playwright e2e if UI flow coverage changes.

---

### Task 1: Service State Machine

**Files:**
- Modify: `tests/integration/import-drafts.test.ts`
- Modify: `src/lib/imports/drafts.ts`

- [ ] **Step 1: Add failing service tests**

Add tests under `describe("import draft services", () => { ... })`:

```ts
it("allows skipping a row that still needs category mapping and confirms the rest", async () => {
  const { sessionUser } = await createHouseholdFixture();
  const draft = await services.createSuiShouJiImportDraft({
    buffer: await buildExpenseIncomeWorkbook(),
    fileName: "skip-unmapped.xlsx",
    sessionUser,
  });
  const initialSummary = await services.getImportDraftSummary(draft.id, sessionUser);
  const expenseRow = initialSummary.rows.find(
    (row) => row.mappingKey === "sui_shou_ji|EXPENSE|餐饮|三餐",
  );

  await services.setImportDraftRowDecision(
    draft.id,
    expenseRow!.id,
    ImportRowDecision.SKIP,
    sessionUser,
  );

  const skippedSummary = await services.getImportDraftSummary(draft.id, sessionUser);
  expect(skippedSummary.counts.needsMapping).toBe(1);
  expect(skippedSummary.counts.userSkipped).toBe(1);
  expect(skippedSummary.missingMappings.map((mapping) => mapping.mappingKey)).toEqual([
    "sui_shou_ji|INCOME|职业收入|工资",
  ]);

  const { incomeCategory } = await getSeededCategories();
  await services.saveImportDraftMappings(
    draft.id,
    [{ categoryId: incomeCategory.id, mappingKey: "sui_shou_ji|INCOME|职业收入|工资" }],
    sessionUser,
  );

  const result = await services.confirmImportDraft(draft.id, sessionUser);
  expect(result).toMatchObject({ createdCount: 1, needsMappingCount: 0, userSkippedCount: 1 });
});

it("restores a skipped needs-mapping row back to needs mapping", async () => {
  const { sessionUser } = await createHouseholdFixture();
  const draft = await services.createSuiShouJiImportDraft({
    buffer: await buildExpenseWorkbook(),
    fileName: "restore-unmapped.xlsx",
    sessionUser,
  });
  const summary = await services.getImportDraftSummary(draft.id, sessionUser);

  await services.setImportDraftRowDecision(
    draft.id,
    summary.rows[0]!.id,
    ImportRowDecision.SKIP,
    sessionUser,
  );
  await services.setImportDraftRowDecision(
    draft.id,
    summary.rows[0]!.id,
    ImportRowDecision.KEEP,
    sessionUser,
  );

  const restoredSummary = await services.getImportDraftSummary(draft.id, sessionUser);
  expect(restoredSummary.rows[0]).toMatchObject({
    status: ImportDraftRowStatus.NEEDS_MAPPING,
    userDecision: ImportRowDecision.KEEP,
  });
  expect(restoredSummary.missingMappings).toHaveLength(1);
});

it("does not let saved mappings override a user skipped row", async () => {
  const { sessionUser } = await createHouseholdFixture();
  const { expenseCategory } = await getSeededCategories();
  const draft = await services.createSuiShouJiImportDraft({
    buffer: await buildExpenseWorkbook(),
    fileName: "skip-then-map.xlsx",
    sessionUser,
  });
  const summary = await services.getImportDraftSummary(draft.id, sessionUser);

  await services.setImportDraftRowDecision(
    draft.id,
    summary.rows[0]!.id,
    ImportRowDecision.SKIP,
    sessionUser,
  );
  await services.saveImportDraftMappings(
    draft.id,
    [{ categoryId: expenseCategory.id, mappingKey: "sui_shou_ji|EXPENSE|餐饮|三餐" }],
    sessionUser,
  );

  const mappedSummary = await services.getImportDraftSummary(draft.id, sessionUser);
  expect(mappedSummary.rows[0]).toMatchObject({
    categoryId: null,
    status: ImportDraftRowStatus.USER_SKIPPED,
    userDecision: ImportRowDecision.SKIP,
  });
});
```

- [ ] **Step 2: Run focused service tests and verify RED**

Run: `npm run test:integration -- tests/integration/import-drafts.test.ts`

Expected: FAIL because `NEEDS_MAPPING` and `READY` row decisions cannot be changed yet, skipped `NEEDS_MAPPING` rows still count as blocking mappings, and mapping updates can touch skipped rows.

- [ ] **Step 3: Update service logic minimally**

In `src/lib/imports/drafts.ts`:
- Count missing mappings only for `KEEP` rows.
- Count unresolved member mappings only for `KEEP` rows.
- Let `setImportDraftRowDecision` accept `READY`, `POSSIBLE_DUPLICATE`, `NEEDS_MAPPING`, and `USER_SKIPPED`.
- When restoring `KEEP`, return to `NEEDS_MAPPING` if `categoryId` is absent, otherwise `POSSIBLE_DUPLICATE` if duplicate candidates exist, otherwise `READY`.
- In `updateDraftRowsForMapping`, update only `NEEDS_MAPPING` rows whose `userDecision` is `KEEP`.
- In member owner/mapping bulk updates, exclude `USER_SKIPPED`.

- [ ] **Step 4: Run focused service tests and verify GREEN**

Run: `npm run test:integration -- tests/integration/import-drafts.test.ts`

Expected: PASS for import draft service tests.

### Task 2: Import Page Row Decisions

**Files:**
- Modify: `tests/integration/import-page-and-actions.test.ts`
- Modify: `src/app/(app)/records/import/page.tsx`
- Modify: `src/lib/i18n.ts`

- [ ] **Step 1: Add failing page tests**

Add tests that render a pending draft with `READY`, `NEEDS_MAPPING`, `POSSIBLE_DUPLICATE`, `USER_SKIPPED`, `SOURCE_DUPLICATE`, and `INVALID` rows. Assert:
- The page shows a “待导入明细” / “Import rows” section.
- Decision inputs render for the four user-changeable row states.
- Decision inputs do not render for `SOURCE_DUPLICATE` and `INVALID`.
- Labels are “导入” and “不导入”.
- Rows beyond 100 are not rendered and a hidden-count message is shown.

- [ ] **Step 2: Run focused page tests and verify RED**

Run: `npm run test:integration -- tests/integration/import-page-and-actions.test.ts`

Expected: FAIL because the row-detail decision section and new labels do not exist yet.

- [ ] **Step 3: Implement row-detail decision section**

In `src/app/(app)/records/import/page.tsx`:
- Add `reviewableRowLimit = 100`.
- Derive `reviewableRows` from `READY`, `NEEDS_MAPPING`, `POSSIBLE_DUPLICATE`, and `USER_SKIPPED`.
- Render a single `saveImportDecisions` form with row number, time, amount, type, category text, member ids/names when available, note, status label, and `ImportRowDecision.KEEP/SKIP` radio buttons.
- Keep duplicate candidate detail display as read-only context, but avoid a second decision form for the same rows.
- Show the hidden row count with text that unshown rows keep their current status.

In `src/lib/i18n.ts`:
- Add Chinese and English keys for row details title, description, hidden count, status labels, `importRowDecision`, and `doNotImportRowDecision`.

- [ ] **Step 4: Run focused page tests and verify GREEN**

Run: `npm run test:integration -- tests/integration/import-page-and-actions.test.ts`

Expected: PASS for import page tests.

### Task 3: Completed Summary

**Files:**
- Modify: `tests/integration/import-page-and-actions.test.ts`
- Modify: `src/app/(app)/records/import/page.tsx`
- Modify: `src/lib/i18n.ts`

- [ ] **Step 1: Add failing completed-summary test**

Update the completed draft render test to assert the completed panel includes counts for importable/created proxy, skipped, source duplicate, and invalid rows using the existing summary counts.

- [ ] **Step 2: Run focused page tests and verify RED**

Run: `npm run test:integration -- tests/integration/import-page-and-actions.test.ts`

Expected: FAIL because the completed panel currently only shows title, description, and back link.

- [ ] **Step 3: Render completed counts**

In the completed branch of `src/app/(app)/records/import/page.tsx`, render a compact count grid using `summary.counts.importable`, `summary.counts.userSkipped`, `summary.counts.sourceDuplicate`, and `summary.counts.invalid`. In `src/lib/i18n.ts`, add a label that says completed importable count represents rows imported or retained by the completed draft.

- [ ] **Step 4: Run focused page tests and verify GREEN**

Run: `npm run test:integration -- tests/integration/import-page-and-actions.test.ts`

Expected: PASS for completed summary tests.

### Task 4: Verification And Security Review

**Files:**
- Read: `skills/billboard-security-review/SKILL.md`

- [ ] **Step 1: Run targeted checks**

Run:
- `npm run test:integration -- tests/integration/import-drafts.test.ts`
- `npm run test:integration -- tests/integration/import-page-and-actions.test.ts`
- `npm run test:unit`
- `npm run lint`

Expected: all selected checks pass. If e2e surface changes are substantial, run `npm run test:e2e -- tests/e2e/import-sui-shou-ji.spec.ts`.

- [ ] **Step 2: Run security review**

Read `skills/billboard-security-review/SKILL.md` and apply it to the diff. Check that no credentials, real domains, IPs, private URLs, or production routing details were added, and that household access remains derived from session data.

- [ ] **Step 3: Report status**

Final response includes:
- Changed behavior.
- Verification commands and actual results.
- Security review sections: Findings, Verification, Residual Risk.
