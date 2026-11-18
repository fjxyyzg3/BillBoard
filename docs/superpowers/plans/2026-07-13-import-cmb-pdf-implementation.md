# 招商银行 PDF 流水导入 Implementation Plan

日期：2026-07-13

Planning Mode: Full

Risk rationale: 改动核心导入 workflow，新增 PDF 解析依赖并处理敏感家庭财务数据，跨 parser、草稿状态机、server action、UI/i18n、测试和发布门禁。

**Goal:** 在现有 `/records/import` 草稿流程中安全支持同版式招商银行官方借记卡交易流水 PDF。

**Architecture:** 新增 `cmb` source adapter，使用 `pdfjs-dist` 从本地 `Buffer` 获取文字坐标并重建多页表格；复用现有成员映射、分类映射、同源去重、逐行决策和批量确认。用可选 `ParsedImportRow.defaultSkipReason` 初始化疑似资金移动为 `USER_SKIPPED`，不新增 Prisma migration。

**Target version:** `1.26.0`

## Global Constraints

- 代码和注释使用英文；用户文案同步中文和英文。
- 不把用户样本、真实户名、账号、余额、验证码、真实商户或真实入口标识写入仓库。
- 原始 PDF 仅在内存解析，不记录到日志、事件 metadata、URL 或持久化文件。
- 金额只以整数分 `amountFen` 持久化，日期只按 `Asia/Shanghai`。
- 所有 draft/member/category/transaction 操作继续由有效 session 的 `householdId` 收敛。
- 同源去重包含软删除；确认继续批量化并保持幂等。
- 只做本功能所需改动，不重构整个导入框架，不新增 schema/migration、账户模型、transfer 类型或多币种。

## Task 1: 锁定来源契约、依赖与版本

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/lib/imports/types.ts`
- Modify: `tests/unit/import-schema.test.ts`
- Create: `tests/unit/cmb-import.test.ts`

**Consumes:** 已确认的 `FR-001`、`FR-004`、`FR-011`、`FR-012`；现有 `ImportSource` 与 `ParsedImportRow`。

**Produces:** `CMB_SOURCE = "cmb"`；扩展后的 `ImportSource`；`ParsedImportRow.defaultSkipReason?: string`；生产依赖 `pdfjs-dist`；根版本 `1.26.0`。

**Covers:** FR-001, FR-004, FR-011, FR-012

**Steps:**

1. 在 `tests/unit/cmb-import.test.ts` 先写失败测试，断言 `CMB_SOURCE`、映射 key 前缀和可选 `defaultSkipReason` 契约；在 `tests/unit/import-schema.test.ts` 断言存在 `pdfjs-dist` 且继续不存在 `xlsx`。
2. 运行 `npm run test:unit -- tests/unit/cmb-import.test.ts tests/unit/import-schema.test.ts`，确认 RED。
3. 执行 `npm install pdfjs-dist`，再执行 `npm version 1.26.0 --no-git-tag-version`；在 `src/lib/imports/types.ts` 做最小类型扩展。
4. 运行同一 focused unit 命令，确认 GREEN。
5. 运行 `npm audit --json`，记录新增依赖相关 finding；任何新增 high/critical finding 在实现继续前处理或报告阻塞。

**Acceptance Criteria:** source/type/依赖/版本契约一致；lockfile 由 npm 生成；未新增多余 PDF、OCR 或网络客户端依赖。

**Verification:** `npm run test:unit -- tests/unit/cmb-import.test.ts tests/unit/import-schema.test.ts`; `npm audit --json`; `node -e "const p=require('./package.json');const l=require('./package-lock.json');if(p.version!=='1.26.0'||l.version!=='1.26.0'||l.packages[''].version!=='1.26.0')process.exit(1)"`。

## Task 2: 以 TDD 实现坐标型 CMB PDF parser

**Files:**

- Create: `src/lib/imports/sources/cmb.ts`
- Modify: `tests/unit/cmb-import.test.ts`
- Create: `tests/fixtures/imports/cmb/statement-single-page.pdf`
- Create: `tests/fixtures/imports/cmb/statement-multi-page.pdf`

**Consumes:** `CMB_SOURCE`、`ParsedImportRow.defaultSkipReason?: string`、`pdfjs-dist` dependency。

**Produces:** `parseCmbPdf(buffer: Buffer): Promise<ParsedImportWorkbook>`；只含占位数据、从零生成的单页和多页 PDF fixture。

**Covers:** FR-002, FR-003, FR-004, FR-005, FR-006, FR-007, FR-008, FR-011

**Steps:**

1. 从零生成脱敏 fixture，使用“示例户名”、脱敏账号和示例商户；禁止复制或遮盖用户 PDF。fixture 覆盖重复页眉、跨行对手、收入、支出、Unicode minus、转账类、同名对手和非 CNY。
2. 先写 parser 失败测试：正常单页、多页续行、正负金额到整数分、上海零点、分类 key、备注白名单、指纹稳定、默认跳过关键词/同名对手、非 CNY/零金额 invalid、页数/行数上限、无文本层、加密或表头/列错位整体拒绝。
3. 运行 `npm run test:unit -- tests/unit/cmb-import.test.ts`，确认 RED。
4. 在 `cmb.ts` 动态加载 PDF.js Node build，从 `Uint8Array` 调用 `getDocument`，逐页 `getTextContent`，只使用本地 data，不传 URL；在 `finally` 销毁 document/loading task。
5. 用标题、页面尺寸、中文表头和列锚点验证版式；按 y 容差聚合文字项，按表头 x 边界分列，日期列启动新交易，对手续行追加到上一交易。任一核心字段缺失或页面异常都抛出统一的 `无法识别招商银行流水格式`。
6. 实现金额、日期、币种、备注、mapping key、默认跳过和 fingerprint 规则。账号与余额只进入哈希输入，parser 输出不得暴露对应明文。
7. 运行 focused unit 测试确认 GREEN，并循环同一 fixture 解析以检查资源释放和确定性。

**Acceptance Criteria:** 同版式单页/多页得到稳定 `ParsedImportWorkbook`；异常 PDF 不产生部分结果；没有 OCR、临时文件或外部请求；fixture 不含用户样本数据。

**Verification:** `npm run test:unit -- tests/unit/cmb-import.test.ts`; `npm run test:unit -- tests/unit/sensitive-fixtures.test.ts`; manual/static inspection of extracted fixture text expects placeholders only。

## Task 3: 接入草稿状态机、成员映射、备注与去重

**Files:**

- Modify: `src/lib/imports/drafts.ts`
- Modify: `tests/integration/import-drafts.test.ts`
- Modify: `tests/unit/import-privacy.test.ts`

**Consumes:** `parseCmbPdf(buffer)`；`ParsedImportRow.defaultSkipReason?: string`；现有 `createImportDraft`、`ImportMemberMapping`、分类映射和重复检测。

**Produces:** `createCmbImportDraft(input)`；CMB 默认 `USER_SKIPPED/SKIP` 初始化；CMB note 持久化白名单；`cmb.pdf` 固定草稿文件名；现有恢复决策路径可把默认跳过行恢复到正确状态。

**Covers:** FR-004, FR-005, FR-006, FR-007, FR-008, FR-009

**Steps:**

1. 先写集成测试，覆盖：草稿创建；首次户名映射阻止确认；保存 `cmb` 家庭成员映射后复用；`交易摘要 + 对手信息` 分类映射隔离；默认跳过不阻塞；恢复后重新进入 mapping/duplicate/member gate；同源重复及软删除重复；跨来源疑似重复；跨家庭 draft/member/category 伪造拒绝。
2. 写 privacy 测试，允许 CMB note 只包含摘要和对手信息，同时断言账号、余额、验证码、申请时间和完整原始行不进入 note、draft filename 或事件数据；现有三来源继续保持 `note: null`。
3. 运行 `npm run test:integration -- tests/integration/import-drafts.test.ts` 和 `npm run test:unit -- tests/unit/import-privacy.test.ts`，确认 RED。
4. 新增 `createCmbImportDraft`；扩展 `storedImportFileName`；让 `buildParsedRowCreateInput` 对 CMB 保留 parser 的白名单 note，并使 source duplicate 优先于 `defaultSkipReason`，其次初始化 `USER_SKIPPED`，否则沿用现有 mapping/duplicate 状态。
5. 不把 CMB 加入旧的 payment-owner fallback；直接复用 source-scoped `ImportMemberMapping`，确保未映射户名保持 `fallbackApplied=true`。
6. 运行 focused integration/unit 测试确认 GREEN。

**Acceptance Criteria:** CMB 草稿完全复用现有权限与批量确认；默认跳过可逆但不绕过 gate；成员/分类记忆按家庭和 source 隔离；敏感字段未持久化。

**Verification:** `npm run test:integration -- tests/integration/import-drafts.test.ts`; `npm run test:unit -- tests/unit/import-privacy.test.ts tests/unit/cmb-import.test.ts`。

## Task 4: 接入上传 action、页面与双语文案

**Files:**

- Modify: `src/app/(app)/records/import/actions.ts`
- Modify: `src/app/(app)/records/import/page.tsx`
- Modify: `src/lib/i18n.ts`
- Modify: `tests/integration/import-page-and-actions.test.ts`
- Modify: `tests/unit/i18n.test.ts`

**Consumes:** `CMB_SOURCE`；`createCmbImportDraft(input)`；CMB 草稿 summary 与默认跳过状态。

**Produces:** `/records/import` 的招商银行来源选择、`.pdf` dispatch、来源标签、默认跳过提示、双语错误 `unsupported-cmb-file` / `unrecognized-cmb-file`。

**Covers:** FR-001, FR-006, FR-010

**Steps:**

1. 先写 action/page/i18n 失败测试，覆盖来源解析、`.pdf` 允许、伪扩展拒绝、20 MB 限制、CMB parser 分发、格式错误 redirect、四来源 UI、`accept=.xlsx,.csv,.pdf`、来源标签、成员映射表单、默认跳过说明和中英文文案。
2. 运行 `npm run test:integration -- tests/integration/import-page-and-actions.test.ts` 与 `npm run test:unit -- tests/unit/i18n.test.ts`，确认 RED。
3. 在 action 中显式处理 CMB 扩展名和 parser error，不改变其他来源分支；继续在读取 `arrayBuffer` 前完成扩展名和大小校验。
4. 在页面增加第四个移动优先来源选项，扩展 source label 和文件 accept；CMB 使用通用 member mapping form，不显示 payment owner fallback；显示可恢复的默认跳过说明。
5. 同步 `src/lib/i18n.ts` 中文、英文文案并运行 focused tests 确认 GREEN。

**Acceptance Criteria:** CMB 上传和错误路径来源化；其他三来源无回归；页面不暴露账号、余额、source fingerprint 或原始 PDF 内容。

**Verification:** `npm run test:integration -- tests/integration/import-page-and-actions.test.ts`; `npm run test:unit -- tests/unit/i18n.test.ts`; `npm run lint`。

## Task 5: 完成脱敏 E2E 与生产构建回归

**Files:**

- Create: `tests/e2e/import-cmb.spec.ts`
- Modify: `tests/unit/sensitive-fixtures.test.ts`
- Test: `tests/fixtures/imports/cmb/statement-single-page.pdf`
- Test: `tests/fixtures/imports/cmb/statement-multi-page.pdf`
- Inspect: `Containerfile`
- Inspect/Modify only if required by verified standalone failure: `next.config.ts`

**Consumes:** CMB upload UI/action；`createCmbImportDraft`；脱敏 PDF fixtures；CMB parser dependency。

**Produces:** 用户可见的完整 CMB 导入 E2E；跟踪 fixture 的敏感样本防回归；Node 22/Next standalone parser smoke。

**Covers:** FR-002, FR-004, FR-005, FR-006, FR-007, FR-009, FR-010, FR-011

**Steps:**

1. 扩展 `sensitive-fixtures.test.ts` 的扫描清单，加入新 parser、unit/e2e、spec/plan；对 PDF fixture 提取文字后复用 forbidden hash 扫描，确保没有已知真实样本片段。
2. 新增 E2E：登录、选择招商银行、上传脱敏 PDF、解决首次成员映射、验证普通行默认导入及资金移动默认不导入、完成分类映射、确认并在记录页验证金额/分类/成员。
3. 运行 `npm run test:e2e -- tests/e2e/import-cmb.spec.ts`，再运行现有三种导入 E2E 回归。
4. 运行 `npm run build`。使用 `Containerfile` 的 Node 22 构建/运行路径做 PDF parser smoke，确认 standalone 包含所需 PDF.js 资产且解析不触发网络访问。
5. 只有实际 build/standalone 复现缺失资产时，才对 `next.config.ts` 增加最小 `outputFileTracingIncludes`；不得预先加入无验证配置。

**Acceptance Criteria:** 脱敏 PDF 走通真实浏览器流程；原有三来源保持通过；Node 22 standalone 可在无外网条件下解析 fixture；fixture 安全扫描通过。

**Verification:** `npm run test:e2e -- tests/e2e/import-cmb.spec.ts tests/e2e/import-sui-shou-ji.spec.ts tests/e2e/import-wechat-pay.spec.ts tests/e2e/import-alipay.spec.ts`; `npm run test:unit -- tests/unit/sensitive-fixtures.test.ts`; `npm run build`; Node 22 container/standalone smoke returns expected row count without network。

## Task 6: 完整审查、发布门禁与生产 smoke

**Files:**

- Read/Apply: `skills/billboard-security-review/SKILL.md`
- Review: all changed files
- Verify: `package.json`, `package-lock.json`, `Containerfile`, production start entry

**Consumes:** Tasks 1-5 的完整实现、测试、fixture 和构建结果。

**Produces:** 安全审查报告；完整验证证据；单一 feature commit `v1.26.0 支持招商银行 PDF 流水导入`；成功 push、生产重启和登录页 smoke，或在任一门禁失败处停止。

**Covers:** FR-007, FR-008, FR-009, FR-011, FR-012

**Steps:**

1. 使用 `$requesting-code-review` 检查 spec compliance、parser 失败关闭、权限、隐私、资源上限、状态机和回归测试；修复发现项后重新运行受影响验证。
2. 读取并应用 `skills/billboard-security-review/SKILL.md`。Findings 必须优先列出；验证无真实账号、凭据、生产 host/IP、私有 URL、原始 PDF、余额或验证码进入跟踪文件，且 `npm audit --json` 未引入未处理 high/critical finding。
3. 运行完整验证：`npm run lint`、`npm run test:unit`、`npm run test:integration`、`npm run test:e2e`、`npm run build`。使用 `$verification-before-completion` 复核结果、临时文件、fixture、安全报告和 git 状态。
4. 在提交前确认：当前分支为 `master`；`git status` 仅含本功能文件；已检查 `origin/master...HEAD`；版本三处均为 `1.26.0`；`ops/windows/start-production.ps1` 可用；提交详情不超过 256 字符。任一条件不满足即停止。
5. 将同一目标的本地实现整理为一条提交：`v1.26.0 支持招商银行 PDF 流水导入`。提交详情草稿：`新增招商银行官方 PDF 坐标解析、默认跳过资金移动、成员与分类映射复用、去重、隐私保护及完整导入验证。`
6. 推送 `master` 到 `origin`。推送成功后运行 `.\ops\windows\start-production.ps1`；脚本自身必须验证本机 `/login` 和 JavaScript chunk。任何 push、重启或 smoke 失败立即停止并报告，不继续后续动作。

**Acceptance Criteria:** 全部强制验证实际通过；安全审查无阻塞 finding；提交版本和类型一致；推送、正式服务重启及登录页 smoke 成功；最终回复包含 Findings、Verification、Residual Risk。

**Verification:** `npm run lint`; `npm run test:unit`; `npm run test:integration`; `npm run test:e2e`; `npm run build`; `npm audit --json`; `git status --short --branch`; `git diff --check`; production startup log reports verified `/login` and JavaScript chunk。

## Coverage Self-check

| Requirement | Task | Verification seam |
| --- | --- | --- |
| FR-001 | Task 1, Task 4 | source/type unit + action/page integration |
| FR-002 | Task 2, Task 5 | parser failure tests + multi-page fixture + E2E |
| FR-003 | Task 2 | parser unit tests for coordinates/amount/date/currency |
| FR-004 | Task 1, Task 2, Task 3, Task 5 | default skip parser/integration/E2E |
| FR-005 | Task 2, Task 3, Task 5 | mapping key unit + household mapping integration + E2E |
| FR-006 | Task 2, Task 3, Task 4, Task 5 | owner extraction + member mapping integration/UI/E2E |
| FR-007 | Task 2, Task 3, Task 5, Task 6 | note allowlist/privacy/fixture/security review |
| FR-008 | Task 2, Task 3, Task 6 | fingerprint + soft-delete/source duplicate integration |
| FR-009 | Task 3, Task 5, Task 6 | cross-household rejection + confirm/E2E/security review |
| FR-010 | Task 4, Task 5 | i18n/page/action tests + E2E |
| FR-011 | Task 1, Task 2, Task 5, Task 6 | audit + fixture + Node 22 standalone + full verification |
| FR-012 | Task 1, Task 6 | version assertion + full release gates |

## Assumptions

- 同版式 PDF 的文字层和列锚点稳定；遇到漂移时失败关闭。
- `pdfjs-dist` 的具体 lock 版本由实现时 `npm install` 解析，不在计划中手写版本。
- 现有 `ImportDraftRow` 字段足够承载本功能，不需要 migration。
- 生产 Windows fallback 仍由 `ops/windows/start-production.ps1` 负责构建、启动和登录页 smoke。

## AutoFixSummary

- 将 CMB 成员归属改为复用现有 source-scoped `ImportMemberMapping`，避免把新来源错误塞入 payment-owner fallback。
- 将 PDF fixture 明确为从零生成并增加解压文字敏感哈希扫描，避免“视觉遮盖但隐藏文本仍含真实数据”。
- 把 standalone Node 22 smoke 和 `npm audit --json` 纳入必验项，覆盖新增解析依赖的部署与供应链风险。

## Residual Risks

- 只有一个真实版式样本可供设计验证；银行静默改版会导致失败关闭，需要新样本后扩展。
- PDF.js Node 支持和 standalone 资产跟踪存在构建风险；Task 5 必须以容器 smoke 消除，而不能只依赖 unit tests。
- 对手信息按用户确认进入 note；即使排除账号和余额，它仍属于敏感财务上下文，必须保持家庭权限和客户端暴露边界。
- 组合指纹没有银行交易 ID 的强唯一性，极端完全相同行可能被视为同源重复。

## Planning Quality Status

RequirementsCoverage: Pass

TaskCompleteness: Pass

ContractConsistency: Pass

RepositoryFeasibility: Pass

ConstraintAlignment: Pass

Planning Quality Status: Pass
