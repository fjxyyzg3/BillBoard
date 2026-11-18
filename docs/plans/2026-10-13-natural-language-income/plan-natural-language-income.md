# 自然语言收入支持 Implementation Plan

> **For agentic workers:** REQUIRED SKILL: Use implement to execute this plan task-by-task. Respect the handed-off git_state: inherit prepared, otherwise prepare; use git-workflow for checkpoint/finalize. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有自然语言入口原子记录人民币收入、退款和混合收支，并安全兼容旧请求。

**Scope Source:** `docs/scope/2026-10-13-natural-language-income.md`，已批准。

**Architecture:** v2 协议返回带类型的统一交易数组，应用重验分类类型后与版本化摘要同事务提交。新页面声明结果能力为 `resultVersion: 2`，旧脚本调用返回未知结果并保留 UUID，刷新查询完成确认。新摘要包含总笔数、收支各自笔数／金额；旧摘要按原值转换为纯支出展示，原身份键和终态不变。

**Tech Stack:** Next.js 16、React 19、TypeScript、Zod、Prisma 6、PostgreSQL 17、Codex ACP、Vitest、Playwright。

**Verification:** lint、unit、integration、e2e、build；真实 ACP 合成样例、安全审查、远端／镜像 SHA、生产登录与静态资源／内部 Agent 检查。

---

## Task 1：批准记录与知识同步

- [x] 继承 `codex/natural-language-income` worktree／文件所有权，记录批准，不重复 prepare。
- [x] 同步已确认的 `docs/wiki/natural-language-accounting.md`、`docs/wiki/wiki.md`，保留原支出历史基线。
- [x] 计划覆盖 Spec；checkpoint 按 Git 偏好不单独提交文档，与本次实现合入一个 feature。

## Task 2：收入链路与兼容能力

此工作单元由主 agent 与独立文件所有权的子任务协作完成；它作为唯一 `in_progress` 单元，不并行标记多个完整任务。

### 协议／Agent 文件

**Files:** `src/lib/transactions/natural-language-protocol.ts`、`agent/acp-classifier.ts`、`tests/unit/natural-language-protocol.test.ts`、`tests/unit/natural-language-agent-runtime.test.ts`、`tests/fixtures/agent/acp-fixture.mjs`；如必要仅配套修改 `agent/server.ts`。

- [x] RED：在既有 validator 上用 v2 分类类型及统一交易数组验证工资收入、混合和同名不同类型，确认因原协议缺失而失败。
- [x] 请求和响应使用 `natural-language-entry.v2`；候选与交易带 `INCOME`／`EXPENSE`，响应使用 `transactions`，类型与分类一致，整数分／日期／偏移／严格字段继续校验。
- [x] 固定提示覆盖收入获得者、退款新增收入、纯转账与明确收入到账；运行器、分类建议、认证、工具禁用及共享 busy 保持原边界。
- [x] GREEN：协议与两个运行器 unit 通过，保留权限拒绝、HTTP 边界、取消和清理回归。

### 应用服务／结果文件

**Files:** `src/lib/transactions/natural-language-types.ts`、`natural-language-entry.ts`、`src/app/(app)/add/natural-language-actions.ts`、`tests/integration/natural-language-entry.test.ts`、新增 `tests/unit/natural-language-results.test.ts`；HTTP 客户端仅在实际需要时配套修改。

- [x] RED：真实开发 DB 与 HTTP fixture 返回工资 800,000 分和午饭 3,500 分，断言两类交易、各自摘要及来源为空，验证现有仅支出服务拒绝该行为。
- [x] 共享结果契约为 `resultVersion: 2`、`count`、`incomeCount`、`expenseCount`、`incomeAmountFen`、`expenseAmountFen`；成功守卫验证计数与金额范围，缺旧字段时不宣告成功。
- [x] 读取两类分类并重验类型，按每笔显式类型 `createMany`，版本化摘要与交易同事务保存，旧成功快照严格识别后按原金额／笔数返回纯支出结果。
- [x] Action 先认证再检查调用方能力；新提交声明 `resultVersion: 2`，新查询第二参数为 `2`。缺失／不支持能力只返回 `unknown`，不受理新写账、不关闭请求、不返回新版成功；刷新后新客户端使用同 UUID 查询。服务内部输入允许能力字段但不将其作为身份或摘要的一部分。
- [x] 新结果及旧错误重放保留原终态，旧收入拒绝不重开；分类中途改类型和真实写入失败全批拒绝。首次成功按收入／支出类型各记最小活动，重放不重复。
- [x] GREEN：覆盖收入、退款原支出不变、同名分类、混合回滚、旧结果在交易改型／删除后不变、非法新快照、旧终态及旧 Action 能力边界；保留原家庭／会话／竞争／过期集成测试。

### 页面／浏览器文件

**Files:** `src/components/natural-language-form.tsx`、`src/lib/i18n.ts`、`tests/unit/natural-language-form.test.tsx`、`tests/e2e/natural-language-accounting.spec.ts`、`tests/e2e/agent-fixture.ts`。

- [x] RED：真实组件 SSR 期望“收支描述”／“Describe transactions”，先证明当前仅支出文案不满足。
- [x] 输入仍只有文本框和导入按钮，新页提交／查询传能力 `2`，成功必须经过共享新结果守卫才能清除 UUID。旧形状成功或无法展示的结果保持未知，冻结快照并支持确认。
- [x] 中英文分别显示纯收入、纯支出或混合的笔数／方向合计；错误、帮助和示例支持收入；保留移动操作栏、双草稿与仅 UUID 存储。
- [x] 真实 HTTP fixture 解析合成收入／退款／混合和成员、日期；浏览器验证混合摘要／记录、整批纠错、退款、旧响应形状冻结及刷新确认、旧能力调用不写账，以及既有成功／失败丢响应恢复。
- [x] GREEN：组件、针对性 e2e 和现有手工／文件导入回归通过；共享开发库的 integration/e2e 由主 agent 串行运行。

## Task 3：验证、安全与交付准备

- [x] README 更新现有入口、收支／退款边界及结果能力兼容；Wiki 补充实际稳定知识，仅修改已确认的两份页面。
- [x] feature 版本基于最新 master 递增 minor，预计 `1.43.0`；同步 package 和 lock 根字段。
- [x] `npm run lint`、`npm run test:unit -- --maxWorkers=2`、显式加载开发环境的 `npm run test:integration -- --maxWorkers=2`、`npm run test:e2e`、`npm run build` 全部通过，不改变测试时限或断言。
- [x] 隔离 Agent 镜像及真实 ACP 合成工资、退款、混合、成员／日期、模糊信息、纯转账、原支出与分类建议 smoke；不接触真实账本，临时探针使用忽略目录中的 `.mjs`，避免进入 TypeScript 构建扫描。
- [x] `skills/billboard-security-review/SKILL.md` 审查实际改动，记录 Findings、Verification、Residual Risk；核验身份／分类类型／终态／原子性、客户端能力、日志存储及容器边界。

## Git 与发布收尾

验证后交由 `git-workflow finalize` 处理任务文件的单个 feature 提交，刷新／rebase 后 fast-forward 合回 master，不创建 PR。推送并核对实际远端 SHA，再从干净已推送 master 执行 Windows 正式启动脚本，已有生产库不 seed；核验镜像提交、服务／OPS、登录与静态资源、已发布的内部 Agent 合成请求，成功后清理任务 worktree／分支。实际提交、发布与清理证据进入最终交付报告。

## 执行证据

批准前 Review Spec 使用专用 `gpt-6-astra/high` reviewer，P0/P1/P2 = 0/0/0；特别要求落实旧页面不能误报摘要或清除待确认 UUID。Spec-only 自审、引用与敏感值扫描已通过。实现阶段按上述单元更新实际 RED/GREEN 和最终验证证据。

收入／混合协议在旧 validator 上 RED，v2 GREEN（最新协议 59 项）；原 SSR 标签两项 RED，组件与默认手工入口 GREEN（3 项）。混合服务真实 DB RED 返回 UNAVAILABLE，新实现针对性集成 43 项 GREEN。完整 unit 已通过 64 文件／507 项，1 项既有 Windows 进程组跳过；Docker 恢复后完整 integration 再次通过 30 文件／489 项。

验证期间 C 盘满引发 ENOSPC 及 Docker metadata I/O，已回收可重建 npm／构建缓存并移走临时下载，重启 Docker；原正式服务健康、登录页 200。磁盘满期间的验证镜像发现空依赖文件，已移除并禁用相关阶段缓存重建，不复用该产物。

新版自然语言浏览器 15 项全部通过，含原支出、纯收入、混合、退款不动历史、成员／上海日期、中英摘要及新旧页面能力／丢响应恢复。首轮完整 e2e 为 97 passed、1 failed、1 个既有可选弱网性能 skip；失败的既有分类建议批次用例当时仍在首批处理，停用并行构建后原样定向重跑通过，完整重跑已通过（98 passed，1 个既有可选性能 skip），原断言与时限保持不变。

隔离重建 Agent 镜像依赖文件有效，真实 gpt-6-luna/high 的 9 个合成样例全部通过：工资转账到账、退款、奖金收款成员与混合日期、原支出付款成员、缺收入金额、自有账户转账、混合外币、未知获得者、原分类建议。没有数据库网络或真实账本输入。

最终完整验证：lint、unit（64 文件／507 passed + 1 既有平台 skip）、integration（30 文件／489 passed）、e2e（98 passed + 1 既有可选性能 skip）与 build／TypeScript／静态页全部通过。开发生成的 next-env.d.ts 已由生产 build 恢复，Git 无此文件差异。

安全审查通过：Findings P0／P1／P2 = 0／0／0；Verification 为实际差异／敏感新增内容检查、安全配置及结果契约 34 项独立 unit、以上完整测试／构建及 9 个真实 ACP 合成样例；Residual Risk 为 AI 结构合法但语义误判的可能性，以及未新增、未逐项重评的既有 npm audit 26 项风险。提交、推送及新版本生产 SHA／健康／内网合成 smoke 仍由后续 Git 与发布阶段核验，不提前宣称完成。
