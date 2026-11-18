# AI 对账 Implementation Plan

> **For agentic workers:** REQUIRED SKILL: Use implement to execute this plan task-by-task. Respect the handed-off git_state: inherit prepared, otherwise prepare; use git-workflow for checkpoint/finalize. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用可核验的重复／退款／报销建议替换 AI 消费分析，并安全原子应用选集。

**Scope Source:** [已批准 spec](../../scope/2026-11-05-ai-bill-reconciliation.md)，用户于 2026-11-05 明确批准。

**Architecture:** 复用原报告表、短提交与后台运行器，通过用途和内容版本分开旧分析和新对账。纯函数生成受限批次与建议，服务端保存快照断言，独立短事务执行 UUID 幂等应用。建议、来源证据及回执进入家庭加密和 v3 恢复集合。

**Tech Stack:** Next.js 16、React 19、Prisma 6、PostgreSQL 17、Zod、现有 Astra Agent、Vitest、Playwright。

**Verification:** 聚焦单元／真实开发数据库集成测试先行，最终 `npm run lint`、`npm run test:unit`、`npm run test:integration`、`npm run test:e2e`，安全审查、构建与隔离运行验收。

---

## 工作区与接口

- 继承 `git_state: prepared`：`feature/ai-bill-reconciliation`，worktree `.worktrees/feature-ai-bill-reconciliation`，基线 `v1.63.0`；主目录已有 `.agents/`、`.claude/` 未跟踪项不归本任务。
- spec 和 plan 不单独提交；全部功能完成、完整验证和版本同步后以一个 feature 提交收尾。
- 公共类型统一在 `src/lib/reports/bill-reconciliation-types.ts`。`ReconciliationSourceRow` 为服务端完整断言，`ReconciliationRecord` 为公开展示，`ReconciliationSuggestion.actions` 为服务端计算的动作。
- 纯函数协议导出 `prepareBillReconciliation(snapshot)`、`buildBillReconciliationContent(prepared, results)`、`previewReconciliation(records, suggestions, selectedIds)`；Agent 请求函数为 `requestBillReconciliationAgent(request, signal, remainingMs)`。
- 主协调模块 `bill-reconciliation-snapshot.ts` 导出 `queryBillReconciliationSnapshot(session, scope, locale, now?, signal?)` 与短事务复用的 `loadReconciliationRows(tx, householdId, ids)`。
- 应用模块 `bill-reconciliation-application.ts` 导出 `applyBillReconciliation(session, input)`、`queryBillReconciliationApplication(session, requestId)`，返回 `ReconciliationApplyOutcome`；只接收建议 ID，不接收交易补丁。
- 新正文接口 `/api/reports/reconcile` 使用原生成／读取操作名，并新增 `apply`、`query-application`；旧 `/analyze` 新生成拒绝、历史读取保留。

## Task 1：协议、候选、确定性建议与 Agent

**Files:** 新建 `bill-reconciliation-protocol.ts`、`bill-reconciliation-prepare.ts`、`bill-reconciliation-preview.ts`、`bill-reconciliation-agent.ts`；修改 `agent/` 内部路由与提示；新增 `tests/unit/bill-reconciliation-*.test.ts`。

**Acceptance:** 同方向同金额去重，部分／全额抵扣，组合建议及互斥；精度未知／补零／聚合不得经时间路径预选；跨范围和证据不足仅提示；跨批候选完整，超限无截断；分日分月预览与原日期回写一致。

- [x] 验证跨 500 行共同候选、10000 行完整计划、密集候选 `TOO_LARGE` 和批次／字节边界。
- [x] 验证 `10000 - 3000 = 7000`、全额软删除、超额只读、组合仅抵扣一次及跨月 `+3000`／`-3000`。
- [x] 实现结构化协议、证据校验及受限分批；模型无数据库 ID、指纹、银行余额或密钥，不接受任意金额／工具指令。
- [x] 接入内部 `/reconcile-bill` 和原 Astra 预算，禁止重试／回退；保持旧端点已有任务的兼容能力。
- [x] 聚焦单元测试及原 Agent 回归通过；独立标识、时间精度和不支持事项的反例已验证。
- [x] checkpoint：按 Git 偏好不单独提交，已交主 agent 整合。

## Task 2：回执模型、原子应用、加密与恢复

**Files:** `prisma/schema.prisma`、增量迁移、`src/lib/encryption/`；新建 `bill-reconciliation-application.ts`；新增 `tests/integration/bill-reconciliation-application.test.ts`、加密／恢复测试；必要适配现有测试清理。

**Acceptance:** 任一记录／依赖冲突整批零改账；同 UUID 回执稳定；明确拒绝先持久化；查询关闭阻止迟到；原归属和来源／UUID 不变；新 v3 恢复含回执、旧 v1/v2 固定集合可验证。

- [x] 真实数据库覆盖整批冲突、其他家庭、归档、失效身份和加密应用；无部分写账／审计。
- [x] 覆盖稳定拒绝、同 UUID 摘要冲突、并发至多一次及查询关闭；真实 PostgreSQL 回执故障注入证明全部回滚且只返回未知。
- [x] 添加受保护应用回执实体，生成客户端并仅在开发库迁移；复用家庭优先锁序与批量审计，所有写入／成功回执同事务。
- [x] 接入 v3 快照／删除检查点、旧固定集合 proof 验证、转换／换钥和恢复，拒绝缺实体新版包及恢复可执行能力。
- [x] 应用、加密、旧来源回归和成功回执隔离恢复验证通过；实际导入→对账去重→重新导入预检确认软删除不复活，净额写入保持来源字段的既有规则不变。
- [x] checkpoint：按 Git 偏好不单独提交，已交主 agent 整合。

## Task 3：报告、快照、后台生命周期与 HTTP 整合

**Files:** `bill-analysis-store.ts`、`bill-analysis-service.ts`、`bill-analysis-runtime.ts`、`bill-analysis-types.ts`；新建 `bill-reconciliation-snapshot.ts`、`src/app/api/reports/reconcile/route.ts`；修改旧分析 route；新增／调整集成及后台测试。

**Acceptance:** 不同用途报告槽隔离；旧报告只读、新生成不再产出消费分析；新后台仍在全部客户端离开后完成；来源精度／抵扣依赖可用于应用前重查；权限、同意、预算和加密释放不放宽。

- [x] 验证用途槽隔离、公共 DTO、日级／未知精度、来源证明不足及旧协议生成拒绝。
- [x] 复用查询、身份锁、独占 key ring、owner 清理，定义 `purpose` 分流与严格内容解析；保留旧 UUID 和回执。
- [x] 通过同一授权取数辅助加载最新记录及来源依赖，比较稳定断言；加密扫描使用原容量限制，不补读期外配对记录。
- [x] 接入全部 HTTP 操作，受保护同源正文、短回执、`after`、`no-store`／`no-referrer`；处理提交未知，不自动重发。
- [x] 原后台／资源／owner 回归和真实 Next.js 自托管进程端到端通过，覆盖全部客户端离开后完成与显式取消。
- [x] checkpoint：按 Git 偏好不单独提交，已完成工作单元整合。

## Task 4：移动界面、选集与未知应用恢复

**Files:** `src/components/bill-analysis-provider.tsx`、`bill-analysis-panel.tsx`、新增对账面板及客户端应用控制器、现有扫描控制器、`src/app/(app)/home/view.tsx`、`src/lib/i18n.ts`；组件／控制器测试与 `tests/e2e/bill-reconciliation.spec.ts`。

**Acceptance:** 高可信预选、待确认不选、只读不可选、互斥选择；整体及日／月预览；一次点击仅提交所选；未知核验原 UUID、重开不重放；旧报告可读、成功刷新账目；中文英文和键盘／移动可用。

- [x] 组件／控制器验证默认选集、互斥、空选集、重开仅查询及请求级访问失败；多标签页按身份／UUID 独立恢复。
- [x] 复用现有外壳、弹层和状态发现，不新建无关页面；所有提示写入中英文 messages。
- [x] 使用共享确定性 preview，展示每条动作和分期变化；提交中冻结选集并处理成功／明确拒绝／未知／身份失效。
- [x] 开发库合成账目端到端覆盖取消预选后应用、统计／明细、跨月、冲突、重复点击、关闭整个 context、成员共享和旧报告只读。
- [x] 组件、控制器和移动端到端通过；实际查看中英文 390px 截图，焦点／标签／纯文本输出检查通过。
- [x] checkpoint：按 Git 偏好不单独提交，已交主 agent 整合。

## Task 5：文档、完整验收与发布

**Files:** 已批准 spec、本计划、`docs/wiki/ai-bill-analysis.md`、`docs/wiki/wiki.md`、`docs/wiki/household-encryption.md`、相关 AI／导入说明及 runbook、`README.md`、根版本字段。

- [x] 按实际实现更新 wiki 和维护说明，记录来源证明差异、计划／HTTP 夹具容量和旧报告边界；独立文档审阅通过。
- [x] 完成 lint、全量单元／集成／端到端、构建及 spec 的隔离运行／恢复验收；失败经调查修复后重验，未削弱验收。
- [x] 使用 `skills/billboard-security-review/SKILL.md` 审查实际 diff；发现均修复并复核，结果见下文。
- [x] 刷新 `origin/master`，基线无远端新增提交；确认任务变更及 `1.64.0` 根版本一致，满足一个 feature 提交的验收前提。

提交后的收尾顺序如下，实际结果由最终 Git／运行回执和交付回复记录，不在提交前预写发布成功：

1. 创建单个版本提交，rebase 后安全 fast-forward `master`，从 `master` 推送并核对实际远端 SHA；推送失败不发布。
2. 按 Windows 生产脚本构建／迁移／重启（不 seed），健康检查并验证受保护短请求边界；失败诊断恢复，不宣称上线。
3. 完成适用清理并报告实际验证、提交、推送、发布结果；有外部阻塞保留所有工作和证据。

## 执行记录

- 2026-11-05：用户明确批准 spec；已核对修订版与工作区，批准状态已回写，Git prepare 上下文继承成功。
- 已读取当前安装 Next.js 的 Route Handlers／`after` 指南；任务分支基线与原目录无关未跟踪内容均保持。
- 初始公共类型已定义；仅类型契约，不包含可执行行为。后续每个行为单元按以上测试先行验证。
- 专项验证已覆盖协议、应用、加密、后台与客户端；HTTP 端到端发现严格应用输入误含 `operation`，已保留原 `400`→`200` 回归证据并修复适配。
- 真实 PostgreSQL 注入回执写失败，确认金额、软删除、审计全部回滚且返回未知；故障触发器和函数均已清理。
- 随机隔离源／空目标数据库完成成功应用 v3 恢复：`10000 - 3000 = 7000`、收入软删除、成功加密回执保持；新会话查询／重试原 UUID 不新增改账和审计，新 UUID 拒绝，原会话／在途执行／租约不恢复。两个临时库均已清理。
- 安全审查修复了不支持的借还款／否定抵扣语义、去重后保留记录的时序判断、多标签页恢复指针及加密导入证据预解密预算；增量复核已关闭这些发现，新增纯测试夹具复核无新增发现。
- 最终单元测试：`npm run test:unit -- --maxWorkers=2 --reporter=dot`，145 文件通过，1311 项通过、1 项跳过。首次高并发造成既有测试超时，限制 worker 后通过，未削弱断言。
- 最终端到端：`npm run test:e2e -- --reporter=line`，224 项通过、1 项跳过，用时 14.2 分钟；中英文移动截图已实际查看。
- `npm run lint` 与 `npm run build` 通过。最终 `npm run test:integration -- --reporter=dot` 显式加载 `.env.example` 开发环境，80 文件／1126 项全部通过，用时 718.49 秒；此前的开发 URL 缺失及 SMTP 窗口瞬态已在正确隔离环境下复验通过。
- 文档针对性检查通过：9 份文档的 45 个相对链接均存在；`package.json`、`package-lock.json` 及锁文件根包版本均为 `1.64.0`。新增文档、命令和夹具已核验不含真实入口或凭据。
- HTTP 容量验收通过：真实开发数据库 10,000 笔合成记录，20 个上下文批次、4 个各 500 笔跨批补扫批次，共 24 次环回 HTTP 调用；累计输入 4,218,730 字节，含原调用窗口等待共 122,803ms，完整完成且扫描不改账。夹具返回空建议，该测试不代表真实 Astra 的同规模语义识别或耗时。
- 实际随手记与微信各导入一笔同笔支付记录，先由夹具明确模拟用户补充支付标识，再经报告生成和应用软删除一笔；原 ID、UUID、来源、指纹、时间及归属保持，两份原文件重新导入均为 `SOURCE_DUPLICATE`、新增零笔。没有为测试修改抵扣证明或业务规则。

## 安全验收

- **Findings：** 无未修复发现；前述语义、时序、恢复和加密预算问题均已修复并增量复核。
- **Verification：** lint、全量单元／集成／端到端、生产构建、真实数据库故障注入、成功回执 v3 隔离恢复、HTTP 容量及原文件重导入检查通过。文档、根版本和 diff 检查通过。
- **Residual Risk：** 合成 Agent 夹具证明协议、预算与流程，不证明真实 Astra 对万笔账目的同等识别结果或耗时。正式入口健康及响应头随提交后的发布核验。
