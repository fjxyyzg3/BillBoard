# 第三期完整多账本实施计划

> **For agentic workers:** REQUIRED SKILL: Use implement to execute this plan task-by-task. Respect the handed-off git_state: inherit prepared, otherwise prepare; use git-workflow for checkpoint/finalize. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有家庭与默认账本基础上交付可选择的多账本，贯通读取、记账、移动和异步恢复。

**Scope Source:** `docs/scope/2026-10-21-multi-household-ledgers.md` 第三期及 2026-10-21 用户确认的两项设备偏好。

**Architecture:** 查看范围与写入目标独立表达，统一解析授权后的家庭或单账本范围。客户端偏好按成员身份隔离，身份级任务容器保存每个账本的草稿及固定目标；变更与最终写入复用家庭优先事务锁。既有来源、成员历史和 UUID 不因切换或移动改变。

**Tech Stack:** Next.js 16、React 19、Prisma 6、PostgreSQL 17、Vitest、Playwright。

**Verification:** lint、全部单元／集成／e2e、生产构建；双家庭与归档／移动／切换并发；手机／平板／桌面 UI；实际变更面安全审查；从已推送 master 发布与健康检查。

---

## Git 与职责

基线 `v1.53.0`，原 master 工作树干净，已刷新远端且一致。任务分支 `codex/multi-ledger-workflows`，工作区 `.worktrees/multi-ledger-workflows`。根代理维护 spec、计划、Wiki、查询范围、页面整合、最终验证及 Git／发布；独立模块划分文件所有权后并行，数据库测试统一排队，禁止并发清理共享开发库。checkpoint 继承 prepare；仓库规定全测前不提交，故计划与模块 checkpoint 仅核对所有权和证据，最终合为同目标 feature 提交。

## 1. 范围、账本解析与管理

**Files:** spec、当前计划、`docs/wiki/households-and-ledgers.md`、`docs/wiki/wiki.md`；新建 `src/lib/ledgers/selection.ts`、`src/lib/ledgers/server.ts`、`src/lib/ledgers/service.ts`；`tests/unit/ledger-selection.test.ts`、`tests/integration/ledgers.test.ts`。

**Contract:** `LedgerSummary` 提供 ID、名称、默认及归档状态；`LedgerScope` 区分家庭总览与单账本；偏好只保存当前家庭／成员和范围、写入目标 ID。URL 参数 `ledger=all|ID` 与 `entryLedger=ID` 明确意图，成员范围 cookie 提供无参数首次恢复；非法明确目标拒绝，不用默认掩盖越权。服务端目录与范围解析包含归档可读，写入仍要求有效账本。

- [x] 恢复批准与 Git prepare；补充第三期 spec，先同步已确认的长期 Wiki 约定。
- [x] 先写首次／恢复／跨身份偏好、明确非法目标和归档可读的 RED，运行并记录。
- [x] 实现最小共享解析、共同维护新建／重命名和负责人默认／归档／恢复；家庭锁内保持至少一个有效默认账本及最小审计。
- [x] 真实双家庭、角色、默认／归档竞态 GREEN；checkpoint 核对文档与模块，不提前提交。

## 2. 统一读取范围与记录移动

**Files:** `src/lib/records/list-records.ts`、`src/lib/records/search-token.ts`、`src/lib/reports/query-home-report.ts`、`src/lib/reports/query-report-analytics.ts`、`src/lib/transactions/query-category-preferences.ts`、`src/lib/app-navigation.ts`、首页／记录／搜索页面与 actions；`src/lib/transactions/update-transaction.ts`、编辑 schema、编辑抽屉；对应 unit/integration。

**Acceptance:** 同一范围下列表、搜索、金额筛选、全部 SQL 汇总和钻取一致；家庭总额包含归档，历史成员不漏算。列表携带记录原账本与只读状态；编辑和软删除按原账本授权；单条移动保持 ID、成员、来源、金额和时间。

- [x] 用两个家庭、多个账本、历史成员、软删除和归档数据写读取与移动 RED；断言家庭总额等于各账本之和，跨家庭请求不泄露记录。
- [x] 接入统一范围，搜索令牌绑定读取范围而不绑定新记账目标；所有趋势、分布、比较、分类及成员查询使用同一过滤。
- [x] 接通记录原目标编辑和同家庭有效账本移动；失败不部分改写，不改长期来源或原请求终态。
- [x] 聚焦读取／移动／搜索／报表 GREEN，checkpoint 核对实际文件及证据。

## 3. 明确写入目标与导入兼容

**Files:** `src/lib/transactions/create-transaction.ts`、`schema.ts`、`natural-language-entry.ts`、自然语言 actions、`src/lib/imports/drafts.ts`、导入 actions／页面、语音 routes；对应 integration。

**Acceptance:** 上传即固定目标；确认重新检查原目标，失效保持可解释草稿；家庭去重、退款与映射不分裂。无上下文的新写入拒绝并要求刷新，已提交旧 UUID 只确认原终态，归档／移动／默认改变不产生第二次写入。

- [x] 写显式非默认目标、缺参新请求拒绝、旧 UUID 查询、归档并发、移动后去重及退款的 RED。
- [x] 接通所有写入边界，保持现有唯一键和原始幂等语义；有必要的增量字段或审计迁移时仅新增 migration，不能改已发布迁移。
- [x] 重跑四来源导入、自然语言、语音与手工相关 GREEN；checkpoint 记录证据，未执行生产写入或 seed。

## 4. 设备选择与身份级任务容器

**Files:** 新建账本 provider／选择器与账本管理组件；`src/components/app-shell.tsx`、导航、`transaction-form.tsx`、`natural-language-provider.tsx`、`voice-accounting-provider.tsx`、文字／语音 controller、`entry-context.ts`、草稿；账本管理 page/actions；`src/lib/i18n.ts`；相关 unit/e2e。

**Acceptance:** 首次家庭总览，再次恢复当前身份上次范围；单账本预选该本，家庭总览恢复上次有效写入目标。每个任务显示原账本，切换保留草稿及待确认 UUID，真正身份结束清除访问。390／768／1440 像素可读，无新增装饰或无关导航。

- [x] 用存储、controller 及实际页面行为验证切换保留、身份失效、旧格式仅原默认迁移等 RED。
- [x] 将身份生命周期与每任务目标分开；有界共用队列不按账本增加并发额度，原请求未确认不自动重发原文。
- [x] 接入账本选择、管理、写入目标和记录移动 UI，补全中英文及不可写／错误状态。
- [x] 跑聚焦 e2e：建本→记账→切换→移动→家庭汇总→归档／恢复；在途文字／语音和弱网 UUID 恢复。按 app-screen 规则检查三个宽度截图，修复实际问题。

## 5. 最终验收与发布

**Files:** 适用 README、安全规则、根版本字段；私有 `tmp` 验证与发布证据，不将真实配置、入口或财务数据写入跟踪文件。

- [x] 自审 spec 覆盖和完整差异，删除本次未用代码；升级 feature 版本至 `1.54.0` 并同步根 lock 字段。
- [x] 全量 `npm run lint`、`npm run test:unit`、`npm run test:integration`、`npm run test:e2e` 与生产构建通过，保存实际计数和日志；不放宽限流或超时消除失败。
- [x] 使用 `skills/billboard-security-review/SKILL.md` 对实际变更输出 Findings、Verification、Residual Risk；扫描真实私有值和入口，无命中。

发布收尾按以下门禁顺序执行。实际提交 SHA、正式迁移与健康结果写入未跟踪的私有运维记录，不在实现提交中预写尚未发生的结果：

1. 刷新远端、核对所有权与版本，只提交本任务；合回并推送 master，核对实际远端 SHA。
2. 从已验证提交构建、按现有脚本发布；迁移前停写并取得新备份，恢复到空 PostgreSQL 17 后比较全部 25 表原字段及账本统计摘要，核验兼容标记仅为原默认账本，重试迁移无变化；通过后才迁移正式库，不执行生产 seed。
3. 从 master 恢复正式服务，验证本机及实际 HTTPS、OPS 隔离、存量会话及历史读取；私有保存真实结果、保留备份，清理干净任务 worktree 和本地分支，finalize 后报告。

## 验证记录

- 账本选择单元 7 项与账本管理集成 10 项已通过；记录读取四项从全家庭误计／无目标校验 RED 到 GREEN，连同账本管理串行 14/14。家庭总额等于各账本之和，归档可读、软删除排除、非法家庭目标拒绝。
- 搜索范围单元从家庭范围不能签发 RED 到 GREEN，7/7；导航范围保持 RED 到 GREEN，7/7；编辑目标选择 RED 到 GREEN，1/1。页面／搜索路由聚焦 32 项通过，包含重复与不可用范围拒绝。
- 写入缺参、明确非默认导入、旧 UUID 原目标归档／移动确认六项真实数据库 RED 到 GREEN；五文件完整回归 227 项通过。删除缺参／畸形上下文两项从错误删除 RED 到拒绝且原记录及审计不变 GREEN。
- 增量迁移新增账本管理审计枚举及原默认账本兼容标记；开发库迁移和 client 生成通过。新迁移字节用 `.gitattributes` 固定，已发布迁移不改。
- 首轮完整集成用于整合发现旧 fixture 仍省略上下文、页面目录 mock 不全及一个测试文件未预载开发 env；当前按新显式契约更新真实 fixture 和完整 mock，最终会在统一开发 env 下重跑，不降低断言。
- 聚焦浏览器 8 项通过：包括录音及 ASR 在途切换、未知文字 UUID、手工晚成功／错误响应、存储写满时原草稿保留。文字草稿仅在身份级内存中按账本保存，不新增原文持久化。
- 管理页、记账页在 390／768／1440 三宽度 inspect 均为 0 FAIL／0 WARN；保持原品牌色板及既有分类控件，允许项和截图保存在私有 `tmp/ledger-design`。归档只读抽屉三宽度人工检查通过。
- 最终全量单元 93 文件通过，898 项通过、2 项既有跳过；旧页面 fixture 已补齐，敏感样例扫描改为串行执行后通过，未放宽超时或断言。集成 45 文件、723 项全部通过，包含四来源导入和真实双家庭权限。
- 全量 lint 已通过，补齐的单测 fixture 另经 ESLint。第二期真实邮件收发已由用户于 2026-10-21 确认验收通过，原收件未确认保留项已关闭；第三期仍按已批准范围交付。
- 首轮完整 e2e 为 138 通过、6 失败、1 项既有性能条件跳过。其中五项仍断言旧的无账本 URL 或 v2 令牌，已按明确目标和 v3 读取范围更新精确断言。320px 滚动诊断确认目标行中心被固定底栏遮住，点击时浏览器先滚动 62px，而抽屉准确恢复了该位置；测试先将目标行中心滚入可点击区域，再记录起点，原小于 3px 精度断言保留，未修改抽屉恢复逻辑。
- 三文件移动聚焦 9/9 通过；短屏脚注等待实际 resize／动画完成，仍要求完整操作按钮位于 360px 视口内。最终完整 e2e 为 144 通过、1 项既有性能条件跳过（7.2 分钟），生产构建及 TypeScript 检查通过，最终 lint 通过。应用源码未在浏览器重跑期间修改。
- 私有扫描覆盖 594 个源文件、16 项私有值的 22 种实际／编码表示，无真实凭据或入口命中；版本三个根字段统一为 `1.54.0`。最终远端刷新仍与原基线一致，原 master 工作树干净。

### Findings

最终安全审查未发现剩余阻塞问题。所有入口从有效 session 派生家庭和成员，归档与默认操作及最终写事务复核角色、原身份和账本。手工晚响应、存储写满迁移、录音在途切换已修复并有真实浏览器回归；文字草稿不新增原文持久化，查询 UUID 不重新发送原文。

### Verification

完整 lint、898 项单元、723 项集成、144 项 e2e 及生产构建通过；保留 2 项单元平台条件跳过与 1 项既有 e2e 性能条件跳过。单元／集成采用 `--maxWorkers=1 --fileParallelism=false`，浏览器保持现有单 worker；未放宽限流、超时或安全断言。跨家庭、撤销会话、归档只读、原账本移动、原 UUID、去重与退款证据均通过。手机／平板／桌面视图与最终私有值扫描通过，日志和截图仅留在私有 `tmp`。

### Residual Risk

第二期真实邮件收发已由用户确认验收通过，凭据消费及重放拒绝沿用既有自动化验证记录。第三期正式备份恢复、迁移、实际 HTTPS、运行镜像和存量会话已完成核验，证据保存在私有运维记录；生产未执行 seed。第四期边界保持不变。
