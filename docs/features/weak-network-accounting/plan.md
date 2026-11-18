# 弱网记账体验优化 Implementation Plan

Planning Mode: Full
日期：2026-07-17
Source：已确认的 conversation design 与同目录 `spec.md`

## 1. Risk decision

- **Mode evidence**：修改 `Transaction` schema 和 migration；改变手工交易创建契约与 `/add` 核心 workflow；涉及重复财务记录、浏览器草稿生命周期和生产 migration 顺序。
- **Conflicts**：None。装饰资源范围、`sessionStorage` 隐私边界、幂等字段、结果不明确冻结行为和弱网验收方向均已确认。
- **User override**：None。

## 2. Goal

把 `/home -> /add -> 保存` 路径改造成弱网下有即时反馈、草稿可恢复、保存无需整页重载且可安全重试的核心记账流程，同时保持现有家庭隔离与财务完整性规则。

## 3. Assumptions

- 实现继续使用 Next.js App Router、React 19 Server Action、Prisma/PostgreSQL，不新增依赖或 API route。
- 目标浏览器支持 `sessionStorage` 与 `crypto.randomUUID()`；存储异常必须降级为内存状态。
- 六张新 WebP 由现有 PNG 生成，视觉内容不重绘；原 `public/images/*-source.png` 可保留为源文件，不参与运行时加载。
- 绝对性能目标在 Chromium 弱网实验中记录；CI 只硬性断言资源预算、即时状态和确定性延迟行为。
- 开发与测试数据库按 README 使用非生产数据库；e2e 不得连接生产库。

## 4. Global constraints

- 代码、测试标识符和注释使用英文；UI、计划、验证记录使用中文，UI 新文案同步中英文。
- `amountFen` 保持整数分；`occurredAt` 按 `Asia/Shanghai`；客户端不得提供 `householdId` 或 `createdByMemberId`。
- `requireAppSession()` 与当前家庭成员校验必须保留；`clientRequestId` 不得进入 URL、AppEvent、日志、记录列表或报表。
- 手工交易 `source`、`sourceFingerprint`、`sourceImportedAt` 保持 `null`；导入行为不变。
- 不实现 Service Worker、离线队列、自动重试、外部遥测或全局数据缓存。
- 只修改任务列出的文件；不得顺手重构或格式化无关文件。
- migration 在生产应用启动前执行；生产入口继续遵守 nginx 根路径与 loopback 约束。
- 当前版本 `1.26.1`，本 feature 的目标版本为 `1.27.0`。

## 5. Stable implementation contracts

- **DecorativeAssetSet v1**：`src/assets/art/` 下六张静态 import WebP；首页五张合计不超过 250 KiB，记账页一张不超过 50 KiB。
- **ResponsiveNavigationShell v1**：导航上下文可表达目标 path 的 pending 状态；`(app)/loading.tsx` 提供不依赖数据的 skeleton。
- **IdempotentTransactionCreateResult v1**：交易字段 `id`、`amountFen`、`type`、`clientRequestId` 加 `wasCreated: boolean`。
- **CreateTransactionActionResult v1**：`idle | success | error`；success 含 `transactionId`、`clientRequestId`、`amountFen`、`type`，unknown 由客户端维护。
- **TransactionDraftV1**：版本、成员、payload、可空 `clientRequestId`、`draft | awaiting-confirmation`、`savedAt`。
- **WeakNetworkFormState v1**：`idle | dirty | submitting | slow | success | error | unknown`，unknown 只能用冻结的原 payload/ID 重新确认。

## 6. Tasks

### Task 1：压缩并降低装饰资源优先级

**Files**

- Create: `src/assets/art/home-title.webp`
- Create: `src/assets/art/add-title.webp`
- Create: `src/assets/art/summary-income.webp`
- Create: `src/assets/art/summary-expense.webp`
- Create: `src/assets/art/summary-net.webp`
- Create: `src/assets/art/summary-records.webp`
- Modify: `src/components/page-hero-art.tsx`
- Modify: `src/components/summary-card.tsx`
- Test: `tests/unit/page-hero-art.test.tsx`
- Test: `tests/unit/summary-card.test.tsx`
- Create Test: `tests/unit/weak-network-assets.test.ts`

**Consumes**

- None。

**Produces**

- `DecorativeAssetSet v1`：六张带 static import 的 WebP 以及可执行的字节预算回归测试。

**Covers**

- FR-001、FR-010。

**Acceptance Criteria**

- 运行时组件不再引用六张 `public/images/*-art.png`，也不再使用 `fetchPriority="high"`。
- 首页五张新资源合计不超过 250 KiB，`add-title.webp` 不超过 50 KiB。
- 图片保留当前视觉尺寸和装饰语义，声明 lazy/低优先级加载；移动端 smoke 无明显压缩伪影或布局跳动。

**Verification**

```powershell
npm run test:unit -- tests/unit/weak-network-assets.test.ts tests/unit/page-hero-art.test.tsx tests/unit/summary-card.test.tsx
npm run build
```

预期：测试断言资源格式、字节预算、static import 输出和加载属性；production build 能解析全部资源。

### Task 2：增加导航 pending、路由 skeleton 并收敛页面串行等待

**Files**

- Create: `src/app/(app)/loading.tsx`
- Modify: `src/components/app-filters-provider.tsx`
- Modify: `src/components/bottom-nav.tsx`
- Modify: `src/components/desktop-nav.tsx`
- Modify: `src/app/(app)/add/page.tsx`
- Modify: `src/app/(app)/home/page.tsx`
- Test: `tests/unit/navigation-version-marker.test.tsx`
- Test: `tests/integration/add-page-category-preferences.test.tsx`
- Test: `tests/integration/ops-instrumentation.test.ts`

**Consumes**

- `DecorativeAssetSet v1`，确保新的 loading/pending shell 不重新提升装饰资源优先级。

**Produces**

- `ResponsiveNavigationShell v1`：目标 path pending 状态、辅助技术语义和 `(app)` skeleton。
- `ParallelPageWork v1`：session 之后页面事件与页面数据读取可并行启动，事件仍为 best-effort。

**Covers**

- FR-002、FR-003、FR-008、FR-010。

**Acceptance Criteria**

- `/home`、`/add`、`/records` 导航继续保留合法共享筛选；点击后目标项立即带 `aria-busy`/视觉 pending，pathname 更新后清除。
- 路由等待时显示稳定 skeleton；不增加新页面、query 参数或阻塞式全屏遮罩。
- `/home` 与 `/add` 仍先认证；认证后 page-view event 未完成时，页面所需数据查询已经可以开始。
- AppEvent 输入内容、家庭 scope 和失败不阻断页面的语义不变。

**Verification**

```powershell
npm run test:unit -- tests/unit/navigation-version-marker.test.tsx
npm run test:integration -- tests/integration/add-page-category-preferences.test.tsx tests/integration/ops-instrumentation.test.ts
```

预期：导航语义和过滤参数测试通过；使用 deferred mocks 的页面测试证明数据读取不等待 page-view event resolve。

### Task 3：增加手工交易幂等 schema 与原子创建契约

**Files**

- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260717090000_add_transaction_client_request_id/migration.sql`
- Modify: `src/lib/transactions/schema.ts`
- Modify: `src/lib/transactions/create-transaction.ts`
- Test: `tests/integration/create-transaction.test.ts`

**Consumes**

- None。

**Produces**

- Prisma `Transaction.clientRequestId: String? @map("client_request_id")`。
- 数据库唯一约束 `(created_by_member_id, client_request_id)`。
- `IdempotentTransactionCreateResult v1`。

**Covers**

- FR-006、FR-008、FR-010。

**Acceptance Criteria**

- migration 只新增可空列和唯一索引，无数据回填、删除或历史值改写。
- create schema 拒绝非 UUID 请求 ID；创建人和家庭仍只从 session 参数获得。
- 同一创建人、同一 ID、同一规范化 payload 的串行与并发调用返回同一交易，只有一个结果 `wasCreated: true`。
- 同一 ID 的不同 payload 返回稳定冲突错误；不同创建人可安全使用相同 UUID。
- 新手工交易来源字段保持 `null`；旧数据和导入路径无需提供请求 ID。

**Verification**

```powershell
npx prisma validate --schema prisma/schema.prisma
npm run prisma:generate
npm run test:integration -- tests/integration/create-transaction.test.ts
```

预期：schema/migration 可应用；integration tests 证明顺序重试、并发竞争、payload 冲突、创建人隔离和来源字段约束。

### Task 4：将保存 Action 改为结构化结果并保证事件/页面失效正确

**Files**

- Modify: `src/app/(app)/add/actions.ts`
- Modify: `src/app/(app)/add/page.tsx`
- Test: `tests/integration/transaction-datetime-and-action.test.ts`
- Test: `tests/integration/ops-instrumentation.test.ts`
- Test: `tests/integration/server-action-exports.test.ts`

**Consumes**

- `IdempotentTransactionCreateResult v1`。

**Produces**

- `CreateTransactionActionResult v1`。
- `PostCreateInvalidation v1`：只失效 `/home` 与 `/records`，不刷新当前 `/add`。

**Covers**

- FR-005、FR-006、FR-008、FR-009。

**Acceptance Criteria**

- 成功 Action 返回结构化 success，不调用 `/add` redirect，不再生成 `created`、`amountFen`、`type` URL 参数。
- session 无效仍重定向 `/login`；校验与未知服务端错误仍返回本地化 error。
- `wasCreated: true` 时尝试一次 `TRANSACTION_CREATED` AppEvent；`false` 时不重复记录。
- 成功后标记 `/home` 与 `/records` 失效；Action 响应不包含 `householdId`、`memberId`、备注或来源元数据。

**Verification**

```powershell
npm run test:integration -- tests/integration/transaction-datetime-and-action.test.ts tests/integration/ops-instrumentation.test.ts tests/integration/server-action-exports.test.ts
```

预期：Action success/error/login、事件至多一次、无 `/add` redirect 和页面失效断言全部通过。

### Task 5：实现版本化草稿与弱网保存状态机

**Files**

- Create: `src/lib/transactions/draft.ts`
- Modify: `src/components/transaction-form.tsx`
- Modify: `src/lib/i18n.ts`
- Create Test: `tests/unit/transaction-draft.test.ts`
- Test: `tests/unit/i18n.test.ts`
- Test: `tests/integration/create-transaction.test.ts`
- Test: `tests/e2e/create-expense.spec.ts`
- Test: `tests/e2e/create-income.spec.ts`

**Consumes**

- `CreateTransactionActionResult v1`。
- `TransactionDraftV1` 与 `WeakNetworkFormState v1`（由同目录 spec 定义）。

**Produces**

- `TransactionDraftV1` 的序列化、解析、成员/选项校验和存储 key helper。
- `WeakNetworkFormState v1` 的可见交互：立即保存、3 秒 slow、明确错误、unknown、同 ID 重新确认、成功重置。

**Covers**

- FR-004、FR-005、FR-007、FR-008、FR-010。

**Acceptance Criteria**

- 草稿 key 版本化且包含当前成员 ID；损坏、错误版本、成员不符、禁用分类或家庭成员不符时安全降级。
- 提交前把不可变 payload/ID 写为 `awaiting-confirmation`；提交期间字段只读但内容可见。
- Server Action 返回明确错误时保留草稿并解除冻结；编辑后清除旧请求 ID。
- 调用 promise 拒绝或恢复 `awaiting-confirmation` 时进入 unknown，只允许同 payload/ID 重试或去记录页；不自动发送。
- success 清除草稿、保持当前筛选 URL、显示金额 Toast，并按既有默认值本地重置表单。
- 新增中文/英文文案语义一致；`clientRequestId`、备注和成员 ID 不写 URL、console 或 AppEvent。

**Verification**

```powershell
npm run test:unit -- tests/unit/transaction-draft.test.ts tests/unit/i18n.test.ts
npm run test:integration -- tests/integration/create-transaction.test.ts
npm run test:e2e -- tests/e2e/create-expense.spec.ts tests/e2e/create-income.spec.ts
```

预期：草稿纯函数边界、双语 key、正常支出/收入无重定向保存、成功重置与记录可见全部通过。

### Task 6：建立确定性的弱网与结果不明确端到端验证

**Files**

- Create Test: `tests/e2e/weak-network-add.spec.ts`
- Test: `tests/e2e/ui-layout.spec.ts`
- Test: `tests/e2e/home-drilldown.spec.ts`

**Consumes**

- `DecorativeAssetSet v1`。
- `ResponsiveNavigationShell v1`。
- `PostCreateInvalidation v1`。
- `WeakNetworkFormState v1`。

**Produces**

- `WeakNetworkAcceptanceEvidence v1`：确定性延迟 e2e、草稿 reload、transport failure/同 ID 重试、数据新鲜度和手工弱网实验记录。

**Covers**

- FR-001、FR-002、FR-003、FR-004、FR-005、FR-006、FR-007、FR-009、FR-010。

**Acceptance Criteria**

- e2e 延迟 `/add` 导航响应时，点击后 100 ms 内可观察到 pending/skeleton，最终表单可用。
- e2e 延迟保存超过 3 秒时出现 slow 文案；完成后只显示一笔交易且当前 `/add` 未重载。
- reload 恢复普通草稿；传输失败恢复 unknown 快照，相同 ID 重试后只创建一笔交易。
- 保存后首次进入 `/home` 与 `/records` 均显示新数据，不依赖手工 refresh。
- Chromium 在 400 Kbps 上下行、800 ms RTT 下连续三次记录：`/add` 可操作目标 3 秒内、正常保存确认目标 4 秒内；若未达标，保留测量证据并回到对应 Task 优化，不能直接放宽规格。

**Verification**

```powershell
npm run test:e2e -- tests/e2e/weak-network-add.spec.ts tests/e2e/ui-layout.spec.ts tests/e2e/home-drilldown.spec.ts
```

Manual/static seam：使用 Chromium DevTools/CDP 设置 400 Kbps download/upload 与 800 ms latency，清缓存后记录一次冷路径、两次应用内路径；预期状态反馈满足 100 ms/3 秒规则，三次结果和资源 transfer size 写入实现验证记录。

### Task 7：版本、完整验证、安全审查与发布门

**Files**

- Modify: `package.json`
- Modify: `package-lock.json`

**Consumes**

- `WeakNetworkAcceptanceEvidence v1` 与 Tasks 1-6 的全部 production/test outputs。

**Produces**

- `VerifiedReleaseCandidate v1.27.0`：同步版本、完整验证、安全审查和可执行 rollout 记录。

**Covers**

- FR-008、FR-010。

**Acceptance Criteria**

- `package.json`、`package-lock.json` 根版本与 root package version 均为 `1.27.0`。
- 完整 lint/unit/integration/e2e/build 全部通过；无临时文件、无无关改动。
- 按 `skills/billboard-security-review/SKILL.md` 输出 Findings、Verification、Residual Risk；没有 P0/P1 或未闭环 P2。
- 安全审查证明 session 家庭边界、整数分、上海时间、手工来源字段、浏览器存储最小化、无真实 host/凭据和生产入口不变。
- 提交/推送前检查当前分支为 `master`、与 `origin/master` 差异和工作区范围；只有全部 gate 通过后才能按 AGENTS.md 进入 commit/push/restart。
- 生产在已加载私有 env 的环境中复用 bootstrap service 但覆盖其 command，只运行 `prisma migrate deploy`，不得为本功能执行 seed；随后重启 web，并通过 nginx 根路径入口或 loopback fallback 检查 `/login` 与一次记账 smoke。

**Verification**

```powershell
npm run lint
npm run test:unit
npm run test:integration
npm run test:e2e
npm run build
git status --short
git diff --stat
git branch --show-current
git fetch origin master
git diff --stat origin/master...HEAD
```

安全文本检查（引用输出前先人工确认没有真实秘密）：

```powershell
rg -n "AUTH_SECRET|NEXTAUTH_SECRET|POSTGRES_PASSWORD|DATABASE_URL|NEXT_ALLOWED_DEV_ORIGINS|APP_BASE_PATH|frp|nginx|ECS|password|secret|token" docs/features/weak-network-accounting src prisma tests package.json package-lock.json
rg -n "deletedAt|householdId|memberId|sourceFingerprint|amountFen|Asia/Shanghai|clientRequestId" src tests prisma docs/features/weak-network-accounting
```

生产 rollout 只在实现、验证、review、版本和 Git gate 全部通过后执行；Planning Authorization 本身不授权运行：

```powershell
.\ops\podman\compose.ps1 -f podman-compose.yml --profile bootstrap run --rm bootstrap sh -lc "npx prisma migrate deploy"
.\ops\windows\start-production.ps1
Invoke-WebRequest http://127.0.0.1:3000/login -UseBasicParsing
```

预期：migration 在新应用前完成，生产入口仍为 loopback/nginx 约束，登录页和记账 smoke 通过。

## 7. Requirement coverage self-check

| Requirement | Task(s) | Verification seam |
| --- | --- | --- |
| FR-001 | Task 1, Task 6 | asset size unit test、production build、弱网 transfer size |
| FR-002 | Task 2, Task 6 | navigation unit/e2e pending 与 skeleton |
| FR-003 | Task 2, Task 6 | deferred integration mock、400 Kbps/800 ms 实验 |
| FR-004 | Task 5, Task 6 | draft unit test、reload e2e |
| FR-005 | Task 4, Task 5, Task 6 | Action integration、create e2e、slow save e2e |
| FR-006 | Task 3, Task 4, Task 6 | serial/concurrent integration、event test、retry e2e |
| FR-007 | Task 5, Task 6 | draft/state unit seam、transport failure e2e |
| FR-008 | Task 2, Task 3, Task 4, Task 5, Task 7 | auth/scope integration、security review、text scan |
| FR-009 | Task 4, Task 6 | invalidation integration、home/records e2e |
| FR-010 | Task 1-7 | targeted commands、full suite、build、weak-network lab、release gates |

## 8. Planning quality gate

- RequirementsCoverage: Pass。`FR-001..FR-010` 均至少映射一个顺序 Task 和一个可执行或明确 manual verification seam。
- TaskCompleteness: Pass。七个 Task 均包含精确 Files、Consumes、Produces、Covers、Acceptance Criteria 和 Verification。
- ContractConsistency: Pass。`DecorativeAssetSet v1`、`ResponsiveNavigationShell v1`、`IdempotentTransactionCreateResult v1`、`CreateTransactionActionResult v1`、`PostCreateInvalidation v1`、`TransactionDraftV1`、`WeakNetworkFormState v1` 与 `WeakNetworkAcceptanceEvidence v1` 的生产和消费命名一致。
- RepositoryFeasibility: Pass。全部 Modify/Test 路径存在，Create 路径精确；`package.json` 中存在所列 npm scripts，Prisma、Playwright、Podman wrapper 与 production restart 路径和仓库现状一致。
- ConstraintAlignment: Pass。保留家庭 session scope、`amountFen`、`Asia/Shanghai`、手工来源为空、软删除/导入 non-goals、双语 UI、nginx/loopback 入口和无真实凭据/host 规则。
- AutoFixSummary:
  - 将 production rollout 从完整 bootstrap（migration + seed）修正为覆盖 bootstrap command、只运行 `prisma migrate deploy`，避免本功能无关的账号 seed/凭据变更。
- ResidualRisks:
  - `sessionStorage` 中的金额和备注仍可能被同源脚本、浏览器扩展或能操作设备的人读取；范围已限制为当前标签页和当前成员 key。
  - 3 秒/4 秒绝对时延会受宿主与生产网络影响；CI 只锁定资源预算和状态机，仍需三次弱网实验记录。
  - WebP 有损压缩可能产生视觉伪影，必须执行移动端视觉 smoke。
  - production migration 命令仍依赖已正确加载的私有生产 env；执行前必须确认目标数据库且不得连接开发/e2e 清理流程。

Planning Quality Status: Pass

## 9. Authorization boundary

本 plan 只授权本地 planning artifacts。它不授权修改业务代码/测试、创建分支、commit、push、PR、merge、discard、migration 执行或生产重启。进入实现仍需独立的 `$implement` workflow，并保留 branch、scope、review、verification、commit 与 push gate。
