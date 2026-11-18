# Alipay Refund Netting Implementation Plan

> **For agentic workers:** REQUIRED SKILL: Use implement to execute this plan task-by-task. Respect the handed-off git_state: inherit prepared, otherwise prepare; use git-workflow for checkpoint/finalize. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Net strictly matched Alipay refunds during CSV import so partial refunds create one reduced expense and full refunds are visibly, immutably skipped.

**Scope Source:** `docs/scope/2026-08-26-alipay-refund-netting.md`

**Architecture:** The Alipay parser classifies raw rows and collapses refund groups before producing generic import rows. The draft layer combines parser disposition with historical fingerprint amounts to persist existing statuses plus stable reason codes; the import page renders those codes as localized, read-only notices.

**Tech Stack:** TypeScript, Next.js server components/actions, Prisma, Vitest, Playwright

**Verification:** `npm run lint`, `npm run test:unit`, `npm run test:integration`, `npm run test:e2e`

---

### Task 1: Parse and net strict Alipay refund groups

**Files:**
- Modify: `src/lib/imports/types.ts`
- Modify: `src/lib/imports/sources/alipay.ts`
- Test: `tests/unit/alipay-import.test.ts`

**Acceptance:** The parser groups only orders containing strict successful refunds, aggregates integer-fen refunds independent of row order, emits one partial/full disposition row, and leaves ordinary same-order payments unchanged.

- [x] **Step 1: Add failing parser tests**

Add synthetic rows and assertions for:

```ts
expect(partial.rows[0]).toMatchObject({
  amountFen: 65,
  refundHandling: "ALIPAY_PARTIAL",
  transactionType: TransactionType.EXPENSE,
});
expect(full.rows[0]).toMatchObject({
  amountFen: 180,
  refundHandling: "ALIPAY_FULL",
});
```

Cover multiple refunds, refund-before-payment order, full refund, over-refund, missing/unmatched order id, multiple payments with a successful refund, non-strict refund statuses, invalid group data, and multiple ordinary payments sharing an order id without a successful refund.

- [x] **Step 2: Run the focused unit test and verify RED**

Run: `npm run test:unit -- tests/unit/alipay-import.test.ts`

Expected: FAIL because refund groups are not netted and `refundHandling` does not exist.

- [x] **Step 3: Add the minimal parser contract and implementation**

Add optional `refundHandling: "ALIPAY_PARTIAL" | "ALIPAY_FULL"` to `ParsedImportRow`. In `alipay.ts`, parse all raw records first, identify refunds only when direction/category/status exactly match the approved contract, group only their non-empty merchant order ids, and collapse valid groups through the existing amount/date/category/fingerprint conversion. Use the original payment fields and fingerprint; use the original amount for the full-refund preview row and the net amount for partial refunds. Emit stable invalid reasons for unmatched and ambiguous groups without exposing raw order ids.

- [x] **Step 4: Run the focused unit test and verify GREEN**

Run: `npm run test:unit -- tests/unit/alipay-import.test.ts`

Expected: PASS.

- [x] **Step 5: Run import parser regressions**

Run: `npm run test:unit`

Expected: PASS for Alipay, WeChat Pay, Sui Shou Ji, CMB, privacy, and i18n unit suites.

- [x] **Step 6: Git checkpoint**

Invoke `git-workflow` checkpoint for the Task 1 source and unit-test files. Expected result under current preferences: no commit; record that the task waits for the single final feature commit.

### Task 2: Classify historical duplicates and lock full refunds

**Files:**
- Modify: `src/lib/imports/types.ts`
- Modify: `src/lib/imports/drafts.ts`
- Test: `tests/integration/import-drafts.test.ts`

**Acceptance:** Draft creation distinguishes equal historical net amounts from changed refund amounts, includes soft-deleted history, persists approved status/reason combinations, rejects forged KEEP decisions for full refunds, and confirms only importable net expenses.

- [x] **Step 1: Add failing draft integration tests**

Use synthetic Alipay CSV fixtures to assert:

```ts
expect(fullRow).toMatchObject({
  status: ImportDraftRowStatus.USER_SKIPPED,
  userDecision: ImportRowDecision.SKIP,
  skipReason: ALIPAY_FULLY_REFUNDED,
});
await expect(
  setImportDraftRowDecision(draft.id, fullRow.id, ImportRowDecision.KEEP, sessionUser),
).rejects.toThrow("Import draft row decision cannot be changed");
```

Also cover first partial import, historical original amount mismatch, equal historical net amount, increased cumulative refund, full refund with history, soft-deleted history, summary counts, confirmation transaction count, and no cross-household fingerprint matching.

- [x] **Step 2: Run focused integration tests and verify RED**

Run: `npm run test:integration -- tests/integration/import-drafts.test.ts`

Expected: FAIL because the draft lookup returns only a fingerprint set and full-refund rows are still editable.

- [x] **Step 3: Implement stable reason codes and amount-aware draft classification**

Export `ALIPAY_FULLY_REFUNDED` and `ALIPAY_REFUND_REQUIRES_MANUAL_ADJUSTMENT` constants from `types.ts`. Replace the draft-creation fingerprint set lookup with a chunked map of fingerprint to historical `amountFen`, scoped by session household and source without `deletedAt: null`. Update parsed-row creation so:

```text
no history + partial -> normal mapping/duplicate flow
no history + full -> USER_SKIPPED / SKIP / ALIPAY_FULLY_REFUNDED
history + partial + equal amount -> SOURCE_DUPLICATE / SKIP / ordinary duplicate reason
history + partial + different amount -> SOURCE_DUPLICATE / SKIP / manual-adjustment reason
history + full -> SOURCE_DUPLICATE / SKIP / manual-adjustment reason
```

Reject KEEP in `setImportDraftRowDecision` when `skipReason` is `ALIPAY_FULLY_REFUNDED`; preserve existing editable CMB/default-skip behavior. Keep confirm-time insertion idempotent and batch-based.

- [x] **Step 4: Run focused integration tests and verify GREEN**

Run: `npm run test:integration -- tests/integration/import-drafts.test.ts`

Expected: PASS.

- [x] **Step 5: Run all integration regressions**

Run: `npm run test:integration`

Expected: PASS, including import permissions, mappings, duplicate handling, and batch confirmation.

- [x] **Step 6: Git checkpoint**

Invoke `git-workflow` checkpoint for Task 2 files. Expected result: no commit under the single-final-commit preference.

### Task 3: Render localized, read-only refund outcomes

**Files:**
- Modify: `src/app/(app)/records/import/page.tsx`
- Modify: `src/lib/i18n.ts`
- Test: `tests/unit/i18n.test.ts`
- Test: `tests/integration/import-page-and-actions.test.ts`

**Acceptance:** Full refunds and manual-adjustment conflicts are visibly explained in both locales, full refunds have no KEEP/SKIP controls, counts retain existing status semantics, and bulk form submission cannot bypass the draft service.

- [x] **Step 1: Add failing i18n and page tests**

Assert Chinese and English labels for both stable reason codes. Render an Alipay summary containing a full-refund row and a manual-adjustment source-duplicate row; assert localized reason text, original full-refund amount/date/category, absence of `decision:<locked-row-id>` inputs, and unchanged `userSkipped`/`sourceDuplicate` counts. Retain the existing action test proving every submitted decision calls `setImportDraftRowDecision`.

- [x] **Step 2: Run focused tests and verify RED**

Run: `npm run test:unit -- tests/unit/i18n.test.ts`

Run: `npm run test:integration -- tests/integration/import-page-and-actions.test.ts`

Expected: FAIL because refund reason messages and locked-row rendering do not exist.

- [x] **Step 3: Implement reason localization and locked preview rendering**

Add bilingual reason labels to `src/lib/i18n.ts`. In the import page, classify locked refund rows from persisted `status` and `skipReason`, exclude fully refunded rows from editable review rows, and render a non-interactive notice panel. Keep normal `USER_SKIPPED` rows editable and normal source duplicates unchanged. Do not render merchant order ids, fingerprints, accounts, or raw refund details.

- [x] **Step 4: Run focused tests and verify GREEN**

Run: `npm run test:unit -- tests/unit/i18n.test.ts`

Run: `npm run test:integration -- tests/integration/import-page-and-actions.test.ts`

Expected: PASS.

- [x] **Step 5: Run unit and integration regressions**

Run: `npm run test:unit`

Run: `npm run test:integration`

Expected: PASS.

- [x] **Step 6: Git checkpoint**

Invoke `git-workflow` checkpoint for Task 3 files. Expected result: no commit under the single-final-commit preference.

### Task 4: Prove the end-to-end flow and prepare the feature release

**Files:**
- Modify: `tests/e2e/import-alipay.spec.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Verify: `prisma/schema.prisma`
- Verify: all task-owned source, test, spec, plan, and Git preference files

**Acceptance:** A synthetic version of the supplied partial-refund scenario imports one ¥0.65 expense, full refunds remain skipped in the UI, all repository checks pass, the version is `1.29.0`, and security review finds no blocking issue.

- [x] **Step 1: Add the Alipay refund E2E scenarios**

Extend the synthetic CSV fixture so one test uploads a ¥1.80 payment plus ¥1.15 successful refund with the same merchant order id, maps the original category, confirms import, and observes only ¥0.65 in records. Add a full-refund preview assertion for the localized locked-skip notice and absence of a KEEP control. Never use the supplied attachment or its real identifiers.

- [x] **Step 2: Run focused E2E verification**

Run: `npm run test:e2e -- tests/e2e/import-alipay.spec.ts`

Expected: PASS.

- [x] **Step 3: Update the feature version**

Change the root package version from `1.28.0` to `1.29.0` in `package.json` and the root project entries in `package-lock.json`. Do not change dependencies.

- [x] **Step 4: Run complete required verification**

Run in order:

```text
npm run lint
npm run test:unit
npm run test:integration
npm run test:e2e
```

Expected: all commands exit 0.

- [x] **Step 5: Run BillBoard security review**

Use `skills/billboard-security-review/SKILL.md`. Inspect the exact task diff; verify household-scoped historical lookup, soft-delete dedupe semantics, integer-fen netting, `Asia/Shanghai`, server-side locked decisions, absence of schema changes, absence of real attachment identifiers/credentials/hosts, and no new dependency. Report Findings, Verification, and Residual Risk.

- [x] **Step 6: Final Git workflow and production smoke check**

Invoke `git-workflow` finalize with the true verification result. When complete: create one `v1.29.0` feature commit containing the approved spec, plan, Git preferences, code, tests, and version files; refresh/rebase onto `origin/master`; fast-forward local `master`; push only `master`; verify the remote SHA; clean the task worktree/branch; restart production through `ops/windows/start-production.ps1`; run the existing health or login-page smoke check. Stop and report if any finalize precondition fails.
