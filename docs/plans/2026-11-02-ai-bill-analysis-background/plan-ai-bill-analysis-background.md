# 账单分析后台生成 Implementation Plan

> **For agentic workers:** REQUIRED SKILL: Use implement to execute this plan task-by-task. Respect the handed-off git_state: inherit prepared, otherwise prepare; use git-workflow for checkpoint/finalize. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 已提交的账单分析在手机离开后继续，重开从报告列表发现状态及结果。

**Scope Source:** [已批准 spec](../../scope/2026-11-02-ai-bill-analysis-background.md)

**Architecture:** 短 POST 将执行交给原 web 进程内的限时运行器，Next `after` 跟踪完成 Promise。原会话和独占加密上下文贯穿固定快照、分批、保存及清理；报告槽按范围展示最近尝试与旧成功报告，家庭只读发现不改变执行授权。

**Tech Stack:** Next.js 16、TypeScript、React、Prisma/PostgreSQL 17、Vitest、Playwright、Docker Desktop。

**Verification:** 针对性 RED/GREEN；完整 lint、unit、integration、e2e；真实 standalone 关闭所有客户端连接验证；安全审查、备份及发布健康检查。

---

## 执行上下文

- 工作区：`.worktrees/feature-ai-bill-analysis-background`；分支：`feature/ai-bill-analysis-background`；基线：`v1.62.0`。
- 继承 `git_state: prepared`。开始时仅有本任务 spec，无其他修改。spec 已由用户批准，专用 Astra review 的 P0/P1/P2 为 0/0/0。
- 主 agent 负责运行器、任务加密上下文、route/service/owner、端到端、文档与统一验收/Git。存储协作者负责 store/types/Prisma/恢复兼容及其测试；界面协作者负责 controller/provider/panel/i18n 及其单元测试。各自不修改对方文件，不提交或发布。
- 数据库测试互斥；单元测试可并行。开发库仅用本地 `_dev`/`_test`，模型与端到端使用合成输入。正式服务及真实入口、私有配置不用于开发测试。
- checkpoint 继承仓库偏好：spec/plan 不单独提交，最终与验证后的实现组成一个 feature 提交；只从 master 推送及发布。

## 共享接口

- 新增 `operation: "entries"` 家庭只读发现：`{ entries, cursor, active }`，每页最多 20 槽，活动项独立返回，防止分页漏掉当前任务。保留旧 `list` 成功报告读取兼容。
- `BillAnalysisEntryDto`：`id, scope, scopeLabels, updatedAt, report, task`。`report` 为原 `BillAnalysisReportListItem | null`；`task` 为最近尝试的最小状态或 null。
- `BillAnalysisTaskDto`：`id, status, phase, completedBatches, totalBatches, error?, startedAt, updatedAt, canCancel, requestId?`。status 沿用 processing/stopping/error/success；UUID 仅原有效会话可见，canCancel 还要求活动状态。
- store 导出 `listBillAnalysisEntries(session,cursor?,locale?)`、`updateBillAnalysisProgress(session,requestId,progress,lease)`；原 query 回执可附实际进度但不改变幂等语义。
- service 的生成函数新增可选提交回调，在登记、执行控制器接管后提供 processing/原终态，后续流水线仍由同一 Promise 完成。该回调异常必须进入原清理路径。

### Task 1: 接管授权及固定实施边界

**Files:** spec、本 plan、相关本地 Next 指南与测试配置。

**Acceptance:** 已批准范围、工作区和文件所有权可查；不二次要求计划批准。

- [x] 读取 spec、实施 skill、Git 上下文、AGENTS 和本地 Next `after` 指南。
- [x] 回写 spec 批准状态；建立本计划和跨协作者接口。
- [x] checkpoint：按已有 Git 偏好暂不提交，待实现和完整验证后统一提交。

### Task 2: 后台执行、状态存储与手机恢复

**Files:**
- Create: `src/lib/reports/bill-analysis-runtime.ts`、`src/lib/reports/bill-analysis-task-context.ts`。
- Modify: `src/app/api/reports/analyze/route.ts`、`src/lib/reports/bill-analysis-service.ts`、`src/lib/reports/bill-analysis-owner.ts`。
- Modify: `src/lib/reports/bill-analysis-store.ts`、`src/lib/reports/bill-analysis-types.ts`、`prisma/schema.prisma` 及必要索引迁移、`src/lib/encryption/recovery.ts` 的恢复校验。
- Modify: `src/lib/reports/bill-analysis-controller.ts`、`src/components/bill-analysis-provider.tsx`、`src/components/bill-analysis-panel.tsx`、`src/lib/i18n.ts`。
- Test: `tests/integration/bill-analysis-route.test.ts`、`tests/integration/bill-analysis-store.test.ts`、新增任务上下文与运行器测试、`tests/unit/bill-analysis-controller.test.ts`、`tests/unit/bill-analysis-panel.test.tsx`。

**Acceptance:** 登记前有跟踪/清理责任，短回执返回后独立执行；列表可恢复，UUID/取消权限不扩大；旧成功报告仍可读。

- [x] RED：原 route 的 generate 返回 JSON 提交回执；现有实现返回 NDJSON，因此 content-type 断言失败。
- [x] RED：新登记请求已经关联报告槽、准备中可从家庭发现；原实现只在正式受理才关联，断言 reportId 非空失败。
- [x] RED：无 sessionStorage 指针初始化后仍发现服务端活动任务；原控制器没有发现请求，pending 断言失败。
- [x] GREEN：实现先登记 `after` 完成 Promise 的运行器、独占 key ring 上下文、短回执及原服务清理。
- [x] GREEN：提前关联槽、受保护进度、有界家庭分页、当前会话只读/原会话操作与恢复白名单兼容。
- [x] GREEN：前台轮询、启动发现、未知状态及统一列表，中英文和原页面样式保持一致。
- [x] 回归：取消/保存竞态、注册异常/提交未知/清理失败、scope/语言固定、旧 UUID 和旧报告。
- [x] checkpoint：记录针对性证据；按同一 feature 提交偏好暂不提交。

### Task 3: 完整验收与运行证据

**Files:** `tests/integration/bill-analysis-service.test.ts`、`tests/integration/bill-analysis-owner.test.ts`、`tests/integration/bill-analysis-encryption.test.ts`、`tests/e2e/bill-analysis.spec.ts`、必要测试夹具。

**Acceptance:** spec 全部验收有真实证据，关闭整个客户端不取消服务端任务。

- [x] 真实数据库验证回执丢失/重复 UUID、其他家庭/历史身份拒绝、其他会话只读和显式取消竞态。
- [x] 验证 >20 槽、同时间游标、分页期间更新、最近失败与旧报告并存；只读取所选槽和必要最新请求。
- [x] 验证独占加密上下文在提交返回后继续、其他请求结束不破坏，结束时清空且无输入/密钥落盘；转换/换钥、v1/v2 恢复兼容。
- [x] 独立进程验证 owner 硬停止；数据库恢复后本地 settled 回收；不凭 TTL 释放、不重试模型或跨重启续跑。
- [x] Playwright 关闭整个 context，保留仍有效 cookie、清空 sessionStorage 后重新打开；读取同 UUID 完成结果，真实调用计数不增加。
- [x] standalone 自托管形态、隔离虚构家庭、受控延迟：所有观察连接消失时模型继续并最终保存；显式取消仍停止。
- [x] 中英移动视口检查状态、旧报告和取消权限，无水平溢出。
- [x] `npm run lint`、`npm run test:unit`、`npm run test:integration`、`npm run test:e2e` 全部通过；按环境加载开发 env，不降低断言。
- [x] checkpoint：保存验收证据，完整验证通过前不提交。

### Task 4: 文档、安全与发布收尾

**Files:** `docs/wiki/ai-bill-analysis.md`、相关 runbook/README、本 plan、`package.json`、`package-lock.json`。

**Acceptance:** 安全审查无新增阻塞，已验证提交推送并部署，任务资源清理。

- [x] 按实际实现同步 wiki 和运行维护说明，旧 spec 保持历史约束引用；spec/plan 不记录私有入口和秘密。
- [x] 安全审查覆盖原身份与家庭隔离、无执行凭据泄露、key ring 独占、取消/清理边界及迁移/恢复。
- [x] 最终 diff、私有值、版本一致性检查；feature 版本由 1.62.0 递增为 1.63.0（字段已同步，远端变化时按最终基线重核）。
- [x] 取得可恢复备份并核验。
- [ ] 刷新远端、rebase、唯一 feature 提交，再 fast-forward master，仅推送 master 并核对实际远端 SHA。
- [ ] 从干净、已验证、已推送 master 运行正式启动脚本，不执行 seed；核验迁移、镜像 revision、登录页及受保护接口。
- [ ] 清理本任务隔离资源、干净任务 worktree 和分支；保留私有验证证据，其他工作区不动。

## 验收与证据记录

本节随工作单元写入实际结果；不预填未执行的成功证据。最终 Git/发布结果在完成回复及私有发布记录中留存，避免为更新提交 SHA 再创建循环提交。

- 已确认：本次是“客户端离开后继续”，服务器重启按中断处理；取消及执行授权保持原会话绑定。
- 本阶段环境：开发 env 仅复制跟踪的示例，不复制生产配置。最初通过 junction 复用依赖，Next/Turbopack 拒绝根外解析；保留式移动 junction 后 `npm ci` 安装本工作区实体依赖，锁文件 hash 不变、主工作区依赖完整。未改开发配置或脚本。
- RED 证据：route 期望 `application/json`、实得 `application/x-ndjson`；store 准备态 `reportId` 实为 null；controller 无本地指针时 pending.scope 实为 undefined。三者均为目标行为断言失败，无编译或夹具故障。
- 初步 GREEN：route 边界 9/9；store 与恢复 50/50（18+32），包括加密分页不解密未选槽和 150 条损坏旧回执。controller 同一发现用例转绿，最终整合结果见下。
- 整合 GREEN：service/owner/encryption/resources 24/24、真实加密后台 3/3、controller/panel 28/28、聚焦 Playwright 6/6。注册激活异常先复现占用残留 1（预期 0），纳入原 try/finally 后通过；回调异常及已提交 claim 丢失回执均无模型调用且占用收敛。
- 自托管证据：`npm run build` 成功；standalone 在 2511 loopback 运行，关闭整个 Chromium 后 OS 确认 Established=0，此后仅数据库/假 Agent 观察到原任务成功，调用为 batch/batch/summary 共 3 次。cookie-only 新 Chromium 的 sessionStorage 为空，仍可读报告且调用不增。合成数据、进程与占用均清理；仅保留非敏感结果和 390px 截图。
- 全量验证：lint 通过；unit 136 文件、1,227 通过、1 个既有条件跳过（83.57s）；integration 76 文件、1,101/1,101 通过（471.23s，预载示例 env 后运行与 npm script 相同 Vitest runner）；e2e 220 通过、1 个既有 opt-in 生产弱网性能条件跳过（12.8min）。未削弱测试，开发服务器默认 Turbopack 入口通过。
- 最终静态安全审查无未关闭 P0/P1/P2。根版本一致为 1.63.0；32 个任务文件与主工作区 18 项私有值/入口候选本机比对为零命中，41 个相对文档链接有效，依赖内容未改变。恢复 Next dev 自动生成的 next-env 类型路径，不夹带生成漂移。
- 发布前备份：只读一致 dump 在无端口、独立 internal 网络的 PG17 空目标实际恢复；35 表全列数据、schema、外键/约束、历史 ID 和整数分统计一致，归档 SHA256 独立复核。临时容器、网络、密码及数据均清理，备份和安全结果保留在主工作区忽略目录；未停源写入或比较两个不同 live 快照。

### spec 验收映射

| 验收顺序 | 实际证据 | 提交前结果 |
| --- | --- | --- |
| 1 客户端全部离开后完成 | native standalone、Chromium 全退出、OS TCP 零连接期间完成 3 次调用 | 通过 |
| 2 无本机指针重开 | e2e cookie-only 新 context，sessionStorage 空，原 UUID/截止不变 | 通过 |
| 3 丢回执／重复 UUID | route、service、store 实际幂等和已提交丢确认故障 | 通过 |
| 4 交接故障 | after 注册、激活注册、回调异常、未知 claim 与本地 settled 回收 | 通过 |
| 5 共享只读权限 | store 跨家庭/新会话拒绝，e2e 双观察会话伪造取消不生效 | 通过 |
| 6 新失败保留旧正文 | store、e2e 刷新后成功替换及失败旧报告可读 | 通过 |
| 7 分页及有界读取 | 21 槽/同时间游标、150 条未选损坏加密回执不解密 | 通过 |
| 8 未知状态与查询 | controller 28 项和 route 9 项，无自动重发或重复扣额 | 通过 |
| 9 取消／保存竞态 | store、真实 HTTP service 及 e2e 显式取消 | 通过 |
| 10 原身份及模式失效 | service、真实加密 background、owner 和全量身份回归 | 通过 |
| 11 密钥独占与释放 | background 3 项真实 DB/crypto/HTTP，另一个请求结束不清任务 ring | 通过 |
| 12 硬停止／重启中断 | owner 独立子进程硬杀及停止证明、无 TTL 放行/续跑 | 通过 |
| 13 总量／时间／额度 | 原资源/prepare/协议及 service 全量回归，过期不登记不调用 | 通过 |
| 14 旧数据／恢复 | recovery 32 项含旧/新 progress、v1/v2、拒绝可执行态 | 通过 |
| 15 中英移动界面 | 390px 中英/重开/共享视口与 standalone 截图均目检 | 通过 |
| 16 完整验收 | 四项全量检查及安全审查；Git/发布收尾由 finalize 继续 | 检查通过，发布状态见最终记录 |

正式提交后的推送、部署与清理事实由最终回复和主工作区忽略目录的 `release-result.json` 记录；本计划保留提交前证据，不把尚未执行的 Git 动作提前勾为完成，也不为回写自身提交 SHA 创建额外版本提交。
