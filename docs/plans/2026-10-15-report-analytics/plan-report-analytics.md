# 家庭报表分析增强实施计划

> **For agentic workers:** REQUIRED SKILL: Use implement to execute this plan task-by-task. Respect the handed-off git_state: inherit prepared, otherwise prepare; use git-workflow for checkpoint/finalize. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成既有家庭账本的六类统计视图、月度摘要、共享日期范围和可追溯明细。

**Scope Source:** `docs/scope/2026-10-15-report-analytics.md`；用户已要求实现，随后排除预算、商户和固定支出全部功能。

**Architecture:** 共享上海日期范围驱动服务端数据库聚合和记录明细。首页组合现有总览与新的可切换分析图表，不改变数据库模型或交易金额。

**Tech Stack:** Next.js 16、React 19、TypeScript、Prisma 6、PostgreSQL 17、现有样式与图表依赖。

**Verification:** `npm run lint`、`npm run test:unit`、`npm run test:integration`、`npm run test:e2e`，移动页面观察及安全审查。

---

## Git 上下文

- 根工作区 `D:/GithubRepos/BillBoard`，基线 `master` / `origin/master`，开始时无修改。
- 任务分支 `codex/report-analytics`，任务工作区 `.worktrees/report-analytics`；依赖在任务目录单独安装。
- 所有检查通过后将规格、计划和实现合为一个 feature 提交；版本目标 `1.50.0`。不推任务分支，最终从 master 推送和发布。
- checkpoint 记录验证证据，不单独提交规格或未完成实现；主 agent 统一 Git 收尾。

## Task 1：日期范围与比较

**Files:** `src/lib/reports/report-range.ts`、`src/lib/app-navigation.ts`、`tests/unit/report-range.test.ts`、`tests/unit/app-navigation.test.ts`。

**Acceptance:** 月/年/全部兼容；recent/custom 解析与导航保留；比较正确处理闰日、短月、当前周期及等长自定义范围。

- [x] 写入针对 2026-03-31 上期截为 2026-02-28、2024-02-29 同比、recent 三个月边界、非法日期与自定义相邻范围的行为测试。
- [x] 运行相应单元测试并记录功能缺失导致的 RED。
- [x] 实现扩展范围、共享参数序列化和比较日期计算。
- [x] 重跑范围及导航测试，确认 GREEN；记录 checkpoint，不提交。

## Task 2：分析聚合与安全查询

**Files:** `src/lib/reports/analytics.ts`、`src/lib/reports/query-report-analytics.ts` 及相应 `tests/unit/report-analytics.test.ts`、`tests/integration/report-analytics-query.test.ts`。

**Acceptance:** 两期统计、分类差值、累计值、日/月矩阵、金额分桶、中位数和前五笔占比准确；查询不返回其他家庭或软删除记录。

- [x] 为已知小账本写聚合断言：不同日期/分类、收入、支出、零基数、空账本、分桶边界、中位数偶数笔和前五笔数量不足。
- [x] 运行测试确认缺少新分析功能的失败，然后实现纯聚合接口。
- [x] 以数据库 groupBy/参数化 SQL 查询聚合数据，统一验证当前家庭成员，不逐笔查询或向客户端返回历史明细。
- [x] 补充另一家庭及软删除交易 fixture、基期无数据和查询明细总额一致性集成测试。
- [x] 运行聚合单元测试和针对性查询测试；记录 checkpoint，不提交。

## Task 3：报表展示与范围交互

**Files:** `src/components/report-range-controls.tsx`、新增报表图表组件、`src/lib/i18n.ts`、`src/app/(app)/home/page.tsx`、`src/app/(app)/records/page.tsx`、必要的记账页范围传递组件。

**Acceptance:** 六类视图和月度摘要可见可操作，移动界面可读，所有明细链接使用同一范围且金额过滤不泄漏明文。

- [x] 扩展范围控件测试，覆盖自定义起止、错误输入保留、recent 切换和导航状态。
- [x] 实现对应中英文文案、日期选择及响应式分析组件；沿用现有视觉样式。
- [x] 集成首页：总览、周期比较、图表切换和月度摘要。保持旧汇总及分类明细入口可用。
- [x] 集成 records/add 导航范围，复用加密金额 token 生成分布区间明细链接。
- [x] 通过组件测试与 targeted e2e；检查手机布局、键盘操作、空态及英文展示；记录 checkpoint。

## Task 4：完整验收与发布

**Files:** 必要 e2e 回归用例、`package.json`、`package-lock.json`、本计划验证记录。

**Acceptance:** 所有验收成立，完整检查和安全审查通过，已验证提交发布后健康检查通过。

- [x] 确认测试仅连接 `billboard_dev` / 测试数据库；启动开发数据库并应用既有迁移，不触碰生产账本。
- [x] 运行 lint、unit、integration、e2e，调查并修复本次范围内失败。
- [x] 以实际 diff 运行 billboard-security-review，记录 Findings、Verification、Residual Risk。
- [x] 同步版本 `1.50.0`，检查只包含本任务改动，刷新并同步 origin/master。

### 提交后的收尾

以下操作在本计划与实现一并提交后执行，最终提交 SHA、推送及健康检查证据记录于交付回复。

- 使用 git-workflow finalize 提交，fast-forward 合并至 master，推送并校验远端 SHA。
- 从已推送 master 运行既有 Windows 生产启动脚本，执行健康检查，清理本任务干净 worktree/branch。

## 验证记录

- 初始化：根工作区干净；`git fetch origin` 成功，master 与 origin/master 无差异；任务工作区已创建，`npm ci --no-audit --no-fund` 成功。
- 变更边界：无预算、商户、固定支出模型或数据库迁移。新增 SQL 仅用于聚合现有交易。
- 日期范围：先确认 RED 22 failed / 7 passed，再实现并通过范围与导航测试；额外校验短月、闰日、公元 0001 边界和自定义空白历史。
- 分析查询：先确认功能缺失 RED，再通过 16 项纯聚合及 6 项真实数据库测试；SQL 使用同一 RepeatableRead 快照，覆盖家庭隔离、软删除和金额下钻一致性。
- 页面集成：records/home 18 项集成测试通过；原趋势月桶超出自定义范围的回归由 RED 修复至 GREEN；低年份日期构造回归通过。
- 组件：日期控件与报表视图 16 项单元测试通过；六种视图的移动端下钻、自定义日期、错误输入保留、月份连续切换、中英文及导航回原范围的 e2e 均通过。
- 完整单元：`npm run test:unit -- --maxWorkers=4`，79 文件、771 项通过，2 项既有 Windows 跳过。首轮与集成/lint 同时运行导致 3 项耗时测试超时；限制并发后按原超时与断言通过。
- 完整集成：按 README 设置本机开发库 `DATABASE_URL` 和开发 `AUTH_SECRET`，执行 `npm run test:integration -- --maxWorkers=4`，34 文件、536 项通过。首轮缺少显式环境变量及旧页面日志测试未接入新增查询 fixture，均已修正。
- 完整 E2E：`npm run test:e2e` 覆盖 126 项，124 通过、1 项既有生产弱网性能用例跳过、1 项新测试因语言菜单遮挡按钮失败。补齐关闭菜单的正常用户操作后，`npm run test:e2e -- tests/e2e/report-analytics.spec.ts` 两项均通过；其余未变代码的成功证据沿用。最终覆盖为 125 项通过、1 项既有跳过。
- 构建与静态检查：最终 `npm run lint`、`npm run build` 均通过，Next.js TypeScript 检查通过。既有 middleware 废弃提示及 Browserslist 数据提示未扩大处理。
- 视觉验收：已查看 390px 中文金额分布和英文自定义日历截图，无页面横向溢出；金额筛选使用不透明 token，日历/累计键盘操作及分类月度下钻均已验证。
- Git 检查：版本三处均为 `1.50.0`；刷新 origin 后仍与开始基线一致，无其他提交需要整合；仅纳入本任务文件。

## 安全审查

### Findings

无阻塞安全问题。新查询从已验证会话派生家庭和成员，并二次验证归属；参数化 SQL 统一限制家庭、成员和软删除条件。统计只读，无 schema、迁移、外部请求或历史交易改写。

金额下钻复用家庭绑定的加密 token，不新增原始备注、批量交易明细日志或客户端持久化。新增文案包含中英文，未引入预算、商户排行或固定支出相关模型。

### Verification

上述完整单元、集成、E2E、lint 和生产构建证据有效。真实数据库测试包含另一家庭、伪造成员、软删除、未来记录、金额桶边界和明细总额核对；新增文件及 diff 检查未发现真实凭据、生产入口或新增不安全 SQL。

### Residual Risk

两个平台相关单元用例在 Windows 上按原配置跳过；独立生产弱网性能用例需要专用生产构建测试入口，本次按原配置跳过。外部转发和音频服务配置未改动，本次未重新核验其日志或公网访问限制；发布后执行既有本机健康检查。
