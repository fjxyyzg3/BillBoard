# 第一期家庭隔离与正式数据迁移 Implementation Plan

> **For agentic workers:** REQUIRED SKILL: Use implement to execute this plan task-by-task. Respect the handed-off git_state: inherit prepared, otherwise prepare; use git-workflow for checkpoint/finalize. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 保留原账号、有效登录态和全部业务数据，将现有入口贯通家庭有效身份与默认账本，并安全完成正式迁移。

**Scope Source:** `docs/scope/2026-10-21-multi-household-ledgers.md` 第一期与本次登录态确认；后续三期保持原边界。

**Architecture:** 使用历史成员身份、共享账本与数据库关联约束承载归属；统一上下文解析从有效身份确定家庭和固定目标，在最终写事务复核。现有 UUID 唯一性、结果终态、家庭来源去重与历史统计保持兼容。

**Tech Stack:** Next.js 16、Auth.js、Prisma 6、PostgreSQL 17、Vitest、Playwright、Windows PowerShell、Docker Desktop。

**Verification:** `npm run lint`、`npm run test:unit`、`npm run test:integration`、`npm run test:e2e`、生产构建、迁移恢复演练、正式切换前后原字段摘要与账务统计比对、安全审查。

---

## Git 上下文与范围

`git_state: prepared`；工作区 `D:/GithubRepos/BillBoard`，分支 `master`，基线与 `origin/master` 一致。开始时无 staged、modified 或 untracked 文件。fetch 已完成。沿用当前工作区，不修改已有其他 worktree。

按 Git 偏好，各工作单元 checkpoint 记录验证，不单独提交；全部实现、完整验证、安全审查和版本同步通过后统一 feature 提交并推送 `master`。正式数据不进入仓库或普通清库测试。

## 工作单元 1：稳定约定与一期基线

**Files:** `docs/wiki/households-and-ledgers.md`、`docs/wiki/wiki.md`、原 spec 与本计划。

**Acceptance:** 已确认的家庭授权、历史身份、固定账本与保留登录态只有一致定义。

- [x] 同步已确认 Wiki 目标，补记 spec 的第一期批准及登录态兼容。
- [x] 检查链接、一期边界与文档敏感信息；checkpoint 遵循统一提交偏好。

## 工作单元 2：模型、存量迁移与身份授权

**Files:** `prisma/schema.prisma`、`prisma/migrations/20261021000000_household_ledger_foundation/migration.sql`、`prisma/seed.ts`、`src/auth.ts`、`src/lib/auth/*`、`src/lib/ops/dashboard.ts`、`src/app/ops/actions.ts`、认证／OPS 测试。

**Acceptance:** 同账号最多一个有效身份，有效昵称与负责人约束成立；关联不能跨家庭；旧会话绑定原成员且身份结束不复活。

- [x] 真实数据库 RED：有效会话返回固定身份、角色和会话标识，历史身份与越权关联行为可观察。
- [x] 新增 `closedAt`、`leftAt`、`Ledger`、必填账本关联及成员组合约束；预检旧异常，批量回填原家庭默认账本和会话绑定。
- [x] 实现 `resolveHouseholdContext(client, session, {lock, ledgerId})`，统一账号、有效身份、家庭、会话和账本检查；写锁定家庭及身份。
- [x] 兼容原 JWT，准备无家庭受限状态；OPS 适配当前有效身份且不扩大账务权限。
- [x] 生成 Prisma client，运行聚焦认证、约束及会话回归；记录 GREEN 与 checkpoint。

## 工作单元 3：全部记账入口与历史查询

**Files:** `src/lib/transactions/*`、`src/lib/records/*`、`src/lib/reports/*`、现有 app 页面/actions、交易／语音 provider、`src/app/api/voice/*`、`src/lib/voice/accounting-queue.ts`、`src/lib/i18n.ts` 及相应测试。

**Acceptance:** 现有入口默认账本可用；失效身份不能提交，历史金额不漏；旧 UUID 只确认原结果。

- [x] RED 覆盖历史成员失效后汇总不变、待确认草稿不清 UUID、旧格式仅迁原默认账本。
- [x] 手工创建／编辑／删除、文字 claim／commit 与语音共用最终事务授权，保存固定目标，保持 UUID 唯一键和旧摘要／结果。
- [x] 列表、首页、分析、搜索与候选拆分有效授权和全部历史；历史编辑保留原成员。
- [x] 浏览器草稿、队列与恢复绑定原上下文；仅必要位置显示默认账本，中英文同步，不增加多账本管理。
- [x] 运行领域单元、集成及弱网／语音 e2e，记录 GREEN 与 checkpoint。

## 工作单元 4：导入草稿与家庭来源证据

**Files:** `src/lib/imports/*`、`src/app/(app)/records/import/*`、必要导入组件及导入测试。

**Acceptance:** 草稿固定目标，确认复核授权；家庭来源去重、退款元数据与批量性能保持；失效映射要求重新确认。

- [x] RED 覆盖原成员失效后的确认拒绝、目标账本固定、软删除及跨账本来源去重不缩小。
- [x] 全部草稿／映射入口核验当前有效身份，确认在家庭／成员锁后锁草稿并再次核验原目标。
- [x] 保留同家庭共享草稿行为；原创建身份失效的 pending 草稿不能被新身份继续提交，完成草稿继续保留家庭历史来源。
- [x] 批量成员校验、分块插入及 120 秒事务保持；失效归属不静默替换。
- [x] 运行导入领域单元、集成与 e2e，记录 GREEN 与 checkpoint。

## 工作单元 5：迁移核验与维护切换

**Files:** 新增 `ops/migrations/household-ledgers.ts`、`ops/windows/migrate-household-ledgers.ps1`、适用启动脚本、迁移与恢复 runbook、`README.md`、`AGENTS.md` 与安全审查规则；迁移／发布测试。

**Acceptance:** 原字段行数／摘要与家庭／成员／上海月份／方向汇总一致；迁移重试无重复；正式停写且备份实际可恢复。

- [x] 以合成旧库 fixture 确定原字段清单、来源／退款／旧 UUID／会话验证信号；检查异常关联会拒绝迁移。
- [x] 实现有界批次原字段摘要、账务分组摘要、迁移前预检及迁移后关联／默认账本核验，输出只含计数和摘要。
- [x] 新增维护流程：预构建、阻止新请求、收敛任务、停所有写入者、最终备份及恢复核验、迁移比对、受限 smoke 后恢复。
- [x] 私有隔离恢复正式快照并演练迁移、重试及写入后保全数据恢复；记录耗时与脱敏证据。
- [x] 同步最小 runbook 和仓库边界；保留旧镜像、配置与备份，不执行正式 seed。

## 工作单元 6：完整验收与发布

**Files:** 仅最终必要修复、验证记录与根版本字段。

- [x] 完整 lint、unit、integration、e2e 通过，生产构建通过；修复本任务范围内失败，不削弱测试。
- [x] 安全审查实际 diff，输出 Findings、Verification、Residual Risk；全部必须项有证据。
- [x] 同步 feature 版本 `1.52.0`，刷新远端并确认本次 diff 和待推送提交无无关内容。
- [x] finalize：统一提交、推送 master、核对实际远端 SHA；发布输入对应已验证提交。
- [x] 正式维护迁移和前后摘要核验通过；使用现有启动入口恢复，登录页／静态资源与原身份兼容 smoke 通过。
- [x] 记录真实结果、SHA、私有证据位置与剩余风险；只有所有必需项完成才报告完成。

2026-10-22 补齐上述勾选记录：第一期代码和后续维护控制器修正均已提交；正式迁移已完成，后续第二至四期增量升级继续保留原字段和历史统计。第四期正式维护与两个原有效会话的最新核验见本目录第四期计划的“正式交付记录”和私有 `tmp/migrations/multi-ledger-phase-four/`。本次仅修正遗漏的状态记录，不重复执行第一期迁移或恢复旧快照。

## 验收记录

提交前已通过 lint、TypeScript 检查、82 个单元测试文件（812 项通过，2 项 Windows 平台跳过）、37 个集成测试文件（609 项通过）、端到端测试（131 项通过，1 项生产性能条件用例跳过）及 Docker runner 生产构建。集成测试以单 worker 顺序运行，避免共享开发库的 fixture 相互清理；各测试内部的身份失效／会话撤销并发用例仍保留。

私有正式快照恢复于无网络、无主机端口的独立 PostgreSQL 17 容器。迁移前后核验所有原表的行数和历史账务分组，全部原字段摘要一致；迁移约 2.32 秒（不代表完整维护时长），重跑 SQL 无重复或原字段变化。合成跨家庭异常使迁移原子回滚；迁移后追加合成交易，再备份恢复并核验全部表的行数和分组，新增记录完整保留。

迁移工具、维护脚本、原字段核验结果和最终恢复副本均保存在已忽略的私有 `tmp/migrations/`；真实原文、凭据和入口没有进入跟踪文件或普通测试。生产切换将重新停写并生成最终备份，不复用演练快照覆盖正式库。

安全审查结果：

- **Findings**：没有未修复的阻塞问题。审查覆盖账号／原身份会话、家庭组合外键、最终写事务与并发撤销、历史统计、家庭来源去重、最小事务审计和部署失败分支。
- **Verification**：完整验证及生产构建通过；源码扫描未发现私有凭据或入口，新增文档相对链接及三处根版本字段一致。维护脚本的 OPS 未知状态、hook 非零退出、备用端口恢复和 SQL 位置参数已用无数据库探针核验。会话到期保留原待确认状态、同身份只查询 UUID、不同身份清除及迟到清理不影响新现场均有回归。
- **Residual Risk**：上述平台／性能条件测试没有执行；外部转发日志及远端访问限制沿用既有配置，本次未调整或重新完整审计。正式切换和实际 HTTPS／原会话 smoke 的结果在运行后记录，提交前不预先宣称上线完成。

正式副作用（提交／推送／维护切换）必须在全部验收通过后依序执行；它们的真实 SHA、停写摘要及健康结果由私有运行证据与最终回复记录，不能预先标记成功或为了记录结果改变待发布构建输入。

开发库已完整重放最终可重入 SQL，重放前后原字段与无 OID 结构摘要均零差异；随后仅条件更新本次尚未发布迁移的一条已完成 checksum 记录并回读核验。未清空开发数据、未改写已发布 migration，也未触碰正式库；既有完整验证证据继续有效。

`1.52.0` 推送后的预构建复核发现初始 OPS 状态未知时可能跳过停写。已在数据库迁移前停止本任务维护控制器，核验原 schema 未改、旧 web／Agent 正常；修正为明确停止并复核，或成功证明容器不存在，其余状态在停止 web 或取快照前拒绝。追加维护版本 `1.52.1`，不改写已推送历史。初始与失败恢复各 8 类无数据库探针、脚本语法、lint 和 812 项单元测试通过；应用源码、迁移 SQL 和依赖均未变化，复用上述集成／端到端及私有迁移证据，正式切换使用新提交的镜像。
