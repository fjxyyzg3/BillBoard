# Windows 客户端与应用内更新 Implementation Plan

> **For agentic workers:** REQUIRED SKILL: Use implement to execute this plan task-by-task. Respect the handed-off git_state: inherit prepared, otherwise prepare; use git-workflow for checkpoint/finalize. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付连接现有家庭服务、可私下安装及在应用内安全升级的 Windows x64 客户端。

**Scope Source:** `docs/scope/2026-10-23-windows-desktop-client.md`，用户已于 2026-10-23 批准。

**Architecture:** Electron 主进程管理受限 WebContentsView、固定会话、文件权限和更新器；网页以窄桥提供状态和更新交互。现有 Next.js 服务按原 AppSession 提供签名清单及有界文件流，NSIS 只在用户确认且业务收敛后安装。更新签名使用 Node 内置 Ed25519，私钥不进入服务端或 Git。

**Tech Stack:** Next.js 16.4、React 19、Node.js 22、Electron 45、electron-builder 26、NSIS、Vitest、Playwright。

**Verification:** 根项目 lint/unit/integration/e2e；协议与原生 Node 测试；隔离 Electron 交互、真实 NSIS 安装／两版本覆盖；构建和发布来源核验；仓库安全审查及正式服务健康检查。

---

## 输入与所有权

- Git 已准备：分支 `windows-desktop-client`，worktree `.worktrees/windows-desktop-client`，基线 `v1.56.1`。原工作区干净；spec 是本任务既有未跟踪文件。
- 继承 `git_state: prepared`，不重复 prepare。按偏好，所有通过验证的任务 checkpoint 均记录为待最终单一 feature 提交；不单独提交 spec、plan 或临时任务分支。
- 主 agent：文档、`desktop/src/`、`desktop/tests/`、根入口／版本／忽略／Compose、整合及 Git／部署。
- 服务端 agent：`src/lib/desktop-update-manifest.mjs` 与声明、`src/lib/desktop-update.ts`、Windows API 及相关 unit/integration 测试。
- 网页 agent：`src/lib/desktop-updater.ts`、更新 provider/controls、安全协调及对应页面、i18n、unit/e2e 测试。
- 打包 agent：`ops/desktop/`、`desktop/package*.json`、`desktop/electron-builder.cjs`、`desktop/installer.nsh`、工具测试及 Windows runbook。

## 共享接口

- 签名 payload：`{schema:1,productId:"com.billboard.desktop",platform:"win32",arch:"x64",version,size,sha256,notes:{"zh-CN","en-US"}}`；封装 `{payload,signature}`，二者是严格 base64，签原始 payload 字节。
- 协议模块导出 `DESKTOP_PRODUCT_ID`、`MAX_DESKTOP_INSTALLER_BYTES`、`MAX_DESKTOP_MANIFEST_BYTES`、`DESKTOP_SHA256_PATTERN`、`parseDesktopRelease`、`parseDesktopEnvelope`、`verifyDesktopManifest`、`createDesktopManifest`、`compareDesktopVersions`。
- 原生桥为 `window.BillBoardDesktop`：`postMessage(string)`、`subscribe(listener)=>unsubscribe`，listener 接收 `{data:string}`；使用函数注册兼容 contextBridge 冻结对象，不给网页原始 IPC。固定命令 `status/check/download/install/cancel/safety/prepared`；语言仅 `zh-CN/en-US`。
- 状态：`{status,installedVersion,release,progress,error}`，status 为 `idle/checking/available/downloading/ready/installing/error`，error 为 `null/offline/auth/unavailable/invalid/download/install/cancelled/busy`；release 为上面 payload。
- 安全心跳 `safety` 含 `ready/busy/dirty/identity/locale`，ready 为页面可判断状态，identity 为当前账号／家庭／成员的稳定字符串；不含账务。原生安装前发 `{type:"prepare",requestId}`，网页阻止新提交并回应 `{command:"prepared",requestId,ready,busy,dirty,identity,locale}`；解除使用 `{type:"release"}`。普通窗口关闭／后台无自动安装。
- 原生网络抓取原任务 Cookie 快照并只发固定 HTTPS 同源更新端点，不把 Cookie 暴露到桥。安装前用原 Cookie 再校验，不随新登录切换。
- Electron 通过构建生成的 `desktop/shared/desktop-update-manifest.mjs` 复用唯一根协议源；生成目录忽略。打包复制源与共享协议至独立应用 staging，不把 Electron 引入 web 依赖。

## Task 1：批准状态、Wiki 和环境基线

**Files:** 当前 spec、`docs/wiki/windows-app.md`、Wiki 索引及本 plan。

- [x] 根据本次用户批准更新 spec 状态；同步已确认 Wiki 目标，保持首行摘要与来源。
- [x] 核验 Git 与版本、文档引用；准备独立 Node.js 22 和当前 worktree 依赖，确认开发库仅使用 `billboard_dev`。
- [x] checkpoint：定向文档检查通过，不单独提交；继承既有 Git 生命周期。

## Task 2：签名协议与认证分发

**Files:** 见服务端 agent 所有权；测试 `tests/unit/desktop-update-manifest.test.ts`、`tests/integration/desktop-update-route.test.ts`。

- [x] RED：真实生成 Ed25519 密钥，断言篡改 payload/签名、错误平台／架构、降级比较、超限均拒绝；接口未登录 401、未发布 404、固定摘要流与取消清理测试在实现前失败。
- [x] GREEN：实现严格 schema／字节签名、数字版本比较、固定目录和非符号链接检查、双并发有界流；测试下载原字节一致且无重定向／缓存。
- [x] 验证：聚焦 Vitest unit/integration；来源映射、取消、请求 abort、并发释放与损坏文件拒绝。
- [x] checkpoint：协议与Windows／Android接口共52测试通过，定向ESLint通过；按偏好不单独提交。

## Task 3：网页更新交互与安装保护

**Files:** 见网页 agent 所有权；测试 `tests/unit/desktop-updater.test.ts`、`tests/e2e/desktop-update.spec.ts`。

- [x] RED：先断言 Windows 桥版本识别、下载后必须再次安装、未知／忙碌阻断、导航和身份变化取消、普通浏览器隐藏；已有 Android 不改变。
- [x] GREEN：基于现有 BottomSheet 和侧栏样式实现检查／下载／取消／安装，15 分钟自动检查；补齐导出与加密忙碌信号及准备安装期间提交锁。
- [x] 验证：单测和桥模拟 e2e；同时真实 Electron 交互验证主框架 IPC，不能只用浏览器模拟桥替代原生验收。
- [x] checkpoint：网页更新最终 9/9 e2e、相关 unit 46/46；真实 Next.js 与 Electron 已核验入口、下载和安装准备握手，不单独提交。

## Task 4：原生窗口、权限和更新状态机

**Files:** `desktop/src/main.mjs`、`preload.cjs`、`policy.mjs`、`updater.mjs`、本地页面和文案；`desktop/tests/`。

- [x] RED：策略测试覆盖恶意 URL、iframe／旧代次 IPC、权限默认拒绝；更新器真实签名 fixture 测试错误摘要／会话变更、取消、超限、忙碌和未确认均不执行安装。
- [x] GREEN：沙箱 WebContentsView、固定 profile／单实例、受限下载及权限、本地失败重试页面；更新原 Cookie 固定和有界缓存，主进程确认后重新握手／鉴权／验包，再启动固定安装器并退出。
- [x] 验证：`node --test desktop/tests/*.test.mjs`；实际 Electron 运行验证持久 Cookie、IndexedDB CryptoKey、主框架桥、拒绝外站、加载失败和保存能力。
- [x] checkpoint：最终原生 19/19；最终源码桥验证 `tmp/windows-validation-zMAMUe/evidence.json` 通过，不单独提交。

## Task 5：签名、构建、NSIS 与私有发布

**Files:** 见打包 agent 所有权；根脚本、`.env.desktop.example`、`.gitignore`、`.dockerignore`、`compose.yml`、README 由主 agent 整合。

- [x] RED：工具测试断言 origin 格式、私钥不可覆盖、发布源必须为干净已推送 master、同版本换包／降级拒绝、原子发布失败保留旧产物。
- [x] GREEN：独立 npm lock、固定 appId、用户级 NSIS 安装及卸载保留资料；正常退出等待有界且不强杀；私有构建配置、签名备份、构建记录和只读发布目录。
- [x] 验证：真实生成隔离两版安装包并安装／升级；核对实际版本、快捷入口、Cookie／Web Crypto 和 UUID 恢复，安装取消和运行中不强杀。正式产物另从干净已推送 master 构建。
- [x] checkpoint：最终目标安装包源码摘要与当前原生源码一致，实际 NSIS 生命周期通过；证据保存在私有的 Windows 生命周期验证报告中，不单独提交。

## Task 6：整合、安全与发布

- [x] 根版本与所有锁文件同步递增 feature 版本；整合 Compose 只读目录和 Docker 排除，保持生产 loopback 端口。
- [x] 运行 `npm run lint`、`npm run test:unit`、`npm run test:integration`、`npm run test:e2e`、桌面检查／构建及原生测试；依据实际影响检查配置和依赖审计。全量单次失败及最终复核分别记录，不宣称单次全量全绿。
- [x] 用 `skills/billboard-security-review/SKILL.md` 审查最终 diff，记录 Findings、Verification、Residual Risk；任何必需验证缺失均不宣称完成。
- [ ] 刷新 origin/master、检查仅本任务内容、按 Git 偏好单一版本化中文提交；rebase 后安全 fast-forward master，推送并核对远端 SHA。
- [ ] 从已验证／已推送干净 master 运行生产脚本，健康检查；构建正式私有安装包与更新发布并核验来源，不 seed。
- [ ] 更新本计划验收证据、复核 Wiki；Git finalize 后仅清理本任务已合并干净 worktree／分支。若真实不可替代条件缺失，保留工作和精确证据，并说明最小缺口。

## 验证记录

- 输入：用户 2026-10-23 批准 spec；先前正式 review-spec 为 0/0/0，但不代替本次应用验证。
- Node.js 22.23.4：官方下载并对照 SHASUMS256 验证，安装到用户私有工具目录；Turbopack 拒绝跨 worktree 依赖链接后，已改为 worktree 独立 `npm ci`，不影响主工作区依赖。
- 服务端：协议24项RED后GREEN；Windows接口17项与既有Android接口回归，合计52/52。定向ESLint通过。
- 原生策略及更新器：原始 17 项先验证功能缺失 RED，后追加两项取消竞态，现 19/19 GREEN；真实 Windows 桥与安装生命周期另行核验。
- 网页：聚焦 e2e 最终 9/9，安全快照补齐后聚焦 unit 46/46；既有加密取消与披露断言保持通过。丢弃首个检查命令后会重试，原生回执后 15 分钟限制保持有效；最终产品源码的 ESLint 与 TypeScript 通过。
- 完整单元回归：`npm run test:unit -- --maxWorkers=2`，120 文件通过、1117 项通过／2 项既有跳过；`npm run lint` 通过。
- 依赖审计发现现有 Next.js 16.3.8 受官方 Server Actions DoS 等公告影响；新增更新服务沿用该运行时，已同步升级 Next.js／eslint-config-next 至 16.4.2，保留无关 optional 平台约束。升级后生产依赖 audit 为 0；全依赖仍有开发工具链 braces 引用的 5 项 high，当前上游无修复版，不采用破坏性降级消警。
- 原生：实际 Electron 主框架桥、TLS 拒绝、Cookie／非导出 CryptoKey／UUID 重启恢复、签名及摘要损坏、原会话撤销、忙碌及取消均已运行通过。
- 原生追加：有效旧文档定时器探针在冻结旧版本触发安装确认、最终版本拒绝（有效 RED→GREEN）；新增私有 IPC 代次、加载完成门槛、有界初始队列，以及取消导航／附件／同文档恢复。早期使用 `executeJavaScript` 的延后注入不能证明旧文档，已作废并用文档 nonce 与主进程加载事件核验新证据。
- 取消竞态：最后 Cookie await 期间取消的安装、下载探针先 0/2 RED，修复 await 前后及最终副作用检查后 2/2 GREEN；原生合计 19/19。新增／恢复文件在取消后仍归清理责任，不发布 ready 或启动安装器。
- 完整集成：首轮 948/949，唯一失败是 seed 检查未获得 `DATABASE_URL`；补齐明确开发库环境后完整重跑，64 文件、949/949 通过。
- 容器：隔离 `billboard:desktop-validation` 生产构建及 TypeScript 通过；仅公开桌面工具声明供构建类型检查，实际 runner 镜像不含 desktop、ops/desktop 或私有配置。`npx tsc --noEmit`、最终源码 lint 通过。
- Windows：当前环境为 Windows 11 Pro 10.0.26200 x64。真实 NSIS 0.0.1 → 0.0.2，入口／卸载登记正确；运行中升级返回 2 且原 PID、版本保持。覆盖及普通卸载重装后 Cookie、非导出 CryptoKey 和 UUID 可恢复；仅测试独立 validation 产品。最终只读状态重同步增量的桥及目标 NSIS 已补验通过，目标摘要与最终原生源码一致。
- 启动：开发验证期间曾出现一次无 BrowserWindow 的 Error 框；随后的 20＋32 次独立资料启动与完整桥验证均通过，没有捕获启动 catch 标签。原因未确定，不将 whoami 时序假说写成已证实或已修复。
- 完整端到端：首轮 166 通过、1 项既有跳过、1 项加密重启用例超时。该用例保留全部断言及 `response.finished()`，只增加诊断步骤后 1＋3 次均通过；未复现，不通过放宽超时或删除等待消警。最终状态重连行为另做聚焦回归。
- 实际 Next.js 与 Electron 联调曾复现初始消息跨页面代次被拒绝，导致更新入口缺失；保留安全门槛，补每代只读状态重同步与未确认检查重试，已完成真实业务验收。
- 真实网页最终证据 `tmp/windows-web-validation-3F1ukA/evidence.json`：登录、记账／编辑／家庭范围、XLSX 导入、Excel 保存回读、签名更新下载与原生准备握手、三种加密备份保存回读均通过。关闭前原 UUID 的受保护 pending 为密文；重启首页真实 query action 使用同 UUID、区别于 submit 且不含原输入，查询 200 后 pending 从 1 清为 0，账务没有重复；原会话及到期时间不变，随后撤销仍拒绝登录。
- 最终原生源码 SHA-256 为 `317122f72e63ce303d37931d9fec02e5307acf8d7caeac29d837bbf466443ffa`；网页源码为 `5613054a4d6d7d720499c341ecedb51cb78f927fbc22ad0b79f7e908c86f3d3d`。真实联调运行前后摘要一致。
- 既有私有 HTTPS 登录预检 200、TLS 有效，实际入口 microphone／camera 均为 self；未在日志或文档写入入口。
- 签名：正式 Ed25519 密钥已在仓库外创建，当前用户／SYSTEM 私有 ACL；另处私有备份回读公钥指纹一致。备份仍在同一物理磁盘，不作为异地灾备证据。
- 设备：本机未检测到音频输入和摄像头；记录无设备回退，真实采集质量保持未验证，不用合成音频替代质量验收。
- 当前实施状态：实施、适用软件验证及安全审查完成。以下 Git／服务／正式私有产物手续在提交后执行，实际结果以验收记录为准；不把提交前记录当成已发布证据。

## 安全审查

### Findings

- 无新增待修阻塞项。审查中发现的 Cookie await 取消竞态和旧文档调用边界已修复，并有独立 RED→GREEN 证据。
- 最后状态重同步与自动检查重试未增加权限：内部 status 继续附私有代次，仅返回原生状态；导航、身份、前台、业务准备和最终安装确认门槛保持有效。

### Verification

- 复用签名协议、认证分发、原生桥及安装器的实际审查与验证；取消竞态 2/2、原生测试 19/19、网页更新 9/9 通过。
- 生产依赖与独立桌面依赖 audit 均为 0；开发工具链未修复公告单独列为残余风险。
- 待提交文件与私有配置中的 16 个真实值／入口标识逐字对比，匹配数为 0；真实配置、密钥和产物均未进入待提交内容。

### Residual Risk

- 开发依赖仍有 braces 引用链的 5 项 high，上游尚无修复版；未通过破坏性降级消警，正式运行依赖与桌面工具独立审计无漏洞。
- 未取得麦克风或摄像头硬件采集质量证据；原生文件测试由驱动选定输入／保存路径，不能代替人工操作系统对话框的体验验收。
- 单次启动 Error 框和全量 e2e 的单次加密重启超时均未复现；后续有界启动与原断言复核通过，不宣称已确定原因。
- 签名备份位于同一物理磁盘，不能作为异地灾备；安装包没有 Windows 受信发布者证书。

## 提交后验收记录

本文件冻结提交前的实施与验证证据。提交、推送、生产健康与正式私有产物的实际结果写入未跟踪的 `tmp/desktop-verification/2026-10-23/receipt.json`，并以 `sourceCommit`、实际远端 SHA、产物摘要及生产版本相互核对，避免为回写发布结果引入第二个改变构建来源的提交。
