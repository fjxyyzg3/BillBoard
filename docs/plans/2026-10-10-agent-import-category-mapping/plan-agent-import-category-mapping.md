# 导入分类 Agent Implementation Plan

> **For agentic workers:** REQUIRED SKILL: Use implement to execute this plan task-by-task. Respect the handed-off git_state: inherit prepared, otherwise prepare; use git-workflow for checkpoint/finalize. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 使用独立容器中的 Codex ACP Agent 为导入分组预填分类／忽略建议，保留人工保存。

**Scope Source:** `docs/scope/2026-10-10-agent-import-category-mapping.md`

**Architecture:** 应用服务端生成最小化、匿名编号的分类请求，经带 token 的内部 HTTP 接口交给 ACP 执行器。分类容器逐任务创建 Codex 会话并回收进程；应用校验结果后由表单预填，沿用原保存与入账流程。

**Tech Stack:** Next.js server actions、Prisma、Zod、Node HTTP、ACP TypeScript SDK、Codex ACP adapter、Docker Compose。

**Verification:** `npm run lint`、`npm run test:unit`、`npm run test:integration`、`npm run test:e2e`、构建、容器／真实 ACP smoke、安全审查。

---

### Task 1: 契约与依赖

**Files:** spec、上述 Wiki 页面、`package.json`、`package-lock.json`、`src/lib/imports/agent-protocol.ts`、`tests/unit/import-agent-protocol.test.ts`。

**Acceptance:** 三类结果不混淆，数量／长度／额外字段／重复 ID 均受约束；锁定适配器版本。

- [x] Git prepare：初始 master 干净，基线 v1.38.1，origin/master 已刷新且相同；创建 `codex/agent-import-category-mapping` 及独立 worktree。
- [x] 按对话批准落 spec、同步已授权 Wiki；自审范围一致。
- [x] 核对 npm 包与 SDK/适配器源码，确定 runtime 的真实接口。
- [x] 实现共享协议与输入输出校验，测试 map 缺 categoryId、ignore/uncertain 多余 categoryId、未知组／分类和超限等拒绝行为。
- [x] checkpoint：按 Git 偏好不单独提交文档／中间单元，全部纳入最终 feature 提交。

### Task 2: 推荐业务边界

**Files:** `src/lib/imports/agent-suggestions.ts`、`src/app/(app)/records/import/agent-actions.ts`、`tests/integration/import-agent-suggestions.test.ts`。

**Acceptance:** 仅授权家庭草稿可请求；无写入；只发送批准字段；返回时重新校验草稿与分类。

- [x] 读取真实导入与会话代码，在外部 HTTP 边界建立 fake server；数据库使用现有安全 dev/test 模式。
- [x] 覆盖匿名化、商品字段白名单、四来源 key、已有规则跳过、推荐过程中规则／分类／草稿状态变化，以及服务异常；证明数据库前后不变。
- [x] 实现分批输入与严格响应映射，action 调用 `requireAppSession`；执行 `npx vitest run tests/integration/import-agent-suggestions.test.ts`。
- [x] checkpoint：保持任务所有权，不作中间提交。

### Task 3: 页面交互

**Files:** `src/components/import-category-mapping-form.tsx`、`src/lib/imports/mapping-form.ts`、`src/lib/i18n.ts`、`tests/unit/import-mapping-form.test.ts`、`tests/e2e/import-agent-suggestions.spec.ts`。

**Acceptance:** 真实表单从智能推荐预填分类/忽略，无法判断空白；手动选择和迟到结果保护；保存前无规则写入。

- [x] 使用真实表单 SSR 验证旧实现缺少中英文推荐按钮，取得两个行为断言 RED；随后补齐真实浏览器场景。
- [x] 按共享 action 契约实现推荐、批次进度、简短数据说明与中英文失败提示；保留原保存行为。
- [x] 覆盖推荐期间手动修改、失败后重试、分批结果、保存／后续复用；执行对应单元与浏览器测试到 GREEN。
- [x] checkpoint：保持任务所有权，不作中间提交。

### Task 4: ACP 执行器与部署

**Files:** `agent/acp-classifier.ts`、`agent/server.ts`、`agent/main.ts`、`tests/unit/import-agent-runtime.test.ts`、Containerfile、Compose、`.env.example`、Windows 启动脚本、README/runbook/nginx/frp 示例说明。

**Acceptance:** 正确的 ACP 初始化/会话/prompt、最终结果校验、拒绝工具权限、超时/退出回收、内部 token、容量限制；无新增公网端口。

- [x] 以真实 ACP 协议的子进程 fixture 验证成功、非法结果、超时、提前退出、权限请求和消息长度上限；只替代模型边界。
- [x] 实现专用 HTTP 服务和 ACP 生命周期；服务端固定启动方式，不接收 shell 命令或任意 URL。
- [x] 增加独立容器、专用配置卷、非特权进程、有限资源；Windows 发布验证新增镜像 SHA 与健康。
- [x] 为专用容器完成 Codex 认证，使用合成分组执行真实 ACP smoke；需要用户登录时提供已准备的具体登录步骤，同时继续其余验证。
- [x] checkpoint：保持任务所有权，不作中间提交。

### Task 5: 验收与发布

**Files:** 本任务所有文件、计划验证记录与根版本字段。

- [x] 运行完整 lint/unit/integration/e2e、构建与配置检查；检查 npm audit。
- [x] 按 billboard-security-review 审查实际 diff，记录 Findings、Verification、Residual Risk，修复阻塞发现。
- [x] 同步 feature 版本 1.39.0，刷新 origin/master、核验最终 diff 和版本，提交范围仅本任务文件。
- [ ] Git finalize：rebase 最新 origin/master，干净 master fast-forward 合入，推送 master 并核对实际远端 SHA。
- [ ] 从已推送 master 发布；核对运行镜像、登录页/chunk 健康与 Agent 真实分类；清理干净的本任务 worktree 和分支。

## 验证记录

初始工作区无已有修改；开发 PostgreSQL 已运行且只绑定 loopback。执行结果在对应任务完成时补记，不以计划项代替验证证据。

- 协议测试：10/10；页面 SSR 与纯函数：13/13；业务真实数据库集成：39/39；新增浏览器场景：7/7。
- 完整集成：加载 `.env.example` 后 `npm run test:integration`，28 文件、423 测试通过。首次未加载开发环境的运行因缺少 DATABASE_URL 失败，修正环境后全套通过。
- 完整浏览器：`npm run test:e2e`，69 通过、1 个既有可选弱网性能测试跳过；只使用开发库，测试前后清理完成。
- 依赖审计：`npm audit --json` 报 28 项（2 low、5 moderate、18 high、3 critical）；其中生产依赖 16 项。本次新增 23 个锁文件节点均无受影响包，原有依赖版本没有变化。既有依赖风险不在本次功能中扩大升级范围。
- Compose 静态检查、PowerShell 解析与 Linux Agent 镜像构建通过。直接 `docker build` 使用 `desktop-linux` builder；Compose 发布沿用原有 `default` builder，命令仍显式指定 `desktop-linux` context。二者在本机使用同一个 Docker Desktop Linux 引擎。
- 完整单元：`npm run test:unit -- --maxWorkers=2`，54 文件、353 通过、1 个 Linux 专属测试在 Windows 跳过。首次与镜像构建并行时既有敏感夹具扫描超过默认 5 秒；结束构建并限制测试并发后通过，未修改断言或超时。
- Linux 运行器：隔离测试容器使用 `--init --network none` 执行同一 ACP 运行器用例，27/27 通过，覆盖进程组后代回收。
- 完整 `npm run lint` 与最终 `npm run build` 通过。构建早期发现的 NODE_ENV、Node/DOM stream 类型问题已修复；现有 middleware/Browserslist 弃用提示未扩大处理。
- 最终 Compose 检查确认 Agent 无主机端口、不加入数据库网络、不接收应用/数据库秘密、仅一个专用命名卷、只读根目录；web 仍仅绑定 loopback。根版本一致为 1.39.0。
- 专用卷经用户设备授权后，真实 Codex ACP 合成验证通过：4 组含支出分类、收入分类、明确忽略与诱导工具调用的未知文本，约 11.9 秒返回全部预期结果；25 组合成大批次约 15.3 秒全部正确。两次均无任务目录残留、无 Codex/适配器进程残留。未使用真实账单。
- 实际运行的验证容器为 node 用户、只读根目录、init 开启、无主机端口、仅 Agent 两个网络与专用认证卷；未注入 AUTH_SECRET、DATABASE_URL 或 PostgreSQL 环境。

本文状态截至最终提交前。后续 Git 合并／推送和正式服务发布的执行结果记录在 Git 历史、私有发布日志及本次最终交付回复中，避免为收尾记录再创建功能外提交。

### 发布恢复记录

`v1.39.0` 已提交并推送，但首次正式发布在 Compose 构建阶段停止，尚未替换运行服务。根因是将独立 Docker build 验证用的 `desktop-linux` builder 名称错误用于 Compose；设置 DOCKER_CONTEXT 也不能消除该版本 Compose 子进程的 context 冲突。恢复原有 `--builder default` 后，真实 Compose Agent 镜像构建成功，且已核对 default 与 desktop-linux 指向同一引擎。

修正作为 `v1.39.1` 维护提交，保留已发布历史。应用、ACP 运行器、依赖及业务测试代码无变化，复用仍有效的全量验证与真实分类证据；针对启动脚本追加 PowerShell 解析、现有 security-config 测试和实际 Compose 构建验证，并复核无凭据／入口变更。

## 安全审查

**Findings：**安全审查通过，未发现阻塞问题。已审查认证、家庭隔离、导入完整性、模型数据白名单、UI、容器/网络、凭据及新增依赖；运行器已修复 SDK 原始消息日志风险、消息顺序竞态及新增类型错误。可选模型/推理环境变量已透传到专用容器。

**Verification：**业务 39 项集成覆盖越权及返回时重校验、四来源与推荐前后数据不变；浏览器 7 场景覆盖预填、人工覆盖保护、失败重试与保存边界；Linux 27 项运行器测试覆盖权限拒绝、消息上限、异常内容不进日志及进程回收。全量验证和配置检查见上。实际私有 env 值对本任务全部变更文件的匹配扫描无命中。

**Residual Risk：**既有 28 项依赖告警保留待独立维护。真实合成 smoke 不能保证所有账单语义均判断正确；模型建议必须人工确认保存，含商户与商品语义的批准字段会发送到 Codex 模型服务。Codex 授权失效或外部服务故障时可继续手动映射。
