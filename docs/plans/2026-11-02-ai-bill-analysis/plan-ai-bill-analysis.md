# 月度与年度 AI 账单分析 Implementation Plan

> **For agentic workers:** REQUIRED SKILL: Use implement to execute this plan task-by-task. Respect the handed-off git_state: inherit prepared, otherwise prepare; use git-workflow for checkpoint/finalize. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按月或年将完整站内账目交给 Astra 分批分析，安全保存并共享该范围最新报告。

**Scope Source:** `docs/scope/2026-11-02-ai-bill-analysis.md`，用户于 2026-11-02 批准。

**Architecture:** 应用级控制器消费同源 POST 进度流；web 在同一快照取数、持有共享 AI 租约并顺序调用内部 Agent。报告和原 UUID 回执通过家庭锁及代次原子保存，进入现有加密和版本化恢复边界。

**Tech Stack:** Next.js 16、React 19、TypeScript、Prisma 6/PostgreSQL 17、Zod、Vitest、Playwright、WheelMaker Responses。

**Verification:** 每个行为先写聚焦失败测试再实现；最终执行 lint、unit、integration、e2e、构建/镜像检查、安全审查、合成 Astra 与实际链路验证。

---

## Git 与文件所有权

- 沿用 `feature/ai-bill-analysis` 与 `.worktrees/feature-ai-bill-analysis`，基线 `v1.61.3`，原先无用户修改，唯一已有任务文件为待批准 spec。
- spec 已记录批准；checkpoint 按仓库偏好不单独提交文档或局部代码。全部要求及完整验证通过后，一个 feature 提交同步根版本，合回并推送 master，再发布。
- 主 agent 负责公共类型、资源、快照/业务编排、API、整合、端到端、知识和 Git/发布。独立任务文件分别由协议/Agent、数据/加密、UI 执行者拥有，禁止交叉修改或自行提交。

## 公共接口

- `bill-analysis-types.ts` 定义 `BillAnalysisScope`、`BillAnalysisBody`、指标/证据、报告 DTO、进度事件、UUID 终态。
- `POST /api/reports/analyze` 接受 `operation: generate/query/cancel/report/list`。生成输入为 `requestId/scope/locale`；查询/取消只需 UUID，report 使用 `reportId` 或 `scope`，list 使用不含财务值的游标。加密输入统一置于正文 `encryption`。
- 生成返回 NDJSON `BillAnalysisEvent`（progress/heartbeat/result）；其他操作返回 `{ result }`、`{ report }` 或 `{ reports, cursor }`，失败返回受控错误。所有响应 no-store；不在 URL 放财务值。
- 报告槽以解密后的规范化 scope 在家庭锁内识别；UUID 在家庭/原成员内唯一并绑定原 AppSession；任务状态包含 PREPARING、RUNNING、STOPPING 和不可重跑终态。

### Task 1: 公共协议、分批与 Astra 运行器

**Files:** `src/lib/reports/bill-analysis-types.ts`、`bill-analysis-protocol.ts`、`bill-analysis-prepare.ts`；`agent/runtime.ts`、`provider.ts`、`wheelmaker.ts`、`prompts.ts`、`server.ts`、`main.ts`；`.env.example`、`compose.yml`、`Containerfile`；`tests/unit/bill-analysis-protocol.test.ts`、`bill-analysis-prepare.test.ts`、`bill-analysis-agent.test.ts`。

**Acceptance:** 所有本期明细完整且一次进入批次；比较只发摘要；引用限固定快照；分析独立 Astra/90或120秒，原任务预算不变。

- [x] RED：5000条产生10个完整批次；单行过大、10001条及未知引用拒绝；比较期备注/内部ID不出现在模型输入；原模型仍为 Luna。
- [x] GREEN：实现版本化 Zod 协议、统计与代号、UTF-8预算、分批和汇总输入；独立 Agent 路由与模型配置，禁工具/会话复用/自动重试。
- [x] Verify：`npx vitest run tests/unit/bill-analysis-protocol.test.ts tests/unit/bill-analysis-prepare.test.ts tests/unit/bill-analysis-agent.test.ts`，记录 RED/GREEN；检查旧 Agent 回归及镜像文件复制。
- [x] checkpoint：局部验证通过后登记结果，按偏好不单独提交。

### Task 2: 报告、回执与加密恢复

**Files:** `prisma/schema.prisma`、新增迁移；`src/lib/encryption/protected-models.ts`、`database.ts`、`recovery.ts`；`src/lib/reports/bill-analysis-store.ts`；`tests/integration/bill-analysis-store.test.ts`、`bill-analysis-encryption.test.ts` 及恢复测试。

**Acceptance:** 家庭组合外键、历史创建身份、同范围唯一最新报告；原 UUID/会话绑定、NOT_ACCEPTED 竞争、STOPPING阻止保存；新旧恢复包真实性不降级。

- [x] RED：原UUID查询先到后迟到受理不调用模型；撤销/跨家庭/旧代次不能保存；失败保留正文；加密存储无正文/范围旁路。
- [x] GREEN：实现报告/请求表和短事务存储接口，登记保护模型与SQL护栏；新版恢复实体集合和旧v1严格验证后补空；恢复不可续跑任务。
- [x] Verify：Prisma validate/generate、仅开发库 migrate deploy；`npx vitest run tests/integration/bill-analysis-store.test.ts tests/integration/bill-analysis-encryption.test.ts` 及原恢复测试。
- [x] checkpoint：记录模式转换、换钥和隔离恢复证据，整体验证前不提交。

### Task 3: 共享资源、逐调用计费及执行者生命周期

**Files:** `src/lib/resources/admission.ts`、`policy.ts`、新增 `bill-analysis-resources.ts`；`src/lib/reports/bill-analysis-owner.ts`；相关启动/停止脚本；`tests/integration/bill-analysis-resources.test.ts`。

**Acceptance:** 预检前取得延迟扣额ai原租约；每调用原子扣三窗口，已受理后不足在原预算等待；取消不提前释放；仅确认原本地执行者停止才回收崩溃占用。

- [x] RED：第11次调用等待跨窗后一次扣额；取消等待不扣额；租约过期不能保存；TTL或断联本身不回收活执行者。
- [x] GREEN：服务端分析档位9分钟、总截止8分钟；原默认75秒不变；逐调用计费和受取消控制等待；所有权与受控回收绑定原token/代次，不新增远端停止确认。
- [x] Verify：聚焦资源集成测试与旧 `resource-admission`/`resource-capacity` 回归，硬崩溃/停止证明负例。
- [x] checkpoint：记录正常清理及崩溃恢复边界，按偏好不单独提交。

### Task 4: 一致快照、业务编排与同源 API

**Files:** 新增 `src/lib/reports/bill-analysis-snapshot.ts`、`bill-analysis-service.ts`、`bill-analysis-agent.ts`、`src/app/api/reports/analyze/route.ts`；`next.config.ts`；`tests/integration/bill-analysis-service.test.ts`、`bill-analysis-route.test.ts`。

**Acceptance:** 相同上海日期与过滤器、一致快照、原会话/模式/租约前后复核；NDJSON流断开传播取消，最终提交后通知；生成/回看无SSR泄漏。

- [x] RED：真实 Next `ResponseAborted` 取消误判为 UNAVAILABLE；201 条密文实际解密 504 次而非 201；巨备注未预拒绝。其余范围、快照、同意、Origin/正文及原 UUID 场景以真实 DB/HTTP 回归验证，不伪称都曾失败。
- [x] GREEN：小请求正文校验，携钥请求上下文持续至本地执行清理；顺序分析及最终汇总；受控异常终态，原授权短事务替换报告。
- [x] Verify：聚焦服务/API集成及其他财务接口回归；合成延迟模型覆盖保存/取消、身份撤销/模式转换竞态。
- [x] checkpoint：登记接口与原UUID证据，按偏好不单独提交。

### Task 5: 应用内任务、首页报告与双语

**Files:** `src/components/bill-analysis-provider.tsx`、`bill-analysis-panel.tsx`、`src/lib/reports/bill-analysis-controller.ts`；`app-shell-view.tsx`、`src/app/(app)/home/view.tsx`、`src/lib/i18n.ts`；`tests/unit/bill-analysis-controller.test.ts`、`bill-analysis-panel.test.tsx`。

**Acceptance:** 月/年入口与披露，跟随查看范围，站内切页继续、切范围不改原任务；刷新只留UUID查询；共享最新报告列表、安全证据展示及中英文移动布局。

- [x] RED：重复点击仅一个生成请求；切范围旧响应不替换当前报告；卸载取消、刷新只query；持久存储无范围/备注/密钥；AI关闭仍可回看。
- [x] GREEN：应用级provider消费进度流，状态恢复与取消；现有UI样式及处理同意入口，明细证据与建议区分，报告生成语言和快照说明。
- [x] Verify：聚焦控制器与组件测试、移动中英截图及浏览器交互，无新增装饰/无关页面。
- [x] checkpoint：记录UI验证，不单独提交。

### Task 6: 整体流程与实际服务证据

**Files:** `tests/e2e/bill-analysis.spec.ts`、`tests/e2e/agent-fixture.ts`、必要的测试清理；私有运行探测产物置未跟踪 `tmp/`。

**Acceptance:** 21项验收逐一有证据，真实Astra以虚构账单完成协议，实际链路长流/预算到期/提前断开有分别证据。

- [x] 扩展现有受认证Agent fixture模拟分析协议，e2e只访问开发/测试库，覆盖月年、筛选、生成、共享、替换失败和跨页/刷新/取消。
- [x] 完整 lint、unit、integration、e2e 通过；unit 1215 通过/1 跳过，integration 1074/1074，e2e 218 通过/1 项既有正式服弱网选测跳过。集成用环境预载后的同一 Vitest runner；失败均按实际原因修复或恢复一致环境，未削弱断言、限额或排除文件。
- [x] 正式构建、真实 Astra 合成调用及人工核对通过；获用户维护授权后，以独立 `_test` 库和同一鉴权接口完成实际公网长响应、总预算到期及提前断开，记录非敏感时序/清理证据并恢复原服务。

### Task 7: 文档、安全与 Git/发布

**Files:** `docs/wiki/ai-bill-analysis.md`、`wiki.md`、`household-encryption.md`、实际受影响AI知识页；`README.md`、`docs/runbooks/home-network-checklist.md`；根版本字段。

- [x] 按实际实现同步wiki和运行规则，避免旧任务数据披露被笼统扩大。
- [x] 使用仓库安全skill完成实际diff的静态审查及两次测试隔离增量复核，记录 Findings/Verification/Residual Risk；65个任务文件私有值扫描零匹配、根版本一致，刷新origin/master仍为原基线。整体验收继续受完整e2e、公网长流和发布证据约束，未把静态无阻塞当作整体通过。
- [x] Git/发布前输入核验完成：feature 版本 1.62.0 一致，65 个任务文件所有权明确，无无关修改；本机四套验证、真实 Astra、公网运行验收及私有备份恢复均取得证据。

Git finalize 按既有偏好将 spec/plan/实现/文档归入同一个 feature 提交，fast-forward 并仅推送 master、核对实际远端 SHA；随后从已验证且干净的 master 按正式 Windows 脚本迁移（不 seed）、重启并核验健康。此计划记录提交前事实，最终 commit/push/发布结果以本次交付和私有发布记录为准，不通过改写已发布提交补写自身收尾状态。

## 实施记录

- 2026-11-02：用户批准spec，继承 prepared Git上下文；旧工作区无任务外修改。已读取安装版Next Route Handler指南；独立worktree安装锁定依赖，避免修改主工作区的生成客户端。
- 2026-11-02 checkpoint：批准状态与计划核验后不单独提交，遵守spec与实现同feature提交偏好。
- 协议/Agent：真实未知引用、缺失分析运行器及分批数学 RED 后实现；新旧 Agent 122 项通过。UI/controller 47 项通过；390px 中英截图检查无横向溢出。
- 资源：9 分钟档位和逐调用计费先 RED，后与原资源 16 项通过；owner 真子进程持租约硬杀及回收 5 项、包括可信 Docker 监督的单元 14 项通过。正式 Compose 的 `--builder default` 与直接 `docker build --builder desktop-linux` 区别按既有 runbook 保留。
- 存储/恢复：模型注册及 v1 原 proof 兼容 RED 后修复，旧 v1/新 v2 删除检查点、引用剥离、STOPPING/替换/撤销、开启/换钥/关闭和真实 HTTP 编排分组通过。快照容量修订回归与原加密报表共 20 项通过；独立安全审查原三个发现已关闭。
- 金额：1/2 分偶数支出的中位数原为 1.5 分，行为测试 RED；取整到分并在协议/存储共用安全整数校验后，协议与准备 25 项通过，ratio 保持小数。
- 取消：真实 Next `ResponseAborted` 回归 RED 复现后，按请求信号来源判定取消；service/route/resources 19 项通过，新 e2e 第二轮 4/4（38 秒）。首次 e2e 3/4 的失败保留为根因证据，不以直接服务测试代替真实请求断开。
- 实际 Astra：只用两笔虚构账目，明细 34,769 ms、汇总 25,049 ms，实际 `gpt-6-astra`/high 协议均通过；未发送家庭账目。Node 22 生产 tools/runner 镜像与 Next 正式构建通过，尚未部署。
- 全量验证：首次默认并发 unit 1210 通过、1 失败（旧敏感样本哈希扫描 5 秒超时）、1 跳过；同文件单跑 3.4 秒通过，限制 worker 为 1 后 136 文件/1211 通过、1 跳过，未改断言/超时。后续整数与快照修订完成后，正在重新运行最终稳定版 lint/unit/integration。
- 第一轮 integration 在代码修订期间中止，不作为最终证据；其中旧邮件限流 31 并发场景单文件复核 31/31，通过且未修改旧逻辑。最终四套完整检查稳定后再做 Git/发布收尾。
- 最终稳定版 lint 通过；全量 unit 使用 `npm run test:unit -- --maxWorkers=1`，136 文件、1215 通过、1 跳过。宿主 Node 26 的全量 integration 为 72/75 文件、1071/1074 测试通过：旧导入映射遇跨用例共享窗口 BUSY、旧种子分类测试未获得 DATABASE_URL、旧 10 万条加密导出达到原 60 秒生成时限；正在按实际原因复核，尚未作为通过证据。
- 独立测试实例使用正式 Node 22 web 镜像、PostgreSQL 17 `_test` 空库和 7000 条虚构记录，数据库与 Agent 不发布端口。loopback 3001 的 quick 验收通过：认证、3000 条/6 批加一次汇总、NDJSON 阶段、报告保存、租约与 execution 清零，约 1.8 秒；该证据不替代实际公网长流。
- 验证环境修复：映射管理测试的全局 import 窗口不随家庭清理，现按既有串行测试约束在用例前后仅清 `kind: import`，原额度与断言不变，37 项复核通过、lint 再通过。定向核验并删除本任务首次中断遗留的一份 100003 条容量合成 fixture 及其两用户/两分类，开发库执行 VACUUM ANALYZE；未广泛删除其他家庭。
- Node 22 tools 的诊断轮仍触发旧导出 60 秒期限；首个容器全量轮因部署镜像有意排除 `.env.*` 而缺少测试要读取的 `.env.example`，不作为验收。复核方式为只读挂载示例 env，不放宽 `.dockerignore`。未修改的 `master` 对照容量测试通过：生成 50,090 ms、下载 526 ms、逐值读取 2,437 ms、100001 条拒绝 36,978 ms；随后按同一本机环境、使用 `node --env-file=.env.example node_modules/vitest/vitest.mjs run --dir tests/integration --no-file-parallelism` 运行新版本完整集成。
- 正式入口只读基线健康为 HTTPS `/login` 200，HSTS、nosniff、frame protection、CSP 和 no-store 可见；未输出真实入口。隔离实例维护脚本语法及 prepare-only 通过，准确排除 OPS oneoff，仅捕获原 web 完整 ID 和 loopback 3000 绑定；实际约 20 分钟维护已向用户请求，尚未执行，不改 frpc 或生产数据库。
- 新版本同一本机环境的完整集成轮中，10 万条加密导出容量步骤通过：生成 36,498 ms、下载 505 ms、完整读取 2,675 ms、100001 条拒绝 37,584 ms；成品 5,885,555 bytes，密文 5,885,589 bytes。原 60 秒/10 万条/32 MiB 限制与原断言保持，未修改导出路径。整轮其余测试仍在执行，尚未将局部结果算作全量通过。
- 最终完整集成通过：75 文件、1074/1074，459.36 秒；按既有环境预载方式直接执行同一 Vitest runner（命令见上文），未排除文件、跳过用例或更改业务限额。开发数据库交还后启动完整 `npm run test:e2e`；最终功能代码与前述 136 文件/1215 通过、1 跳过的 unit 及 lint 一致，之后仅有导入测试窗口隔离和文档记录修订。
- 首次完整 e2e 至第 65 项时 64 通过、旧账号密码 UI 用例超时，后中止并执行 owned teardown，不把其余用例当已执行。核验发现两个 seed 测试账号累积 4229 个有效旧 AppSession、账号页约 66k DOM 节点；在仅限 loopback `_dev`/`_test` 的既有每用例前夹具事务中撤销这两个账号的旧会话，保留 ID/历史，同用例的多会话不受影响，未修改账号业务逻辑或断言。原失败用例 3.1 秒通过，连同账号 UI 其余两项及新账单四项合计 7/7（46.7 秒）；lint、原 cleanup 单元 2/2 及独立安全增量复核通过。随后启动完整 219 项重跑；应用代码与前述全量 unit/integration 通过时一致，仅 e2e 夹具和记录变化。
- 最终完整 `npm run test:e2e` 218 通过、1 跳过，11.9 分钟。跳过项为仓库既有 `WEAK_NETWORK_PRODUCTION_PERF=1` 才启用的正式 standalone 弱网性能选测，未修改跳过条件；默认开发 e2e 的全部实际执行用例通过，新账单四项及旧账号 UI 均通过。所有应用代码与已通过的正式构建、全量 unit/integration 保持一致。
- 实际 Astra 合成建议人工复核：仅 6 笔虚构账目（收入 10000 元、支出 440 元、账面结余 9560 元；餐饮 4×60 元，购物 200 元），明细 34,276 ms、汇总 38,353 ms。实际返回 3 项观察和 3 项建议，金额、餐饮 54.55%/购物 45.45% 占比及引用与固定输入一致；明确账面结余不等于储蓄，未编造环比/同比，建议围绕覆盖范围、按周复盘和采购周期。正文仅保留于 ignored 合成验证产物，未发送真实账目。
- 用户确认维护后，首轮端口交接被 Node 本机探测误报阻止，finally 恢复原完整 web ID 与 HTTPS 200，未开始长流。在仅有的隔离端口复现 Node `EADDRINUSE` 但 Docker 容器交接成功后，私有 helper 改以 Dockerd 启动作为端口分配门槛，保留完整 ID、labels、loopback、合成身份校验和 finally 恢复；应用与正式脚本无变化。
- 实际公网三个场景通过：完成 393,119 ms，42 个心跳、最大间隔 9,413 ms、首分析进度 1,164 ms；总预算到期 447,819 ms，47 个心跳、最大间隔 9,420 ms，终态 TIMEOUT；客户端断开取消 10,546 ms，终态 CANCELLED。均按实际客户端时长记录，原服务 `8 * 60_000` 总预算未改。三个原租约 token 的 lease/execution 审计均 0，两个失败的完整旧报告 DTO 摘要不变。恢复记录为 passed/restored，原生产完整 ID/镜像恢复运行，错误列表为空，实际 HTTPS `/login` 200；独立审查已重算原始时序，确认本轮及时透传及清理边界。
- 正式发布前私有备份与离线恢复通过：备份保留在主工作区已忽略的 `tmp/backups/` 目录；空目标 PostgreSQL 17 恢复后，33 张表的全部 COPY 列/行 canonical 摘要、完整 schema、FK/check 约束、历史归属及金额 BigInt 聚合摘要均与归档一致，序列两端均 0。前两轮辅助工具的 tmpfs 传输及 `pg_restore --file -` 参数问题修正后才取得通过证据；未出现数据比较差异。未解密或外发真实数据，未对正式数据库写入；恢复容器、网络、临时凭据及明文提取文件已按所有权清理。

### 验收对照

| Spec 验收项 | 结果与证据 |
| --- | --- |
| 1 月/年、账本与成员范围 | 通过：范围/快照集成、新账单 e2e 的归档账本及历史成员筛选。 |
| 2 上海日期及整数分 | 通过：范围与准备单元、共享协议整数校验、中位数 RED/GREEN。 |
| 3 全明细、原备注与比较摘要 | 通过：5000 条完整分批覆盖及输入捕获；内部 ID、比较期备注不外发。 |
| 4 本人 AI 选择与受理 | 通过：服务集成及 e2e 未同意零调用、原任务绑定检查。 |
| 5 一致财务快照 | 通过：真实 DB/HTTP 首批期间并发插入，仍保持原 501 条快照。 |
| 6 空范围及缺少基期 | 通过：统计/服务/协议回归，无数据零调用且不清旧报告。 |
| 7 批次与字节上限 | 通过：条数、单行、完整覆盖、汇总/结果大小及未知引用负例。 |
| 8 实际 Astra 与原模型独立 | 通过：真实合成明细/汇总协议及六笔虚构结果人工核对，原 Agent 回归；运行配置分开。 |
| 9 实际公网长响应 | 通过：同一真实链路完成、原总预算到期、客户端断开，持续心跳/阶段、资源归零、失败保留旧报告及原服务恢复证据齐备。 |
| 10 不可信输出 | 通过：严格协议/引用校验、提示与安全文本渲染、真实浏览器 CSP 回归。语义建议仍需人工判断。 |
| 11 导航、切范围、刷新与取消 | 通过：控制器单元、新 e2e 及真实 Next 断连回归。 |
| 12 未受理 UUID 与迟到请求 | 通过：真实 DB 锁竞争、原 UUID tombstone、服务及浏览器回归。 |
| 13 共享最新报告与替换 | 通过：跨成员读取、代次/并发、失败与刷新保留旧报告。 |
| 14 家庭、原身份及会话边界 | 通过：组合外键、跨家庭/撤销/失效/模式竞态与旧会话冲突。 |
| 15 共享资源及本地取消清理 | 通过：旧资源回归、HTTP 取消/超时、STOPPING 与最终保存锁序。 |
| 16 第 11 次调用跨窗 | 通过：本地窗口等待、原租约/总期限、原子扣额、取消与过期负例。 |
| 17 硬崩溃恢复 | 通过：真实子进程持租约硬杀、确认停止后封禁/回收，未知或活实例不回收。 |
| 18 加密、换钥与模式转换 | 通过：报告/回执保护注册、SQL guard、转换及逐值恢复回归。 |
| 19 v1/v2 独立恢复 | 通过：原 v1 proof、完整 v2/删除检查点、缺表/篡改/在途恢复拒绝。 |
| 20 中英文手机界面 | 通过：组件、新 e2e、390px 中英实际截图与 viewport 人工检查。 |
| 21 验证、Git 与正式发布 | 本机四套验证、构建、静态/运行安全、公网及私有恢复门槛完成；提交前输入齐备，Git/正式发布执行结果见本次交付记录。 |

### 安全审查记录

- **Findings：** 独立静态审查原三项发现均已修复并复核：密文分页反复解密、明文大备注读取前缺少容量拒绝、中位数可产生小数分。最终静态及运行审查未发现新增 P0/P1；保持同家庭权限、软删除过滤、一致快照及 SQL 护栏。后续导入窗口隔离和 e2e seed 会话撤销夹具均经独立只读增量审查，严格开发/测试库保护和用例内行为不变。继承 P2/F1 外部日志配置独立证据缺失，不将原音频维护者确认推导为报告正文日志已经独立验证。
- **Verification：** 审查实际 diff、权限与原会话绑定、UUID 竞态、模型输入、报告 DTO、加密和 v1/v2 恢复、owner 回收及 Windows 监督；`git diff --check`、PowerShell AST、针对性敏感内容扫描通过。主 agent 的协议/金额、真实 DB 快照、取消及资源回归证据见上文；根版本 1.62.0 和七份文档本地链接检查通过。
- **Residual Risk：** 本机与本轮实际公网验收已通过；长流使用受控 Agent，实际 Astra 合成调用与人工核对另行取证。原外部日志 F1 独立配置核验沿用此前已批准延期，本次未改变转发链路/日志规则，不虚构日志独立核验结论。既有正式 standalone 弱网性能选测未运行，本次未调整其条件。正式发布与发布后健康仍须以实际操作结果收口。

### 提交前状态与发布衔接

- 2026-11-02：用户明确确认约 20 分钟公网维护；继续既有 implement 与 prepared Git 上下文，不重复需求或发布批准。仅临时将正式入口切到独立测试实例，完成真实链路三个长流场景后恢复原服务，正式数据库、OPS 与 frpc 配置不变。
- 上一轮将 tmpfs 测试库随容器停止后，其合成数据实际已清空；启动保护拒绝复用，未影响正式服务。已按完整 ID/专用 labels 清理旧测试资源，重新验证空库、迁移并建立 7000 条虚构记录，新 quick 再次通过，约 2.1 秒；维护前重新捕获正式 web 身份。
- 本轮实际公网验证与私有备份恢复均已通过，保留同一个 feature 工作单元，自动进入 Git/正式发布收尾。
- 65 个任务文件已按 prepare 所有权暂存，未夹带生成文件；feature 分支和 worktree 保留。尚无本次 commit、merge、push 或 PR；远端实际 `master` 与本地原基线一致，主工作区干净。
- 公网维护已自动恢复正式原 web 的完整容器 ID、镜像及 loopback 3000 绑定，实际 HTTPS `/login` 为 200。运行证据仅保留非敏感时序与审计结果，私有配置和真实入口不进入 Git。
- 正式发布前确认源代码、版本及依赖与已验证输入一致；只从已推送、干净的 master 执行正式启动，不 seed。无新应用改动时复用此前有效检查，不机械重跑全套测试。发布后记录实际远端 SHA、镜像 revision、HTTP 健康，并清理 owned 隔离资源及干净的任务 worktree/分支。
