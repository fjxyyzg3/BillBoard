# 自然语言支出记账 Implementation Plan

> **For agentic workers:** REQUIRED SKILL: Use implement to execute this plan task-by-task. Respect the handed-off git_state: inherit prepared, otherwise prepare; use git-workflow for checkpoint/finalize. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在“记一笔”用一个文本框解析多笔支出并安全、原子入账。

**Scope Source:** `docs/scope/2026-10-13-natural-language-accounting.md`，已批准。

**Architecture:** 独立自然语言协议扩展受限 ACP Agent，服务端按家庭／提交者／请求 UUID 管理处理资格及终态。页面调用受保护 Action，只持久化待确认 UUID；交易与结果在短事务中批量写入。查无记录原子关闭与首次受理竞争，失败定位只保存代码和偏移。

**Tech Stack:** Next.js 16、React 19、TypeScript、Zod、Prisma 6、PostgreSQL 17、Codex ACP、Vitest、Playwright。

**Verification:** lint、unit、integration、e2e、构建／迁移检查、合成真实 ACP smoke、安全审查、Git／镜像 SHA 和发布健康检查。

---

## Task 1：设计记录与共享接口

- [x] 继承 `codex/natural-language-accounting` worktree，排除原任务外修改；Spec 记录用户批准。
- [x] 使用 wiki 同步 `docs/wiki/natural-language-accounting.md` 和 `docs/wiki/wiki.md`，只写批准的稳定规则。
- [x] 定义 `src/lib/transactions/natural-language-types.ts` 页面结果：`processing`、`success`（笔数／整数分合计）、`error`（固定码／问题偏移）、`unknown`，均关联请求 UUID。
- [x] checkpoint：遵循 Git 偏好，文档与实现合入同一 feature，不单独提交。

## Task 2：Agent 协议与受限运行器

**Files:** `src/lib/transactions/natural-language-protocol.ts`、`agent/acp-classifier.ts`、`agent/server.ts`、`agent/main.ts`；unit 协议／运行器测试及 ACP fixture。

- [x] 在现有 HTTP Agent 上测试 `/parse-expenses`，确认缺失端点返回 404 的有效 RED；新模块导入错误不记作 RED。
- [x] 严格协议定义文本、参考时间、匿名分类／成员与当前成员；响应为 `success` 支出数组或 `needs_correction` 问题数组，金额整数分、日期可空、原文偏移有界，候选 ID 与引用重新验证。
- [x] 复用 ACP 隔离／认证／清理，按两类任务使用各自固定指令和协议，与分类端点共享单任务互斥，保持既有分类行为。
- [x] GREEN：针对性 unit 证明未知 ID、越界依据、非整数金额、无效日期、权限请求、异常输出及忙碌均被拒绝；记录真实命令。

## Task 3：请求状态、授权与原子入账

**Files:** `prisma/schema.prisma`、新增 migration、`src/lib/transactions/natural-language-agent.ts`、`natural-language-entry.ts`、`src/app/(app)/add/natural-language-actions.ts`；`tests/integration/natural-language-entry.test.ts`。

- [x] 新增最小请求模型：身份键唯一、可空摘要／时间参照、处理资格及期限、成功 JSON 或固定失败码／偏移；关闭标记不伪造输入摘要。生成客户端并仅迁移开发库。
- [x] HTTP 客户端沿用私有 `IMPORT_AGENT_URL/TOKEN`，使用独立端点、55 秒超时及有界响应；真实 HTTP fixture 隔离模型，不 mock 业务写入。
- [x] 按身份键使用数据库事务级 advisory lock，覆盖无记录竞争；受理、恢复、查询关闭、写入和失败终态共用该互斥。终态不可重开，不按文本永久去重。
- [x] Action 从有效 session 派生身份，调用后再校验，批量重验成员与启用支出分类；全批创建和成功结果一起提交，更新缓存／活动失败不改写成功。
- [x] 集成测试验证两笔金额／日期／归属、原子回滚、匿名出站隐私、会话撤销及候选变化、并发重放、摘要冲突、关闭／首次创建竞争、过期抢占／迟到尝试、错误位置重放及软删除后不再创建。
- [x] GREEN：开发数据库针对性集成测试通过；迁移可正常 deploy，无历史交易回填。

## Task 4：页面状态与浏览器验收

**Files:** `src/components/accounting-input.tsx`、`natural-language-form.tsx`、`src/app/(app)/add/page.tsx`、`src/lib/i18n.ts`；组件 unit、`tests/e2e/natural-language-accounting.spec.ts`、Agent fixture 和数据库清理。

- [x] 先针对现有 `/add` 验证缺少自然语言切换的有效 RED，再实现默认手工、两模式保留内存草稿和提交中冻结。
- [x] 表单只包含文本框和导入按钮；规范化文本统一，未知结果保留 UUID 并查询，刷新不保存／恢复原文，收到终态才能解冻。匹配快照才按问题偏移定位。
- [x] 中英文显示输入／处理／错误／成功；提交在 React transition 内，软键盘避让复用现有模式，成功不导航或整页刷新。
- [x] 测试专用 HTTP fixture 支持新协议，e2e 清理新增请求模型；成功显示笔数／合计且记录页可见，错误整批不写、原文保留，断网刷新可关闭未受理 UUID，响应丢失仍可重放定位。
- [x] GREEN：组件与 10 项针对性 e2e 通过；现有手工填写／文件导入另由完整回归验证。

## Task 5：整合、安全与发布

- [x] README 同步 `/add` 行为及 AI 数据范围；补充确认目标内的实际 Wiki 知识。
- [x] 运行 `npm run lint`、`npm run test:unit`、`npm run test:integration`、`npm run test:e2e` 和 `npm run build`，不降低验收。
- [x] 真实 ACP 用合成多笔、成员／日期及缺失信息样例验证解析；既有分类合成 smoke 继续可用，不发送真实账本。
- [x] 使用 `skills/billboard-security-review/SKILL.md` 检查身份作用域、原子性、终态、输出数据与容器边界，记录 Findings／Verification／Residual Risk。
- [x] 刷新 master 基线，`1.41.2` 的 feature 版本递增为 `1.42.0`，package 与 lock 根字段一致；确认本任务独立提交输入和完整验证证据。

## Git 与发布收尾

以下动作交由 `git-workflow finalize` 接管；提交前的实现计划记录验证结果，实际提交／远端 SHA、镜像和健康结果记录在最终交付报告，避免把尚未执行的发布声明为完成。

1. 只 stage 本任务文件并提交，rebase 到最新 `origin/master` 后安全 fast-forward 合回 master，推送并核对实际远端 SHA；不创建 PR。
2. 从已验证已推送的 master 执行现有 Windows 发布脚本，已有生产库不 seed；核对三类镜像提交、健康、登录页与静态资源，使用合成请求检查已发布的 Agent 内部 HTTP 端点。
3. 发布验证成功后清理干净任务 worktree／本地分支，不删除 master。

## 执行证据

文档-only 前期检查和 Review Spec 的 F1/F2 限定复核已有有效证据；无单独文档 checkpoint 提交。

- Agent RED：新 HTTP 端点初始返回 404；GREEN：两类协议／运行器 4 文件共 113 项通过，1 项既有 Windows 不适用的 Unix 进程组测试跳过。
- 页面 RED：现有 `/add` 缺少自然语言模式；GREEN：组件 2 文件、3 项通过，浏览器 10 项通过，包含手机操作栏、双草稿、英语、原子失败、仅 UUID 存储、未送达关闭、成功／纠错响应丢失重放。
- 开发迁移与客户端生成通过；新增真实数据库／HTTP 集成测试 22 项通过，包括撤销会话、跨家庭、候选变化、真正的批量插入失败回滚和并发请求。
- 完整单元测试：63 文件、460 项通过，1 项既有 Windows skip。高并发同时构建时敏感样例扫描触发 5 秒时限；单独复核及 `npm run test:unit -- --maxWorkers=2` 均在原有时限内通过，未调整测试验收。
- 完整集成测试：显式加载跟踪的 `.env.example` 到命令进程后，`npm run test:integration -- --maxWorkers=2` 30 文件、468 项通过。初始失败仅缺少 `DATABASE_URL`，未接触生产库。
- 完整浏览器回归：`npm run test:e2e` 93 项通过，1 项既有 `WEAK_NETWORK_PRODUCTION_PERF` 专用性能基准按默认配置跳过。新增自然语言表单使旧“支出”子串标签定位歧义，旧手工收支用例改为精确单选框定位后完整通过，断言和验收未减少。
- `npm run build` 通过。隔离 Agent 测试镜像构建通过，包含新协议和上海日期模块；受限容器使用专用认证卷、默认外连网络，无数据库网络或公开端口。
- `1.42.0` 最终构建／TypeScript 与 lint 再核验通过；已完成的临时合成 smoke 脚本从 TypeScript 扫描范围清理，没有修改 tsconfig 或验收条件。Prisma validate 通过；数据库／schema 对比未发现新增请求表、索引或外键差异。开发库原有 DeviceAccessGrant／DeviceAccessStatus 及 AppEventType 设备事件残留与 master 基线相同，本次保留，不扩大迁移。
- 真实 ACP（`gpt-6-luna/high`）合成验收通过：单笔且受益人不当付款人，2 笔 5,700 分及默认成员／时间，明确付款成员及固定上海相对日期，缺失金额整段纠错，混入收入整段拒绝，以及原分类建议。首轮成员日期样例曾返回不合规响应并被拒绝；仅捕获合成输出诊断的复核四类样例均通过，追加单笔／受益人和收入边界通过，不放宽校验。

### Findings

安全审查未发现阻塞问题。新 Action 调用有效 session 并在 AI 后重验；请求查询、互斥和交易创建均使用 session 派生的家庭／提交者。唯一键和事务级锁覆盖未受理关闭竞争，整批交易及结果一次提交，终态与旧尝试均不可重开或迟到写账。

### Verification

上述 lint、unit、integration、e2e、构建、开发迁移、HTTP／ACP fixture 和六类真实合成 smoke 通过。34 个本任务变更文件完成文本检查；与本机私有配置中的 10 个敏感值做无输出匹配检查，均未进入变更文件，新增 URL 仅内部／本机测试地址。Agent 无数据库／应用密钥、shell／文件／网络工具和公开端口；`.dockerignore` 排除私有 env、临时工作、备份和 worktree。输入及生成原文不进入持久状态、URL、诊断或活动日志，浏览器只存成员作用域 UUID，错误位置以代码和偏移重放。

### Residual Risk

模型仍可能误判含义或返回不合规输出；本次合成验收不能穷尽自然语言表达。结构不合规、未知候选、越界引用或模糊信息按协议拒绝整段入账。Unix 进程组测试与专用生产性能基准保留既有平台／配置限制。此记录形成时 Git 推送与正式发布尚待收尾，需以最终远端 SHA、镜像及健康证据完成。
