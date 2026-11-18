# AI 对账独立页面与人工核对 Implementation Plan

> **For agentic workers:** REQUIRED SKILL: Use implement to execute this plan task-by-task. Respect the handed-off git_state: inherit prepared, otherwise prepare; use git-workflow for checkpoint/finalize. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把对账移到记录页下的独立页面，让关联提示支持受控人工去重和混合选集原子应用。

**Scope Source:** [已批准规格](../../scope/2026-11-05-ai-reconciliation-workspace.md)，用户明确回复“批准spec”。

**Architecture:** 复用全局后台控制器和现有报告正文，人工选择作为 v2 应用意图单独校验。原 v1 摘要／终态保持；新受保护回执记录真实交易映射并投影局部处理状态。页面在明文与加密视图共用，原生成额度和字节边界不变。

**Tech Stack:** Next.js 16、React 19、Prisma 6、PostgreSQL 17、Zod、Vitest、Playwright。

**Verification:** 聚焦 RED/GREEN、真实开发数据库应用与恢复、390px 中英文交互，最终 lint／全量单元／集成／端到端、构建、安全审查和适用发布。

---

## 工作区、所有权与接口

- 继承 `git_state: prepared`；branch `feature/ai-reconciliation-workspace`，worktree `.worktrees/feature-ai-reconciliation-workspace`，base `v1.64.0`。原目录 `.agents/`、`.claude/` 未跟踪项及 `tmp/` 运行检出不归本任务，不移动或删除。
- 本 spec 和本计划不单独提交，按偏好随功能形成一个版本提交。当前阶段为实施；后续验证、提交、master 推送及正式发布按实际结果收尾。
- 协议／纯函数工作单元拥有 `bill-reconciliation-types.ts`、`bill-reconciliation-application-protocol.ts`、新 `bill-reconciliation-selection.ts` 及对应单元测试；不改原 AI 识别门槛。
- 服务端工作单元拥有应用、报告 store、HTTP、加密恢复和其集成测试；不改 UI、共享协议文件或源导入解析。
- 页面工作单元拥有路由／loader／view、组件／客户端控制器／i18n、加密视图分流及 UI／浏览器测试；不改应用事务或共享协议文件。
- 主 agent 拥有 spec／plan／wiki／版本、环境准备、整体验证、安全复核、Git 和发布。仅主线程安排数据库与浏览器运行，禁止并行清库；各工作单元可并行跑聚焦纯函数测试。

公共契约由协议工作单元先确定并通知其他工作单元：

- `ReconciliationManualGroup = { noticeId: string; refs: string[]; keepRef: string }`。
- `ReconciliationApplyInput` 保留无 `version` 的原 v1 分支，增加显式 `version: 2`、`suggestionIds` 与 `manualGroups` 分支；仅人工组允许 AI 列表为空。
- `ReconciliationApplyOutcome` 保留旧字段，可添加受控 v2 标记及任务内人工组结果；受保护定义另保存组内 ref→transactionId、保留 ID 和删除 IDs，公共响应不返回这些真实映射。
- 报告 DTO 增加可选 `manualReview: { processing: boolean; records: Array<{ref: string; status: "available" | "handled" | "archived"}> }`；仅元数据能力／状态，不承诺记录在提交前未变化。新服务端对当前对账报告返回该投影。
- 新纯函数 `deriveManualReconciliationActions(records, suggestions, groups)` 校验公共结构并保留明确 keepRef；服务端另按断言核对真实账本／成员／交易 IDs。
- `previewReconciliationSelection(records, suggestions, { suggestionIds, manualGroups })` 统一预览并拒绝包括保留项在内的重叠；保留原 `previewReconciliation` 兼容接口。
- `normalizeReconciliationManualGroups` 和 `reconciliationManualGroupKey` 为组排序／稳定内存标识提供一致规则；v1 原摘要路径不经过这些默认值。

## Task 1：版本化协议与人工动作

**Files:** `src/lib/reports/bill-reconciliation-{types,application-protocol}.ts`、新 `bill-reconciliation-selection.ts`、`tests/unit/bill-reconciliation-manual.test.ts` 及必要原协议回归。

**Acceptance:** v2 仅人工／混合可解析；缺 keeper、越界引用、异向异额及重叠拒绝；明确保留项不受自动排序影响；原 v1 输入与终态形状保持。

- [x] 先用现有 `parseReconciliationApplyInput` 验证合法 v2 不抛错，旧 strict schema 拒绝 v2，得到 1 failed／1 passed；v1 原形回归通过。
- [x] 增加行为断言：两笔等额选较少信息记录为 keeper，动作仍是该 ref 的 keep＋其他 ref 的 delete；多金额 notice 只取指定子集。
- [x] 实现严格 v1／v2 输入及回执解析、稳定组规范化、公共人工动作和混合预览；断言人工去重结余按删除额变化而非抵扣不变。
- [x] 覆盖同 notice 分组、保留项不在组内、重复 refs、不同真实引用别名的服务端协作约束、200 项／1000 记录边界和旧回执兼容。
- [x] 跑聚焦单元回归，记录 GREEN；checkpoint 继承偏好，不单独提交。

## Task 2：原子应用、局部状态、预算与恢复

**Files:** `src/lib/reports/bill-reconciliation-application.ts`、`bill-analysis-store.ts`、`bill-report-http.ts`、必要新 `bill-reconciliation-receipts.ts`、`src/lib/encryption/recovery.ts`；`tests/integration/bill-reconciliation-manual.test.ts`、既有应用／恢复测试。

**Acceptance:** 人工＋AI 一次原子提交；同 UUID 改 keeper／分组冲突且不覆盖；局部处理只禁用实际参与记录；v3 历史恢复不按后来修改的账目重算原结果。

- [x] 真实开发库先验证 v2 notice 人工去重应 success；原服务返回 unknown／INVALID，预期 success 的断言失败，得到真实功能 RED。
- [x] 服务端从同 notice 断言解析实际记录，验证同家庭／账本／actor／方向／整数分金额，检查原记录、来源依赖、报告代次、可写账本及参与记录不复用。
- [x] 保留 v1 摘要分支；v2 摘要包含完整人工组。合并 AI 动作与人工动作，双重检查 ref／真实 ID 重叠，在原家庭优先短事务中分块写入、最小审计和稳定回执。
- [x] 写入前预检成功回执 200 笔／解密后 1 MiB 预算；读取用路由元数据有界分页并预检封装推导的物理载荷。合法 64 KiB 生成报告连续处理全部不重叠组后仍可读，不用非法大报告证明规模。
- [x] 将已处理真实 IDs 投影回当前代次 refs；人工父 notice 不写入自动 `suggestionIds`，未参与记录保留入口；新 v2 `consumedIncomeIds` 只含真实抵扣收入。
- [x] 覆盖混合批次冲突、事务回执故障、并发、身份／归档／模式失效、稳定拒绝、查询先关闭及实际导入→人工删除→重导不复活。
- [x] 覆盖加密转换／换钥及 v3 隔离恢复：保留项后来已编辑／移动／归档、报告换代，原成功／拒绝 UUID 仍返回原结果，且不恢复会话／租约。
- [x] 聚焦集成验证 GREEN；checkpoint 继承偏好，不单独提交。

## Task 3：独立页面、人工核对和草稿

**Files:** 新 `src/app/(app)/records/reconcile/page.tsx`、`loader.ts`、`view.tsx`，记录页／首页 view，`bill-analysis-panel.tsx`、`bill-analysis-provider.tsx`、`bill-reconciliation-panel.tsx`、必要人工编辑组件、客户端控制器、`i18n.ts`；加密 gate／view-data／household view route；对应单元和 `tests/e2e/bill-reconciliation-manual.spec.ts`。

**Acceptance:** 记录页可达、首页无完整模块、导航仍三项；notice 有明确人工入口；组和 keeper 绑定原身份／报告／代次；换代失效而原已提交 UUID 保留；中英文手机可用。

- [x] 现有 `billAnalysisScopeHref` 实际返回 `/home`、notice SSR 没有人工核对按钮，两项真实 RED 均已取得。
- [x] 新增专用页面最小 loader／view，带入允许范围并限制月／年，不调用首页统计／趋势／分类查询；所有后台／历史查看链接迁入新路径。
- [x] 同步加密页面枚举、路由和渲染分流；移除首页完整面板，记录页提供清楚入口和原路返回行为。
- [x] 人工选择至少两笔、明确 keeper、确认加入选集；混合预览可编辑／移除，提交锁定。仅 UI 内存保存人工选择，不写普通持久存储或 URL。
- [x] 客户端草稿按身份、reportId、generation 隔离；页面／范围切换不重解释旧 refs，换代失效，刷新提示限浏览器支持场景；已提交 UUID 只核验。
- [x] 更新原浏览器用例到独立页并新增合成多金额 notice、明确 keeper、未选记录不变、相同 notice 两组后续核对、混合冲突、未知响应／整 context 关闭、加密与中英文 390px／短屏操作；两组先后应用另由真实数据库回归覆盖。
- [x] 只在主线程安排下运行浏览器／数据库测试；实际查看截图和键盘／焦点／底栏遮挡，聚焦回归 GREEN。
- [x] checkpoint 继承偏好，不单独提交。

## Task 4：整体验证、文档与发布

**Files:** 本计划及已批准 spec、`docs/wiki/ai-bill-analysis.md`、README 和实际受影响说明；根 `package.json`／`package-lock.json` 版本。

- [x] 按实际实现更新 wiki／说明，独立文档复核，不把容量计划或合成 Agent 当真实模型能力。
- [x] `npm run lint`、`npm run test:unit -- --maxWorkers=2`、显式加载 `.env.example` 的 `npm run test:integration`、`npm run test:e2e`、`npm run build` 完成验证；最终端到端的原定位修正后复跑所属文件，复用其余用例仍有效的通过证据。数据库与 e2e 不并行运行。
- [x] `skills/billboard-security-review/SKILL.md` 审查实际 diff，修复发现并记录 Findings／Verification／Residual Risk；复用仍有效的验证证据。
- [x] 同步 feature 版本至 1.65.0，刷新 origin/master，核对仅本任务文件与提交，准备单个版本提交。

提交后的收尾按 Git／运行回执记录：安全 rebase 和 fast-forward master，推送并核验实际远端 SHA；按既有 Windows 入口构建、migrate deploy（不 seed）及重启，检查本机和实际 HTTPS 根入口／短接口响应头。需要干净发布检出时保留原未跟踪目录和实际运行挂载。成功后只清理本任务干净 worktree／branch，保留生产挂载依赖。

## 执行记录

- 已独立核对 spec 原文和 review-spec 所审 SHA256 `01280f7c122ba5f02bbf68ca58177eb21935910c9eeed0b980cf0fbd9c0feacf`，用户明确批准；现回写批准状态。
- Git prepare 已继承，实际分支／worktree 与原上下文一致，原目录无关未跟踪项保留。spec／plan checkpoint 按偏好不单独提交。
- 已完成任务 worktree 独立 `npm ci`；已读取安装版本的 Next.js Route Handlers／导航／after 指南，以及 testing-anti-patterns。
- 独立 Prisma 客户端生成通过；guard 确认 loopback `billboard_dev`，回执表存在、18 个启用分类。服务端工作单元获准独占聚焦数据库验证，其他工作单元仅运行纯单元检查。
- 三个工作单元分别取得协议、真实应用和界面入口的功能 RED；不是语法、fixture 或环境错误。
- Task 1 已冻结：人工选择与原 preview／prepare／protocol 共 4 个测试文件，100／100 通过；所属四个文件 ESLint 和 `git diff --check` 通过，原 AI 证据门槛文件未改。
- Task 2 已冻结：相关 5 个集成文件 71／71 通过，含 18 项人工应用及 v3 原／人工独立恢复。首次旧 v1 恢复用例触发检查点时间边界，调查发现数据库与 Node 短时钟差；原检查未改，独立及整套重跑均通过。随后补充真实 actor／方向与公共别名不一致的攻击回归，由主线程统一运行。
- 独立审查已修复陈旧人工草稿的反馈缺口：其他成员已处理或账本归档后，旧组明确失效并禁用提交，仍可移除／重新核对；加入选集前展示逐笔保留／删除预览。
- Task 3 实现已冻结：37 项聚焦单元通过，原入口及草稿失效均有真实 RED／GREEN；编辑分组进入表单首个可用输入，保存／取消回焦，浏览器断言已准备。
- 全量 lint、148 个单元文件（1,364 通过、1 项既有跳过）和生产构建通过，包含独立路由 `/records/reconcile`。全量集成与浏览器验证继续执行。
- 独立安全审查及 README／wiki／spec／plan 文档复核无未解决发现。最终验收仍以完整测试、实际截图和发布回执为准。
- 首轮全量集成为 79／81 文件、1,145／1,147 项通过。邮件租约测试混用了主机造数时间与数据库有效期时钟；实测数据库比主机慢约 1,050 ms，改为同一数据库时钟造数，原 60 秒／过期 1 秒断言保留。含人工 20 项的 4 文件聚焦回归 35／35 通过。另一个十万笔加密导出首次超时，保持原 60 秒生成期限及数据量独立复测通过（生成 54,238 ms），没有修改导出实现或放宽验收；将重新执行全量集成。
- 新增 6 个浏览器场景均已通过：加密家庭真实开启／解锁／人工应用、混合冲突整批拒绝并重扫、选集编辑移除、原 UUID 恢复及范围往返。首次有两项测试定位与既有状态／重扫控件重名，已收敛到对应工作区与报告，无产品规则修改。
- 实际短屏截图发现成功提示覆盖应用按钮，新增中心命中测试取得真实 RED；改用页面普通布局插槽呈现，保持原控制器与 observer。6 项浏览器复跑、中心命中和试点击均 GREEN；已查看中英文 390px 全页及 390×568 操作视口，按钮完整可见，焦点和底部三项导航检查通过。
- 跨报告关闭提醒补充 2 项真实 RED／GREEN：B 已提交时只排除其本代草稿；A 报告尚未提交的人工选择仍触发提醒，不改变原 UUID。最终全量单元为 148 文件、1,366 通过及 1 项既有跳过，lint 和构建通过。
- 最终全量集成为 81／81 文件、1,147／1,147 项通过；十万笔加密导出在本轮生成 54,516 ms，原生成期限保持 60 秒。
- 全量端到端共 231 项，首轮 229 通过、1 项既有独立生产性能用例按配置跳过，1 项旧测试仍在原面板寻找标题。仅将定位改为独立页主标题后，所属 `bill-analysis.spec.ts` 的 6 项全部通过；应用代码未改，其余 229 项通过证据仍有效。新增 6 项人工对账场景在全量中通过。

## 最终安全复核

- **Findings：** 无未解决的 P0／P1／P2。已修复失效选集无反馈、加入前缺逐笔预览、编辑焦点、短屏反馈遮挡和跨报告草稿提醒。
- **Verification：** 独立只读审查覆盖授权锁序、真实归属与整数分校验、原子修改、v1／v2 回执、预解密容量、历史恢复、内存草稿、加密分流及文案；最终代码完成上述测试。暂存文本检查覆盖 42 个文件、26 个 Markdown 相对链接及根版本一致性，无新增绝对 URL 或敏感入口发现。
- **Residual Risk：** 受控 Agent 与 Chromium 模拟视口不证明真实模型识别效果或所有实体设备差异；人工决定仍由用户明确确认，原模型证据门槛与预算保持。提交、推送和正式服务检查另以运行回执确认，计划记录不作为发布证明。
