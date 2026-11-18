# WeChat Refund Netting Implementation Plan

> **For agentic workers:** REQUIRED SKILL: Use implement to execute this plan task-by-task. Respect the handed-off git_state: inherit prepared, otherwise prepare; use git-workflow for checkpoint/finalize. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import WeChat Pay refunds as a single net expense, lock fully refunded and unmatched refund outcomes, and prevent historical or concurrent duplicate imports.

**Scope Source:** `docs/scope/2026-08-27-wechat-refund-netting.md` (`已批准 2026-08-28`)

**Architecture:** Parse the whole workbook into normalized raw rows, derive each refunded payment amount from its own status, and use non-empty counterparty totals only to consume supporting refund-income rows. Persist a stable refund identity plus the original amount in the draft, then reuse one batched history classifier at draft creation and confirmation; confirmation returns `requiresReview` when concurrent history changes. Existing draft status codes and UI panels are extended without Prisma migrations.

**Tech Stack:** TypeScript, Next.js server actions, Prisma/PostgreSQL, ExcelJS, Vitest, Playwright.

**Verification:** `npm run lint`, `npm run test:unit`, `npm run test:integration`, `npm run test:e2e`, targeted sensitive-text checks, and `skills/billboard-security-review/SKILL.md`.

---

### Task 1: Parse and net WeChat refund rows

**Files:**
- Modify: `tests/unit/wechat-pay-import.test.ts`
- Modify: `tests/unit/import-privacy.test.ts`
- Modify: `src/lib/imports/types.ts`
- Modify: `src/lib/imports/sources/wechat-pay.ts`

**Acceptance:** The parser emits one stable net payment for valid partial refunds, one locked payment for full refunds, one locked residual for uncovered refund income, and explicit invalid rows for malformed amounts without exposing source identifiers.

- [x] **Step 1: Add failing parser tests for the attachment-equivalent partial refund**

Add a synthetic ¥2.00 expense with `已退款(¥1.19)` and a synthetic ¥1.19 refund income. Assert exactly one parsed row with `amountFen: 81`, `refundHandling: "WECHAT_PARTIAL"`, `refundOriginalAmountFen: 200`, original payment date/category/counterparty, and no income row.

- [x] **Step 2: Add failing tests for full refunds, status-only partial refunds, and stable identity**

Assert a partial payment without an income row still nets, a full refund emits `WECHAT_FULL`, and changing the refund amount or moving from partial to full leaves the payment `sourceFingerprint` unchanged.

- [x] **Step 3: Add failing aggregation and failure-path tests**

Cover multiple rows for one non-empty counterparty, uncovered residual income, refund-only input, empty counterparties, row-order independence, partial refund amount zero/equal/over original, refund-income status/row amount mismatch, and non-strict refund statuses retaining the existing invalid behavior.

- [x] **Step 4: Run the parser tests and verify RED**

Run: `npx vitest run tests/unit/wechat-pay-import.test.ts tests/unit/import-privacy.test.ts`

Expected: FAIL because WeChat refund handling metadata and aggregation do not exist and all refund statuses are currently invalid.

- [x] **Step 5: Implement minimal raw-row classification and workbook processing**

Collect `RawDataRow` values before conversion. Add exact partial/full/refund-income status parsers using integer-fen parsing; derive payment net amounts independently; aggregate only non-empty normalized counterparties; emit deterministic residual manual rows; generate `WECHAT_REFUND_ID_V1` fingerprints from the approved immutable payload; preserve existing parsing for unrelated rows.

- [x] **Step 6: Run focused unit tests and verify GREEN**

Run: `npx vitest run tests/unit/wechat-pay-import.test.ts tests/unit/import-privacy.test.ts`

Expected: PASS with no warnings.

- [x] **Step 7: Git checkpoint**

Invoke `git-workflow` checkpoint for the parser/type/test files. Per repository preference, record verification and skip committing until the entire feature passes complete validation.

### Task 2: Classify refund drafts and historical payments

**Files:**
- Modify: `tests/integration/import-drafts.test.ts`
- Modify: `src/lib/imports/types.ts`
- Modify: `src/lib/imports/drafts.ts`

**Acceptance:** Draft creation stores only the approved original-amount metadata, locks full/manual outcomes, and classifies stable and legacy history inside the current household including soft-deleted rows.

- [x] **Step 1: Add failing draft-creation tests**

Build synthetic WeChat workbooks for partial, full, and refund-only cases. Assert partial rows remain importable with net `amountFen` and `rawAmount` equal to the original integer-fen string; full and unmatched outcomes use `WECHAT_FULLY_REFUNDED` or `WECHAT_REFUND_REQUIRES_MANUAL_ADJUSTMENT`, require no mapping, and cannot be changed to `KEEP`.

- [x] **Step 2: Add failing stable-fingerprint history tests**

Assert first partial import is normal, identical net history is a normal source duplicate, later increased/full refunds become locked manual adjustment, and matching history in another household has no effect.

- [x] **Step 3: Add failing conservative legacy-history tests**

Create same-source expense history at the exact payment timestamp with amounts at current net, between net and original, at original, outside the interval, multiple interval candidates, and soft-deleted candidates. Assert equality means ordinary duplicate; higher interval or multiple candidates mean manual adjustment; outside amounts and other households do not match.

- [x] **Step 4: Run focused integration tests and verify RED**

Run: `npx vitest run tests/integration/import-drafts.test.ts`

Expected: FAIL because WeChat refund reason codes, original-amount draft metadata, and legacy interval lookup are absent.

- [x] **Step 5: Implement batched creation-time history classification**

Add stable WeChat reason constants and handling types. Query stable fingerprint amounts and exact timestamp candidates in chunks including soft-deleted rows. Centralize classification for Alipay and WeChat semantics, persist `rawAmount` only for partial WeChat refund drafts, and extend decision locks without altering other sources.

- [x] **Step 6: Run focused integration and unit regression tests**

Run: `npx vitest run tests/integration/import-drafts.test.ts tests/unit/alipay-import.test.ts tests/unit/wechat-pay-import.test.ts`

Expected: PASS; existing Alipay behavior remains unchanged.

- [x] **Step 7: Git checkpoint**

Invoke `git-workflow` checkpoint for draft/type/integration files and record the passed checks without committing before full validation.

### Task 3: Recheck refund history during confirmation

**Files:**
- Modify: `tests/integration/import-drafts.test.ts`
- Modify: `src/lib/imports/drafts.ts`

**Acceptance:** Confirmation performs the same batched history classification before writes, creates no transactions when state changed, locks affected rows, keeps the draft pending, and returns `requiresReview: true`.

- [x] **Step 1: Add a failing interleaved-draft test**

Create a ready partial-refund draft, insert stable-fingerprint or legacy-interval history after preview, then confirm. Assert `createdCount: 0`, `completedNow: false`, `requiresReview: true`, zero new transactions, updated locked row status/reason, and a pending draft.

- [x] **Step 2: Add failing tests for repeated confirmation**

Assert a second confirmation after review imports only still-ready rows and completes the draft; a stable fingerprint at the same net becomes ordinary duplicate, while higher legacy amounts or full refund conflicts become manual adjustment.

- [x] **Step 3: Run focused integration tests and verify RED**

Run: `npx vitest run tests/integration/import-drafts.test.ts`

Expected: FAIL because confirmation currently only checks exact fingerprints, writes remaining rows, and always completes the draft.

- [x] **Step 4: Implement confirmation-time reclassification**

Extend the confirmation result with `requiresReview`. Parse the approved integer-fen `rawAmount` metadata, batch-query stable and interval history through the transaction client before inserts, update changed rows using the shared classifier, return without writes/completion when review is required, and keep existing insert conflict handling for unrelated rows.

- [x] **Step 5: Run focused integration tests and verify GREEN**

Run: `npx vitest run tests/integration/import-drafts.test.ts`

Expected: PASS including large-draft batching and existing confirmation concurrency tests.

- [x] **Step 6: Git checkpoint**

Invoke `git-workflow` checkpoint for confirmation service/tests and record the passed checks without committing before full validation.

### Task 4: Surface locked outcomes and confirmation review state

**Files:**
- Modify: `tests/integration/import-page-and-actions.test.ts`
- Modify: `tests/unit/i18n.test.ts`
- Modify: `tests/e2e/import-wechat-pay.spec.ts`
- Modify: `src/app/(app)/records/import/actions.ts`
- Modify: `src/app/(app)/records/import/page.tsx`
- Modify: `src/lib/i18n.ts`

**Acceptance:** WeChat full/manual rows render in the existing refund panel without controls, and a confirmation race returns to the pending draft with localized review guidance instead of the completed route or success event.

- [x] **Step 1: Add failing action and page tests**

Mock `{ completedNow: false, requiresReview: true }`; assert `confirmImportDraftAction` redirects to `?draft=<id>&notice=IMPORT_DRAFT_CHANGED`, does not use `completed=1`, and the page renders the localized review notice plus locked WeChat refund reasons with no `KEEP` input.

- [x] **Step 2: Add failing i18n tests**

Assert Chinese and English values for the draft-changed notice and generalized manual-adjustment message while preserving the existing Alipay labels.

- [x] **Step 3: Run focused UI tests and verify RED**

Run: `npx vitest run tests/integration/import-page-and-actions.test.ts tests/unit/i18n.test.ts`

Expected: FAIL because WeChat reason codes and the notice branch are not recognized.

- [x] **Step 4: Implement action, page, and i18n behavior**

Consume `requiresReview` before success-event recording, redirect with the stable notice code, render a pending-draft notice, recognize both Alipay and WeChat locked reason codes, and add matching Chinese/English text.

- [x] **Step 5: Add and run the WeChat refund E2E scenario**

Extend the synthetic workbook helper with a partial-refund scenario and assert the preview/import produces one ¥0.81 expense with no refund income. Run: `npx playwright test tests/e2e/import-wechat-pay.spec.ts`

Expected: PASS.

- [x] **Step 6: Run focused UI regression tests and verify GREEN**

Run: `npx vitest run tests/integration/import-page-and-actions.test.ts tests/unit/i18n.test.ts`

Expected: PASS in both locales.

- [x] **Step 7: Git checkpoint**

Invoke `git-workflow` checkpoint for action/page/i18n/E2E files and record the passed checks without committing before full validation.

### Task 5: Version, full verification, security review, and release

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Verify: `docs/scope/2026-08-27-wechat-refund-netting.md`
- Verify: all files changed by Tasks 1–4

**Acceptance:** Version `1.30.0` passes every repository-required check, security review has no blocking findings, and the Git/release workflow completes from `master` with a healthy production service.

- [x] **Step 1: Update the feature version**

Set the root project version in `package.json` and `package-lock.json` to `1.30.0` without changing dependency versions.

- [x] **Step 2: Run targeted privacy and sensitive-text checks**

Run: `npx vitest run tests/unit/import-privacy.test.ts`

Run repository text checks for the attachment path, real counterparty, raw order values, credentials, and production entrance identifiers. Expected: no task change contains private source data.

- [x] **Step 3: Run complete validation**

Run: `npm run lint`

Run: `npm run test:unit`

Run: `npm run test:integration`

Run: `npm run test:e2e`

Expected: all required checks pass; only configured skips are allowed.

- [x] **Step 4: Run the mandatory BillBoard security review**

Read and follow `skills/billboard-security-review/SKILL.md`. Record Findings, Verification, and Residual Risk; any blocker returns the implementation to the relevant TDD task.

- [x] **Step 5: Inspect the final diff and invoke Git finalize**

Confirm only task-owned files changed, the approved spec and plan are complete, version and commit subject agree, and `master` still has no unknown changes beyond the prepare-time `.skill-source-lock.json`. Invoke `git-workflow` finalize with the real verification result.

- [x] **Step 6: Commit, rebase, fast-forward master, and push**

Expected commit subject: `v1.30.0 微信退款按净额导入`. Rebase the task branch onto the refreshed `origin/master`, fast-forward local `master`, push only `master`, and verify the remote SHA. Do not stage the prepare-time `.skill-source-lock.json`.

- [x] **Step 7: Restart and smoke-test production**

Use `D:\GithubRepos\BillBoard\ops\windows\start-production.ps1` from the clean `master` workspace, then verify the local production login page and running application version. Clean the task worktree/branch only after push and production health checks succeed.
