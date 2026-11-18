# 首页月度结余趋势 Implementation Plan

> **For agentic workers:** REQUIRED SKILL: Use implement to execute this plan task-by-task. Respect the handed-off git_state: inherit prepared, otherwise prepare; use git-workflow for checkpoint/finalize. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 首页趋势卡片按「收支趋势 / 结余趋势 / 累计结余」切换，并保留同范围的明细入口。

**Scope Source:** [已批准 spec](../../scope/2026-11-06-home-monthly-balance-trends.md)，用户于 2026-11-06 明确认可最新版离线设计并要求实施。

**Architecture:** 从既有趋势聚合结果派生月度收入、支出、结余和累计结余，不新增交易查询。共享报表输出 `balanceTrend`，未加密及加密路径复用相同纯函数；`TrendChart` 转换日期和明细链接后，客户端图表负责切换和选点。

**Tech Stack:** Next.js 16、React 19、TypeScript、现有 SVG / Tailwind、Vitest、Playwright、Prisma。

**Verification:** 聚合与组件 RED/GREEN；查询和加密一致性集成检查；首页移动／英文 e2e；完整 lint、unit、integration、e2e；安全审查和正式登录页 smoke。

---

## 执行及 Git 约束

继承 `feature-home-monthly-balance-trends` 与同名 `.worktrees/`，基线 `v1.66.0`，已有任务文件为 spec 和离线 HTML/CSS/JS；主工作区已有未跟踪 `.agents/`、`.claude/` 不归本任务。按 Git 偏好，checkpoint 不单独提交；全部验证通过后统一 feature 提交、合回并推送 `master`，正式启动从干净且已推送的 `master` 执行。用本机 Git exclude 隔离未跟踪工具目录，并由 `.dockerignore` 排除镜像构建，不修改或提交目录内容。

## Task 1：月度派生统计

**Files:** `src/lib/reports/aggregate.ts`、`src/lib/reports/balance-trend.ts`、`src/lib/reports/query-home-report.ts`；`tests/unit/report-balance-trend.test.ts`、`tests/integration/report-query.test.ts`、`tests/integration/encryption-imports-reports.test.ts`。

**Acceptance:** `HomeReport.balanceTrend` 为 `{ granularity: "month", points }`；点保留 `ReportTrendPoint` 字段并增加整数分 `cumulativeNetFen`。按上海月份归并原趋势，裁剪桶到主范围，累计初值为 0，不改变原 `trend` 或新增数据库读取。

- [x] 先通过现有 `aggregateHomeReport` 入口添加缺少月度序列的失败断言，运行 `npx vitest run tests/unit/report-balance-trend.test.ts`，确认因缺少行为失败。
- [x] 实现共享派生函数，并接入聚合入口及未加密 SQL 聚合结果合并处；加密路径从同一聚合入口获得结果。
- [x] 验证月结余 `300000,-100000,200000` 对应累计 `300000,200000,400000`；覆盖日转月、上海日界、闰日、首尾部分月、空月、单点、负值、全零、原输入不变。
- [x] 扩展查询及加密同数据断言，核验成员／账本范围、历史／归档和软删除均沿用原授权；运行针对性 unit / integration。
- [x] checkpoint：记录针对性验证；按偏好不单独提交。

## Task 2：趋势卡片与明细

**Files:** `src/components/trend-chart.tsx`、`src/components/trend-chart-plot.tsx`、必要的局部 `trend-chart-views.tsx`；`src/app/(app)/home/view.tsx`；`src/lib/i18n.ts`；`tests/unit/trend-chart-plot.test.tsx`、`tests/unit/trend-chart.test.tsx`。

**Acceptance:** 顺序和外观匹配获批预览；默认收支，另两项均为月度折线；显示零轴和负值，单点／全零不除零；图表、详情、aria 数值一致。

- [x] 先添加三个视图、默认收支及所选序列的 SSR 行为断言，运行聚焦组件测试并确认缺少新行为的失败。
- [x] 保留现有共享视图中的链接转换与原收支接口，新增只接收序列化点的客户端视图切换；接入月度数据和中英文标签。
- [x] 实现月结余／累计的有符号坐标和明细：日期段、收入、支出、月结余、笔数，累计视图额外累计值；仅有记录月份提供当月记录链接。
- [x] 使用原触屏、方向键、Home/End 和可见焦点；数据／范围变化不能复用旧点详情，不增加本地持久化或请求。
- [x] 运行聚焦组件测试；checkpoint 不单独提交。

## Task 3：首页流程与完整验证

**Files:** `tests/e2e/home-balance-trend.spec.ts`，必要的既有首页断言；应用文件仅修正本任务引入的问题。

**Acceptance:** 真实首页默认和切换正确，单月保留收支按日、新图单点，明细保留账本／成员／主范围；移动中文、英文无横向溢出。

- [x] 使用开发数据库 fixture 构造三个完整月收支和一个范围外记录，验证月结余原值、累计结果和空月详情。
- [x] 检查切换、日期筛选、键盘选点、成员／账本过滤、当月明细及中英文手机截图；已有 home-drilldown 回归通过。
- [x] 完成 `npm run lint`、`npm run test:unit`、`npm run test:integration`、`npm run test:e2e`。测试不得连接生产数据库；共享同一数据库的 integration 与 e2e 不并行。即使使用独立数据库，重负载套件仍串行完成最终验证，避免影响既有导出容量时限。
- [x] 遇到失败先定位、修复或采用等价可靠验证，不削弱断言。保留实际失败与恢复证据。

## Task 4：知识与发布

**Files:** `docs/wiki/home-trends.md`、`docs/wiki/wiki.md`、`package.json`、`package-lock.json`、本 plan；最终实际变更面。

- [x] 使用 wiki 技能记录实际计算、范围、三视图与权限边界；按 write-doc 完成审校及只读独立复核。
- [x] 按 `skills/billboard-security-review/SKILL.md` 审查并输出 Findings、Verification、Residual Risk；修正阻塞问题，必要时重跑失效验证。
- [x] 当前基线版本 `1.66.0`，本次 feature 同步为 `1.67.0`；最终提交前重新核对远端及版本，明确冲突按代码证据解决。

提交后的收尾顺序如下；实际提交、推送、健康检查和清理结果记录在本次交付回复中。

1. 全部验证和安全审查通过后统一提交，安全 fast-forward 合回 `master`，推送并核对实际远端 SHA。
2. 从已验证、已推送且不含无关修改的 `master` 运行 `ops/windows/start-production.ps1`，核对镜像提交、容器健康、登录页及 JS chunk；不执行 seed。
3. 发布成功后清理干净的本任务 worktree 和分支；finalize 报告实际结果和剩余风险。

## 验证记录

记录由实际执行结果更新，不将计划检查视为已通过。

- 月度派生 RED：现有聚合入口缺少 `balanceTrend`，1 failed；实现后同一断言 1 passed。
- 聚焦 unit：`npx vitest run tests/unit/report-balance-trend.test.ts tests/unit/report-aggregate.test.ts tests/unit/report-range.test.ts`，3 files / 47 tests passed；六个数据文件定向 ESLint 通过。
- UI RED：两个组件文件共 6 项，原键盘选择通过，新增 5 项因缺少切换、月度链接及有符号图形行为失败。

- UI GREEN：6 项组件测试、目标文件 ESLint、`tsc --noEmit --incremental false` 通过。
- 数据集成：`report-query` 与 `encryption-imports-reports` 两文件 12 项通过。
- 聚焦 e2e：新增两项及原 `home-drilldown` 共 3 项通过；已核对 320px 英文和 390px 中文实际截图。
- 全量 lint 通过；全量 unit 首轮敏感样本扫描在并行负载下超时，独立复测 2 项通过，不改断言／超时；关闭文件并行后 151 文件、1420 项通过、1 项既有跳过。
- 集成首轮 78 文件通过；发现旧 mock 缺少新字段，以及两项套件未获得全局开发库环境。已补齐 typed mock、原 21 项断言通过；现显式传入开发库 URL 重跑全套。
- 为避免 e2e 清理共享数据，确认 e2e 无硬编码数据库后，新建本机 `billboard_trends_20261106_test`（创建前查证不存在），执行迁移及示例 seed；完整 e2e 使用此库，与开发库上的集成测试并行。生产库未参与。
- 完整 e2e：234 项通过、1 项既有跳过，用时 14.6 分钟。服务退出后确认临时库连接数为 0，仅删除本任务新建的测试库，并还原 Next.js 生成的类型路径配置。
- 集成第二轮：80 文件、1159 项通过；既有 10 万行加密导出用例在并行重负载下触及生成时限。保留生产限额和原断言，待 e2e 结束后使用显式开发库环境串行重跑完整集成套件。
- 集成最终串行运行：81 文件、1160 项全部通过，用时 611.48 秒。10 万行加密导出生成用时 36160 毫秒，低于原 60000 毫秒限制。

## 提交前安全审查

- **Findings：** 没有发现阻塞问题。月度派生仅消费既有授权聚合；身份、家庭、成员、账本和软删除边界保持一致，无新增财务日志或客户端持久化。
- **Verification：** 完整 lint、unit、integration、e2e 通过；TypeScript、23 项安全配置检查及针对性权限／加密／金额日期断言通过。离线预览嵌入源码与 sidecar 一致，独立目录及 sandbox 预览无外部请求；25 文件范围、三个版本字段和文档经独立复核，生成文件未进入提交。
- **Residual Risk：** 提交前运行验证已完成；提交、推送及正式服务健康检查仍按上述顺序执行，以实际结果为准。
