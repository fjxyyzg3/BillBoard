# AI 对账分组与多选保留实施计划

> **For agentic workers:** REQUIRED SKILL: Use implement to execute this plan task-by-task. Respect the handed-off git_state: inherit prepared, otherwise prepare; use git-workflow for checkpoint/finalize. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按已确认预览将人工去重改为时间升序分组、默认首笔、多选保留和统一应用。

**Scope Source:** [已批准 spec](../../scope/2026-11-05-reconciliation-grouped-retention.md)，用户于 2026-11-06 明确要求进入实现。

**Architecture:** 报告正文与扫描机制保持，客户端根据提示和记录生成稳定分组，内存草稿保存保留集合。新增应用协议 v3，经共用确定性动作与服务端原子事务执行多保留项；旧 v1／v2 摘要、回执及恢复规则保留。

**Tech Stack:** Next.js 16、React 19、TypeScript、Zod、Prisma、PostgreSQL 17、Vitest、Playwright；不新增依赖或数据库实体。

**Verification:** 聚焦协议／分组／草稿／数据库／隔离恢复测试，真实浏览器移动端与英文短屏截图；最终 `npm run lint`、`npm run test:unit`、`npm run test:integration`、`npm run test:e2e`、生产构建及安全审查。

---

## Git 上下文与协作

- 沿用 `codex/reconciliation-grouped-retention` 与 `.worktrees/reconciliation-grouped-retention`，prepare 基线 `v1.65.2`；2026-11-06 刷新后 `master` 与 `origin/master` 仍相同。
- 主工作区原有未跟踪 `.agents/`、`.claude/` 保留，不加入提交。当前任务继承 spec 与独立 HTML 预览。
- 服务端 agent 负责类型、选集、协议、应用、回执及相应单元／事务测试；UI agent 负责分组、控制器、组件、中英文及相应单元测试；恢复 agent 负责加密恢复和隔离恢复测试。主 agent 负责端到端、环境、整合、安全、文档及 Git／发布。
- 各工作单元通过后记录 checkpoint；按仓库偏好不单独提交 spec／plan，不在全量验收前提交局部实现。最终同步 `1.66.0` 并形成一个 feature 提交。

## Task 1：协议、确定性动作与原子事务

**Files:** `src/lib/reports/bill-reconciliation-types.ts`、`bill-reconciliation-selection.ts`、`bill-reconciliation-application-protocol.ts`、`bill-reconciliation-application.ts`、`bill-reconciliation-receipts.ts`；`tests/unit/bill-reconciliation-manual.test.ts`、`tests/integration/bill-reconciliation-manual.test.ts` 及必要的同目录多保留项测试。

**Acceptance:** 三笔等额记录保留两笔只删除一笔；零保留、全保留输入、重复保留、越界、相交选集均拒绝。v3 摘要稳定且保留集合变化产生冲突；所有保留项参与失效检查和处理投影；人工删除收入不形成抵扣消费。v1／v2 原测试保持。

- [x] 新增 v3 协议与金额预览测试并确认 RED（3 项缺失行为失败）；事务验证随新协议继续执行。
- [x] 新增 `ReconciliationRetentionGroup`、受保护应用映射及严格 v3 解析，保留旧类型／解析／摘要路径；共用预览派生明确的 keep／delete。
- [x] 扩展应用服务、幂等、整批容量检查和已处理投影，事务前后按原锁序复核。
- [x] 运行 `npx vitest run tests/unit/bill-reconciliation-manual.test.ts` 和相关新增单元测试，再运行 `npx vitest run --no-file-parallelism tests/integration/bill-reconciliation-manual.test.ts` 及新增事务测试；期望完整 GREEN。
- [x] checkpoint：记录结果，暂不单独提交。

## Task 2：分组界面与稳定内存草稿

**Files:** `src/components/bill-reconciliation-manual-review.tsx`、`bill-reconciliation-panel.tsx`、`bill-analysis-provider.tsx`、必要局部 CSS module、`src/lib/i18n.ts`、`src/lib/reports/bill-reconciliation-controller.ts`、新增分组纯函数；`tests/unit/bill-reconciliation-{workspace,drafts,controller,lifecycle,panel}.test.*` 及分组测试。

**Acceptance:** 每提示内按四个条件分组，时间及数字 ref 稳定升序，默认首笔，可多选、全选跳过、零保留阻止应用；默认组一次预览并应用。轮询与切页不覆盖草稿，换代清理，已知不可用与后来失效区分，冲突可通过整组跳过解除。中英文和既有 AI 建议保留。

- [x] 以真实组件测试确认新默认分组输出缺失的 RED，分组／草稿覆盖随实现补齐。
- [x] 按已确认 HTML 预览建立分组和复选保留组件，移除该路径旧 editor／单选／逐组确认交互；保留证据、明确禁用原因和统一预览。
- [x] 控制器保存新分组草稿并生成 v3 请求；旧调用兼容 v2，未知回执只查询原 UUID，普通持久化不保存财务选集。
- [x] 最终边界复核：以真实请求包装计算包含加密材料的完整正文字节，在保存指针／发请求前拒绝超限；恢复子集回执时精确匹配实际 refs／keepRefs，不把同桶其余记录误标完成。两项 RED 均已复现并 GREEN，另覆盖旧已处理证据不被误标为本次删除。
- [x] 运行 UI 与控制器聚焦测试，核验保留组键不随选择或排序位置变化；通过后 checkpoint 暂不单独提交。

## Task 3：加密载荷、换钥与隔离恢复

**Files:** `src/lib/encryption/recovery.ts`、`tests/integration/encryption-recovery.test.ts`、`bill-reconciliation-recovery-worker.ts`、`bill-reconciliation-encryption.test.ts`。

**Acceptance:** 实际 v3 应用多保留项后可保护、换钥和隔离恢复；保留项后来编辑、移账、归档及报告换代不会重算历史决定；成功／拒绝／关闭 UUID 终态不变。原包版本、实体集合和 owned database 护栏保持。

- [x] 增加实际 v3 多保留项恢复场景并运行 RED；沿用现有隔离库 fixture，不注入超预算或不合法报告。
- [x] 扩展恢复对 v3 映射、保留／软删除事实与同家庭引用的校验；不以当前金额或账本重算原动作。
- [x] 运行 `npx vitest run --no-file-parallelism tests/integration/encryption-recovery.test.ts tests/integration/bill-reconciliation-encryption.test.ts`，确认旧版本与新场景 GREEN；checkpoint 暂不单独提交。

## Task 4：真实端到端与视觉验证

**Files:** `tests/e2e/bill-reconciliation-manual.spec.ts`；复用 `tests/e2e/agent-fixture.ts` 的真实受控供应商边界，不添加生产测试 API。

**Acceptance:** 真实登录→扫描→默认分组→多选→混合应用→再次查看；同一提示跳过组后续可处理。验证零保留、全部保留、来源精度、冲突零改账、切页草稿、换代默认、关闭客户端只核验 UUID，加密 SSR／本机存储无明文旁路。390px 短屏应用入口可见且不被导航遮挡。

- [x] 更新旧 editor 操作测试为新用户流程，保留导航、冲突、UUID、加密等既有验收；新增三笔保留两笔的真实数据库断言与跳过组后续处理。
- [x] 核验开发／测试数据库连接护栏后运行 `npx playwright test tests/e2e/bill-reconciliation-manual.spec.ts`，修复真实失败，不削弱断言。
- [x] 实际查看中文手机、英文短屏与桌面截图，核验点击命中、焦点、滚动与表格不横向溢出；图片只存忽略的 `tmp/verification/`。
- [x] checkpoint：记录浏览器和数据库证据，暂不单独提交。

## Task 5：完整验收、知识同步与发布

**Files:** `docs/wiki/ai-bill-analysis.md`、本 plan、spec 批准状态、已确认 HTML 预览、`package.json`、`package-lock.json`。

**Acceptance:** 最终功能满足 spec 所有验收，四项全量检查和构建通过，安全审查提供 Findings／Verification／Residual Risk。单个 `v1.66.0` feature 提交合回并推送 master，远端 SHA 相同，正式服务健康，任务分支／worktree 安全清理。

- [x] 运行完整 `npm run lint`、`npm run test:unit`、`npm run test:integration`、`npm run test:e2e`；集成与 e2e 串行使用开发库。
- [x] 根据实际实现更新 wiki，核对 spec／计划／源码和中英文一致；同步根版本 `1.66.0`。
- [x] 使用 `skills/billboard-security-review/SKILL.md` 审查最终实际 diff，完成必要构建与文档检查，复用仍有效的验证证据。
- [ ] 刷新远端，检查任务 diff、版本、无无关提交，按偏好提交、rebase、fast-forward 合回 master、push 并核对远端 SHA。
- [ ] 从已验证、已推送的 master 执行 `ops/windows/start-production.ps1`，不执行生产 seed；验证本机健康／登录页及既有适用入口，不暴露真实入口或凭据。
- [ ] Git finalize：只清理干净且已合入的任务工作树／分支，报告提交、推送、发布与残余风险。

## 执行证据

初始环境：Docker Desktop `desktop-linux` 的开发数据库与现有正式服务均健康。实现与测试过程在对应步骤通过时更新本节，不把计划中的验收视为已完成证据。

2026-11-06 首轮证据：开发库本地 `_dev` 护栏与 `SELECT 1` 通过。服务端 v3 协议／动作测试先 3 项 RED，随后原人工选集及预览共 66 项 GREEN；UI 默认分组真实组件测试已确认 RED。交叉检查发现同源 HTTP 转交原本只承载 v2，已纳入 Task 1 并要求 v3 请求回归覆盖。

服务端 checkpoint：人工选集／预览单元 66 项、人工／应用事务集成 43 项通过；v3 真实 POST 转交先 RED 后 GREEN，并发 UUID、跨范围／归档／撤销／加密护栏覆盖旧新协议。所属 ESLint 与 diff 检查通过，按偏好待整体 feature 验收后提交。恢复 checkpoint：真实 owned 隔离库已证实旧恢复遗漏 v3 删除状态护栏的 RED；最小扩展后两文件 41 项 GREEN，覆盖三笔保留两笔、后改／移账／归档、报告换代、换钥及三类 UUID 稳定终态。独立只读服务端安全审查和 plan 文档复核未发现阻塞问题。

UI checkpoint：最终分组／草稿／控制器／组件 6 文件 41 项单元通过，ESLint 与 TypeScript 通过。真实浏览器聚焦 8 项全部通过（1.3 分钟），覆盖多保留、跳过组后续处理、无操作／零保留、切页／换代、未知 UUID、实时冲突及加密 SSR／正文传输；已实际查看中文短屏应用入口、英文键盘焦点与桌面截图。全量 lint 通过；默认大并行同时跑浏览器时三个既有导入／扫描测试只报 5 秒超时，未改断言／超时，浏览器结束后 `npm run test:unit -- --maxWorkers=2` 全套 149 文件、1395 通过／1 原有跳过。

环境处理：任务 worktree 原只有测试缓存，Next 启动器要求本地依赖且既有 Turbopack 根边界不允许外部依赖链接；已执行本地 `npm ci` 和 `prisma generate`。临时链接按用户要求使用不含 `-Force` 的命令移除，共享主仓库依赖完整；未修改项目解析配置。

最终验收：全量 integration 81 文件、1159 项通过（635.73 秒）；源码冻结后完整 e2e 232 项通过、1 项既有生产弱网性能模式跳过（13.9 分钟）。上一轮加密换钥用例受 `i18n.ts` 修改触发的整页 Fast Refresh 影响，确认状态按设计清空；日志、页面状态及独立复核闭合，冻结源码后原用例通过，未修改加密逻辑、超时或点击条件。

最后两项局部修补：组间同最早时间时先比较数字 ref，新增回归先复现 `r10` 误排在 `r2` 前的 RED，复用现有比较函数后 10 项 GREEN；窄侧栏的总额与分期预览按可用宽度换列，金额不拆行，未改变手机固定操作栏的包含块。修补后全量 lint 通过，全量 unit 149 文件、1403 通过／1 既有跳过（45.27 秒），对账两文件 12 项真实 e2e 全部通过（1.4 分钟）。最终英文桌面与手机短屏截图已实际查看。未触及服务端逻辑，复用仍有效的全量集成证据。

安全审查：**Findings** 无阻塞问题。**Verification** 核验会话／家庭／成员／账本锁内授权、整批快照复核、原子软删除／审计／回执、v1／v2 摘要兼容、v3 恢复引用与删除事实、完整加密正文字节预算、未知结果只查询原 UUID；最终任务文本与私有凭据／入口比对、相对链接、根版本和依赖未变检查通过。**Residual Risk** 手机验收使用 Chromium 模拟视口，未代替真实设备；既有生产弱网性能专项未启用。部署网络配置未变，不将本次审查表述为重新核验外部转发服务全部配置。

本计划保留提交时快照；提交后的远端 SHA、发布健康检查及工作树清理结果记录在最终交付说明，不提前勾选尚未执行的动作。

生产构建：`npm run build` 通过，包含 Next.js 16.4.2 的优化编译、TypeScript 和静态页面生成。`next-env.d.ts` 已由生产构建恢复为原跟踪内容；只移除本任务生成的未跟踪类型缓存，不提交开发／构建产物。发布镜像将从已推送提交的干净归档构建，避免主工作区原有未跟踪目录进入构建输入。
