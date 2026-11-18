# 长按语音记账 Implementation Plan

> **For agentic workers:** REQUIRED SKILL: Use implement to execute this plan task-by-task. Respect the handed-off git_state: inherit prepared, otherwise prepare; use git-workflow for checkpoint/finalize. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 当前页长按录音，经豆包转写后自动复用既有 Agent 原子记账，支持取消、纠错与幂等恢复。

**Scope Source:** [已批准 Spec](../../scope/2026-10-13-voice-accounting.md)

**Architecture:** 音频采集和转写属于可取消的页面内存任务；转写端点不写账。共享请求控制器原子交接语音占用与自然语言 UUID，应用外壳承载浮层，文字和语音保留独立草稿。服务端沿用既有事务和成员验证。

**Tech Stack:** Next.js 16、React 19、Web Audio、PCM WAV、豆包录音文件识别 2.0、Vitest、Playwright、Prisma。

**Verification:** 聚焦行为测试后运行 lint、unit、integration、e2e、build；真实 ASR／Agent 合成语音与移动端录音；安全审查、部署健康和麦克风响应头。

---

## Git 与文件所有权

继承 prepared：`feature/voice-accounting`，工作区 `.worktrees/feature/voice-accounting`，基线 `v1.44.0`，初始无他人修改，只有本任务 Spec 未跟踪。checkpoint 按偏好不单独提交，完整验证后 Spec 与实现合为一个 feature 提交；版本升至 `1.45.0`，合回并只推送 master。主 agent 统一整合、验收和 Git 收尾。

## Task 1：转写服务与边界

**Files:** 新建 `src/app/api/voice/transcribe/route.ts`、`src/lib/voice/transcribe.ts`、`src/lib/voice/wav.ts`、对应 `tests/unit/voice-*.test.ts` 和 `tests/integration/voice-transcribe.test.ts`。

**Acceptance:** 固定供应商；2 MiB 有界读取；16 kHz 单声道 PCM16 WAV 且至多 60 秒；前后验证会话、同源、成员频率与并发限制；错误返回固定代码；30 秒调用预算；不留正文。

- [x] 先验证畸形／超限音频、失败业务码、静音、跨源和失效会话不能得到可记账文本，记录缺失行为的 RED。
- [x] 实现最小路由、WAV 校验及 HTTP 适配；用真实 HTTP fixture 隔离供应商边界。
- [x] 运行 `npx vitest run tests/unit/voice-wav.test.ts tests/unit/voice-transcribe.test.ts tests/integration/voice-transcribe.test.ts`，确认有效文本、取消、超时及响应边界。
- [x] checkpoint：核对文件归属，暂不提交，等待完整 feature。

## Task 2：浏览器录音与手势

**Files:** 新建 `src/lib/voice/recorder.ts`、`src/lib/voice/press.ts`，对应 `tests/unit/voice-recorder.test.ts`、`tests/unit/voice-press.test.ts`。

**Acceptance:** 生成真实 WAV；晚到授权、取消、到限停止、设备释放可观察；按压松开决定提交，录音到限不自动发送。

- [x] 写采样上限、重采样、权限晚到与取消清理的行为测试并记录 RED。
- [x] 实现浏览器采集及纯手势状态；轨道、节点及音频上下文所有退出路径释放。
- [x] 运行 `npx vitest run tests/unit/voice-recorder.test.ts tests/unit/voice-press.test.ts`；实际采集能力另由浏览器验证。
- [x] checkpoint：检查聚焦证据，暂不提交。

## Task 3：共享控制器、导航与浮层

**Files:** 新建 `src/lib/transactions/natural-language-controller.ts`、`src/components/voice-accounting-provider.tsx`、`src/components/voice-entry-link.tsx`；修改 `app-shell.tsx`、`bottom-nav.tsx`、`desktop-nav.tsx`、`accounting-input.tsx`、`natural-language-form.tsx`、`src/app/(app)/layout.tsx`、`src/lib/i18n.ts`；新增控制器单元和语音 e2e。

**Acceptance:** 文字／语音唯一占用；语音必须 UUID 写入读回后调用 Action；旧 UUID 全局恢复不猜来源；取消转写不查询 UUID；成功只清理已知发起方快照，底层草稿保留。

- [x] 控制器测试先证明占用互斥、存储失败不提交、网络未知仅查询原 UUID、无来源恢复与旧结果兼容；运行并记录 RED。
- [x] 提取现有请求状态，接入原文字表单，保留原文字存储降级行为及结果展示。
- [x] 接入浮层和导航手势、键盘控制、路由代次和生命周期取消，同步中英文文案。
- [x] e2e 覆盖短按／长按／取消、晚到授权、60 秒、纠错、恢复、取消晚到转写、草稿和筛选保留；运行聚焦 unit／e2e。
- [x] checkpoint：核验交接无空隙、无隐式重发，暂不提交。

## Task 4：配置与长期文档

**Files:** `.env.example`、`compose.yml`、`ops/windows/start-production.ps1`、`ops/nginx/billboard-location.conf`、`README.md`、`docs/runbooks/home-network-checklist.md`、`docs/wiki/natural-language-accounting.md`、`docs/wiki/wiki.md`。

**Acceptance:** Key 仅 web 私有 env；麦克风 self；不收紧账单上传；无公网端口变化；Wiki 记录两阶段、临时数据和恢复边界。

- [x] 核对既有部署注入及 nginx 配置，只修改必要项；首个工作单元同步批准的 Wiki 目标。
- [x] 检查 Compose 配置、脚本语法、引用路径、i18n 及秘密／入口标识卫生。
- [x] checkpoint：保留同一个 feature 的文件所有权，暂不提交。

## Task 4B：录音文件识别 2.0

**Files:** `src/lib/voice/audio-store.ts`、`src/app/api/voice/audio/route.ts`、`src/lib/voice/transcribe.ts`、对应 unit／integration、Task 4 的部署和文档文件。

**Acceptance:** 经私有临时 WAV 与 256 位随机 token 下载链接提交 2.0；固定 submit／query、相同请求 UUID、正确处理队列和处理中状态；总预算 30 秒，成功／失败／取消和租约到期清理；下载鉴权、容量、日志不泄漏。

- [x] 先写异步供应商协议与能力下载生命周期测试并确认 RED；真实 HTTP fixture 下载 WAV，验证禁止 Base64 和任意 URL／路径输入。
- [x] 实现临时存储、限时下载、提交和查询；下载 URL 不返回浏览器或传给 Agent，既有转写接口和页面两阶段取消语义保持。
- [x] 同步 web 私有 origin 配置、tmpfs、nginx 下载日志关闭与 Next 开发日志排除；更新既有 Wiki。
- [x] 运行聚焦 unit／integration／安全配置检查，记录所有退出路径及会话失效的结果；checkpoint 延后至完整 feature。

## Task 4C：按实际 FRPC／域名转发入口适配

**Files:** `next.config.ts`、转写路由说明、入口相关测试、Spec、README、runbook、已确认 Wiki、`AGENTS.md` 和安全审查规则中的入口事实。

**Acceptance:** 保留当前转发链路与 loopback 端口；应用自行提供同源麦克风策略，实际 HTTP 响应可见；nginx 仅为可选示例，外部日志限制仍须核验。

- [x] 只读核对 FRPC 类型及公开 HTTPS 登录响应：TCP 转发、HTTP 200、无重定向／iframe；现有响应缺少 Permissions-Policy。
- [x] 应用添加权限头，修正文档和相关测试中的错误 nginx 部署前提；核验真实 Next HTTP 响应。
- [x] 运行受影响配置和浏览器回归、构建；安全复核，复用未受影响的测试证据。
- [ ] 获得域名转发服务信息后核验回源和能力 URL 日志；继续既有真实设备和 ASR 验收。

## Task 5：完整验收与发布

- [x] 2.0 最终实现执行 `npm run lint`、`npm run test:unit`、`npm run test:integration`、`npm run test:e2e`、`npm run build` 全通过；复用未受影响的既有证据，数据库验证只针对已核实开发库。
- [ ] 取得真实 Key 的合成普通话、英语、混合收支 ASR／Agent 证据，记录真实移动端 Safari／Chrome 和桌面采集结果；无法取得的证据明确保留未完成。
- [x] 按 `skills/billboard-security-review/SKILL.md` 输出 Findings、Verification、Residual Risk，修复实际问题并复测受影响项；外部验收缺口仍阻塞最终通过。
- [ ] 更新根版本至 1.45.0、核对实际 diff 与远端；所有必要验证满足后提交、rebase、fast-forward master、push 并核对远端 SHA。
- [ ] 推送核验后从 master 按既有脚本部署，不 seed；验证健康、实际麦克风头和合成语音链路，清理干净任务工作区。用户已于 2026-10-14 指定先发布供正式服务测试；公网／真机验证保留为发布后验收，不冒充已通过。

## 执行记录

- 2026-10-13：用户批准 Spec，继承 Git prepare，独立审查 0/0/0。计划自审覆盖 Spec；checkpoint 不单独提交，符合项目偏好。尚未执行功能验证。

- 2026-10-14：后端57项、录音手势18项、控制器9项聚焦测试通过，包含行为RED/GREEN；组件与配置针对性验证通过。首轮语音e2e 7/9，正修复键盘焦点并补回归。完整unit在Windows受既有Agent取消清理EBUSY影响，降低并发后剩2项；正对照master基线。真实Key及实机采集证据仍未取得，尚不具备提交／发布条件。

- 2026-10-14：共享控制器的 `getServerSnapshot` 改为稳定的初始快照；新增回归先失败、修复后控制器10项通过。关闭 Next 开发模式默认 Server Function 参数日志，防止记录转写正文。完整 lint、构建通过；完整 integration 31文件／511项通过，仅使用 loopback `billboard_dev`。
- 2026-10-14：Windows Agent 清理的两项失败在未修改的 master 同样复现；实测 `taskkill /T /F` 超过测试原有1秒轮询预算。未改 Agent 或放宽断言。在已有 Linux Node 22 tools 镜像中，以当前任务公共文件只读覆盖、`--init --network none`、不挂私有 env／数据库／生产卷运行完整 `npm run test:unit -- --maxWorkers=2`：69文件／583项全部通过。
- 2026-10-14：语音专项13项已有12项通过，录音及成功浮层移动截图已检查。现有浏览器回归仍有隐藏重复节点与开发指示器遮挡问题，正在与 master 对照；60秒到限的提交／取消两条浏览器用例已补充，尚待运行。不可将当前 e2e 视为全通过。
- 2026-10-14 安全审查：**Findings**：未发现 P0／P1 代码问题；P2 为真实 Key、真机采集和实际 nginx 响应头证据缺失。**Verification**：79项安全相关聚焦检查、diff空白检查、变更文件秘密模式扫描、URL／版本／依赖差异核对通过；后续快照修复新增1项测试并纳入完整单测。**Residual Risk**：完整 e2e 未通过；真实 ASR／Agent 合成语音、移动 Safari／Chrome 与桌面麦克风、实际入口策略未验证，供应商留存及合法金额误识别无法由应用保证。当前不提交、不推送、不发布。
- 2026-10-14：未修改的 master 原样两条 home／add 浏览器用例2/2通过，任务树0/2；DOM采样定位到初始化期间约200毫秒的 `body > div#S:0[hidden]` 重复流式片段，无水合错误。为语音 Context 值加 `useMemo` 后同两条原样2/2通过，未改断言。现有 `PLAYWRIGHT_TEST_BASE_URL` 环境下关闭 Next 开发指示器，避免其膨胀的 Rendering 标签遮挡移动导航；正常开发及生产不受此测试配置影响，编译／运行错误仍显示。后续完整浏览器回归在配置冻结后运行。
- 2026-10-14 最终自动化：配置冻结后完整 `npm run test:e2e` exit 0，117项通过、1项既有生产模式性能用例按原配置跳过，耗时5.3分钟；包含15项新增语音／60秒浏览器用例。完整 lint、583项Linux unit、511项integration及最终 build 通过；快照调整后另补跑记账页2项integration通过。移动截图内容、按钮与布局正常。对照采样修后8/8无重复，0水合／页面错误。
- 2026-10-14 增量安全审查：47个变更文件秘密模式扫描、30个URL、diff空白、三处根版本1.45.0、lock仅版本变更均通过；固定快照、稳定Context及Next日志／指示器配置未新增隐私或授权风险。仍保留真实供应商、设备、正式入口验证缺口，不宣称最终安全验收通过。
- 2026-10-14 真实ASR：用户提供Key后，仅保存至根仓库未跟踪 `.env.local`。生产适配器对普通话、英语、中英混合三份合成WAV均得到 HTTP 403／业务码 `45000030`，原因类别 `resource_not_granted`。当前Key所属项目尚需开通 `volc.bigasr.auc_turbo`；没有成功转写可交给真实Agent。合成WAV与不含凭据／原始响应的固定诊断结果保存在忽略的 `tmp/voice-smoke/`，不纳入Git。已向用户请求资源开通状态及可用真机设备；不绕过此验收条件提交／发布。
- 2026-10-14 运行入口与Git收尾：从私有配置在进程内读取实际HTTPS入口，仅做登录页只读检查，HTTP 200但缺少 `Permissions-Policy`；尚未找到可核实的远端nginx管理路径，未修改或重载正式服务。finalize 状态 `blocked`：资源授权、真机与实际入口验收未完成，按已批准Spec与仓库门槛保留未提交的 `feature/voice-accounting` 工作区；不提交、不合并、不推送、不清理。根master保持干净，本地和远端的 master 一致。无正式账本写入。

- 2026-10-14 技术变更：用户阅读官方任务提交文档后明确“采用”录音文件识别 2.0；恢复 implement 与 prepared Git 上下文，直接更新已批准 Spec 的技术决策。2.0 查询不存在的随机任务返回 HTTP 200／`45000092`，未遇到旧资源的授权拦截，但尚未证明成功转写。新增临时 WAV、限时下载能力、异步提交／查询和日志限制；保留原有 30 秒交互预算，真实延迟待测。已请求现有 nginx 管理别名或私有运维配置路径以完成正式入口验证；继续独立实现及测试，不重复请求批准。

- 2026-10-14 真实 2.0 能力验证：使用火山官方文档公开的短音频样例和已有私有 Key；该样例虽以后缀 `.wav` 发布，实际为 ID3／MP3，时长 3.575 秒，因此探测按 `format: mp3` 提交。结果为 submit `20000000`（556 ms）、query `20000001`（691 ms）、query `20000000`（1,826 ms），有效文本 8 字。仅保存固定状态和耗时，不保存正文或凭据；已证实现有 Key 的 `volc.seedasr.auc` 权限可用。此证据仅覆盖真实供应商协议，不能替代应用 WAV 下载入口、普通话／英语／混合记账录音和实际设备验收。

- 2026-10-14 2.0 首轮验证：完整 lint 和 Linux unit 70 文件／636 项通过，覆盖实际 Linux 0700／0600 和 symlink 拒绝。完整 integration 默认并行时 514 项通过、1 项 seed 分类断言读到其他测试的临时分类；排除测试相互写同一全局分类表的干扰，以 `npm run test:integration -- --fileParallelism=false` 原样断言重跑 32 文件／515 项全通过。未改测试断言或应用分类行为。
- 2026-10-14 部署配置验证：22 项 security／base-path、PowerShell AST 与实际脱敏、Compose 合成环境隔离通过。无端口发布的隔离 nginx 实测 GET／HEAD 200／502、尾斜杠 404、安全响应头与能力 token 不进入访问／错误日志；其他路径保留访问日志。隔离 tmpfs 验证 40 MiB、0700／0600 与 nosuid／nodev／noexec。未变更实际公网 nginx 或生产服务。
- 2026-10-14 收尾发现：安全审查要求补瞬时 unlink 失败的有界回收，能力在失败前已撤销；构建发现动态 fs.open 过度追踪工作区，须对运行时临时路径明确排除构建追踪并检查最终产物。两项均在发布前修复与复验，不将首轮构建作为最终产物。

- 2026-10-14 2.0 最终代码验证：补齐删除瞬时失败恢复、持续失败保留容量／可重试、原 TTL 保留 3 项 RED→GREEN；完整 Linux unit 70 文件／639 项通过，完整 lint 通过。受清理修复影响的两组 integration 25 项再通过，其他集成沿用 515 项完整串行结果。只有 Windows 跳过的 POSIX symlink 用例已在 Linux 实际执行通过。
- 2026-10-14 构建边界：两个运行时 fs.open 使用 `turbopackIgnore`；按本机 Next.js output 文档，为 `/api/voice/*` 精确排除 `./tmp/**/*` 和 `./.env*.local`。最终生产 build 通过，无新增动态文件追踪警告；audio／transcribe trace 分别117／210文件，临时目录和私有 env 命中为0，standalone 同样为0。旧构建归档移至根仓库忽略的 tmp，避免其生成类型被任务源码扫描；没有修改 TypeScript／Vitest 忽略规则来隐藏问题。
- 2026-10-14 生产 bundle smoke：真实 Next production 服务仅绑定 loopback 2560，使用独立开发库 fixture 与假供应商；真实 AppSession 上传 → 编译后的下载 GET／HEAD 获取逐字节一致 WAV → 同一 UUID submit/query → 文本返回200。清理后下载404，日志不含能力 token，账本写入0，fixture 和测试进程均清理。真实 Next dev 对合成无效 token 返回404／no-store，开发日志不含该标记。此证据验证跨 route bundle 全局状态，不冒充真实供应商回源。
- 2026-10-14 增量安全复核：**Findings**：临时删除重试 P2 已修复，无遗留代码层面的阻塞缺陷。**Verification**：真实会话／HTTP／文件生命周期、Linux权限、生产bundle、nginx／tmpfs隔离检查、构建产物和50文件已知私有值扫描通过，三处根版本一致为1.45.0。**Residual Risk**：实际公网 WAV 下载及三种合成记账录音／Agent联调、实际私有 nginx 和真机采集尚缺证据；持续文件系统删除错误保留容量并拒绝扩张，需恢复底层条件。当前部署仍是单进程状态；应用清理不等于供应商侧删除。

- 2026-10-14 最终浏览器回归：冻结代码后完整 `npm run test:e2e` exit 0，117项通过、1项原有生产模式性能用例按原配置跳过，耗时5.4分钟，含15项语音／60秒用例。测试结束开发服务已停止，恢复 Next 自动生成声明中的生产类型路径，不保留生成文件差异。完整 lint／639项Linux unit／515项integration（受清理修复影响25项补跑）／117项e2e及生产build证据满足本地自动化门槛；最后构建配置补充另经22项安全配置／base-path及目标lint验证。
- 2026-10-14 Git finalize：状态 `blocked`，原因限于已批准Spec要求的实际公网 WAV 回源、三种合成记账录音与Agent、实际nginx及真机录音验收尚未取得。已请求现有nginx SSH别名或私有运维配置路径及可用设备，未获回复；2.0资源权限已由真实官方短音频成功验证，不再将旧极速版资源授权列为阻塞。保留本任务 `feature/voice-accounting` 工作区及全部修改；按既有单一feature提交偏好未提交、合并、推送、发布或清理分支，不绕过验收。根master干净，本地和远端的 master 仍一致，正式服务未改动，无正式账本写入。

- 2026-10-14 入口事实更正：用户确认远端未部署 nginx，实际使用 FRPC 与域名转发服务。私有配置只读检查确认本地 loopback 3000 的 TCP 转发；公网 HTTPS `/login` 200、无重定向或 iframe，与本地应用响应结构一致，权限头缺失。此前要求 nginx SSH 管理信息的前提不成立，停止该要求。当前仅等待转发服务名称以核实响应头／回源／日志能力；不将未知日志策略视为已通过，不修改正式服务。

- 2026-10-14 无 nginx 入口适配：应用 `next.config.ts` 提供全局同源麦克风 Permissions-Policy；转写路由仅修正入口注释，安全校验行为不变。README、runbook、已确认 Wiki、AGENTS 与安全审查规则同步实际 FRPC／域名转发事实，frpc 示例仅改注释、运行配置无变化。完整 lint、build 和22项安全配置／base-path检查通过；静态文本测试先因两份文档同义表述不同失败，分别匹配各自真实表述后通过，未改变端口／安全断言含义。
- 2026-10-14 HTTP 验证：真实 Next production bundle 在 loopback 测试端口自行返回麦克风策略；实际音频 GET／HEAD 保留 no-store／no-referrer 与逐字节 WAV，submit/query 返回200、撤销后404、日志无token、账本写入0。构建两route tracing分别117／210文件，无私有env或tmp；三处版本仍为1.45.0，变更文件已知私有值扫描0命中。
- 2026-10-14 增量安全审查：**Findings**：无本轮新增代码缺陷；P2为真实域名转发服务的日志、回源与入口验收缺证据。**Verification**：权限头、音频私有响应头、同源拒绝边界、文档一致性、HTTP smoke 与 diff空白检查通过。**Residual Risk**：待确认服务身份、回源加密或可信网络边界、请求头透传、真实WAV下载／失效和正常／失败请求不记录能力URL；不以公网HTTPS200代替这些证据。原有真实移动／桌面录音与三种ASR／Agent验收仍未完成。

- 2026-10-14 入口更正收尾：最终完整浏览器回归117项通过、1项既有生产性能用例按原配置跳过，耗时5.5分钟；恢复Next开发运行生成的next-env类型路径差异。本轮复用未受影响的639项Linux单测与515项集成证据，受影响配置22项、完整lint/build与HTTP smoke重验通过。Git checkpoint／finalize仍为 `blocked`：等待实际转发服务信息与公网／真机验收，不再要求nginx SSH。按单一feature偏好保留全部任务修改，未提交、合并、推送、发布或清理；根master干净，本地和远端的 master 仍一致。正式服务与私有FRPC配置未改动。

- 2026-10-14 用户明确要求先合并主干、推送并更新正式服务，由用户在正式服务测试。继承 prepared Git 上下文；本次发布顺序覆盖此前外部验收缺失即不发布的安排。代码与自动化证据仍有效，安全复核无未修复代码缺陷，公网日志／回源及真机证据仍保留待验。按用户授权进入 Git finalize 与正式发布；本提交中的记录截至发布准备，实际提交SHA、推送及健康检查结果以本轮收尾报告与私有部署日志为准。
