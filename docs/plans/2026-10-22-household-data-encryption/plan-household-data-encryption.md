# 家庭可选账务加密 Implementation Plan

> **For agentic workers:** REQUIRED SKILL: Use implement to execute this plan task-by-task. Respect the handed-off git_state: inherit prepared, otherwise prepare; use git-workflow for checkpoint/finalize. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付家庭可选加密、独立换钥及完整恢复能力，同时保持现有账务、身份、导入与处理任务语义。

**Scope Source:** `docs/scope/2026-10-22-household-data-encryption.md`，用户于 2026-10-22 批准。

**Release Authorization:** 用户于 2026-10-22 明确要求“先提交推送和上线”。沿用已批准范围与完整自动化验证，立即完成 Git／发布；F1 实际转发日志和 F2 Android 真机仍为未验证发现项，延后补证，不标记完整安全验收通过。本次部署保持家庭默认未加密，不自动执行生产家庭转换或旧副本删除。

**Architecture:** 物理 Prisma client 保留授权及同家庭约束；统一请求上下文和财务访问适配器在加密模式下分块解密、执行原查询语义并密文写入。模式转换使用隔离目标、家庭屏障、原子回执及独立恢复包；客户端仅通过正文 POST 提供密钥，初始 SSR 不读取加密账务。财务 raw SQL 显式增加加密路径，不能把占位列当业务值。

**Tech Stack:** Next.js 16.3、React 19.2、Prisma 6.19、PostgreSQL 17、Web Crypto、IndexedDB、Android Keystore、Vitest、Playwright。

**Verification:** `npm run lint`、`npm run test:unit`、`npm run test:integration`、`npm run test:e2e`，补充 Android、容量、合成迁移／跨版本恢复和实际运行边界核验。

---

## 执行与所有权

- 沿用 `feature-household-data-encryption` 及其 worktree，初始只有本任务 spec，无其他修改。主 agent 统一 schema、请求上下文、访问适配器、转换服务、计划和 Git 收尾；子 agent 仅处理明确分配的密码模块、财务 raw SQL 接入和客户端运输／界面文件。
- 当前 Git 偏好要求 spec 与实现归入一个 feature 提交；每个 checkpoint 记录验证证据，完成全验收前不创建阶段提交。版本从 1.55.3 按 feature 递增；最终重读远端基线后确定并同步根版本。
- 所有开发及破坏性测试只使用开发／测试数据库；生产不 seed，不自动开启家庭加密，不进行未经具体清单授权的旧副本删除。
- 初始 `npm ci`、`prisma generate` 已成功；开发 PostgreSQL 17 健康。已阅读安装版本 Next.js 的 data-security、fetching-data、server-actions 指南。

## Task 1：批准记录与 Wiki 基线

**Files:** 本 spec；`docs/wiki/household-encryption.md`、`households-and-ledgers.md`、`android-app.md`、`wiki.md`。

**Acceptance:** 稳定的家庭模式、持钥、恢复和 OPS 边界可被检索；既有页面链接指向同一权威说明，不把尚未完成的设备／运行验证写成已通过。

- [x] 记录用户批准，spec 状态为已批准 2026-10-22。
- [x] 核对 inherited prepared Git 上下文、文件所有权与已确认 Wiki 目标。
- [x] 写入已批准约定并同步索引、家庭及 Android 页面；所有 Wiki 第一行为摘要。
- [x] verify：原目标及来源路径已读取确认，新页面相对链接均指向现有目标；全文无私有入口／凭据，源 spec 状态一致；checkpoint 按偏好不单独提交。

## Task 2：密码与按请求上下文基础

**Files:** `src/lib/encryption/crypto.ts`、`codec.ts`、`types.ts`、`request-context.ts`、`request.ts`；`tests/unit/encryption-crypto.test.ts`、`encryption-context.test.ts`。

**Acceptance:** 无客户端材料不能解密加密家庭；每次调用独立，篡改或串换拒绝，旧码不打开新包，新码和独立恢复包能打开获准历史。

- [x] RED：真实 round trip 需要不存在的密码接口；并发上下文测试断言 A 请求结束后 B／全局无法取得 ring，超时／失败必须失效。
- [x] 实现 `HouseholdCode`、`KeyRing`、版本化 BBK1／BBR1／BBP1／BBE1 格式；256-bit 随机值、AES-GCM、HKDF 用途隔离、逐修订内容密钥和完整 AAD。恢复包仅包含历代包封密钥，不保留旧主密钥。
- [x] 实现 `EncryptionInput { code: string; revision: number }`、安全状态 DTO 及 Node AsyncLocalStorage。`getEncryptionContext()`／`isEncryptedRequest()` 只返回当前仍有效执行范围；回调结束清理可控材料，禁止 session／全局密钥池。
- [x] `withHouseholdEncryption(input, work)` 每次从有效 AppSession 核验身份、家庭配置与代次，打开 key ring 后执行；未加密请求不要求码，转换屏障阻止新写任务。
- [x] GREEN：运行上述两个 unit 文件，覆盖错误码／家庭／周期／版本、标签与 nonce 篡改、角色／期限、20 MiB 以上及实体 32 MiB 限额；记录实际 RED/GREEN 输出。

## Task 3：物理 schema、财务访问与查询语义

**Files:** `prisma/schema.prisma`、`prisma/migrations/20261024000000_household_encryption/migration.sql`、`src/lib/db.ts`、`src/lib/encryption/database.ts`、`protected-models.ts`、`query.ts`；`tests/unit/encryption-query.test.ts`、`tests/integration/encryption-storage.test.ts`。

**Acceptance:** 所有受保护字段只在 payload 内保存；授权 ID／组合约束保持，查找、关系、排序、分页、幂等和批量更新与明文基线一致。

- [x] RED：合成家庭写入金额、日期、备注、来源、映射、无效草稿 raw 值及旧结果，原始物理查询断言不存在金丝雀明文；原有实现应不满足。
- [x] 新增家庭模式／代次／密钥包、操作回执与隔离转换目标；各受保护实体新增可版本化密文载荷。原家庭默认为 UNENCRYPTED，不在 migrate deploy 中转换或改动会话授权。
- [x] 保留物理 client；适配器按可信家庭范围查询，分块打开 payload、在内存处理财务谓词，最后投影和分页。以合法固定占位值兼容原非空列，实际分类关联只在 payload；按解密 categoryId 批量重建关系。占位列永不用于财务判断。
- [x] 实现已使用的 findUnique／findFirst／findMany、create／createMany／createManyAndReturn、update／updateMany／updateManyAndReturn、upsert、count／aggregate／groupBy 及必要 delete 路径；嵌套 ImportDraft.rows 和关系 select/include 保持。
- [x] `$transaction(callback)` 传播同连接适配器；财务数组事务改 callback。未知财务操作或未适配 raw SQL 明确拒绝，不能退回占位值计算；资源／授权 ID 锁 SQL 保留。
- [x] 批量加密更新在事务内批量读、分块写，不能每行查询；配置行与家庭优先锁序复核模式、代次及版本，防止迟到写入。
- [x] GREEN：金额／日期／分类／备注过滤、OR／NOT、数组 hasSome、排序分页、软删除去重、映射唯一键、事务回滚、冷启动缺钥及跨家庭测试通过；与原值精确比较，不以浮点金额验收。

## Task 4：家庭开关、独立换钥及灾备

**Files:** `src/lib/encryption/service.ts`、`conversion.ts`、`recovery.ts`；`src/app/api/household/encryption/route.ts`；`tests/integration/encryption-lifecycle.test.ts`、`encryption-recovery.test.ts`。

**Acceptance:** 四态模式可确定收敛，原 UUID、历史数据及权限不变；未知结果不生成新候选，旧请求不因重登录续权。

- [x] RED：普通成员不能切换；关闭缺码拒绝；候选未备份／摘要不符不发布；丢响应查询原回执而不是重复激活。
- [x] 负责人 prepare 建立唯一操作／期限和预期配置；开启、关闭、换钥同家庭互斥。批次带原 UUID、模式代次和所需材料；目标隔离、源完整只读，资源任务收敛后取得源基线。
- [x] 全部实体及 AppEvent 逐批双向转换，保留原 ID／原值；留存清理与转换协调。只在源修订、原会话和全量核验通过后原子发布目标及回执，明确失败时阻止迟到批次后解除屏障。
- [x] 独立换钥只重封历史 key ring 并新增包封版本，保持 ENCRYPTED；历史恢复包覆盖旧周期，首次／再次开启不复用周期或主密钥。
- [x] 灾备包和清单记录家庭、周期、版本覆盖与摘要；旧明文快照不能直接降级当前已加密家庭，关闭期保留最近可用码和包。
- [x] GREEN：响应丢失／崩溃／期限／撤销／换负责人并发、取消、中断续作、关闭明文目标披露、备份后换钥且丢在线库／客户端缓存的空目标恢复、多家庭错误材料均获得实际证据。

## Task 5：客户端正文运输、密钥管理及 Android

**Files:** `src/lib/encryption/client-store.ts`、`client.ts`、`src/components/encryption-provider.tsx`、`encryption-gate.tsx`、`encryption-settings.tsx`；`src/app/(app)/layout.tsx` 及六个财务 page、对应纯视图／loader；`src/app/api/household/view/route.ts`；现有表单、NaturalLanguageProvider、导入面板及账本管理调用点；`src/lib/i18n.ts`；Android 主 Activity 与新 Keystore 窄桥及其测试。

**Acceptance:** 无个人密码／设备审批；可信设备记住，初始 SSR／DOM／URL／headers 不含码；已有后台任务期间仍可切页。

- [x] RED：浏览器存储／恢复、身份隔离、到期与退出、FormData/JSON 携钥、旧响应不复活现场及 Android origin/mainFrame 限制测试。
- [x] 封闭页面枚举和受限参数，财务 DTO 由现有查询区统一加载。未加密 SSR 与加密 POST 共用 loader/纯 view；初始加密页及 layout 只输出加载壳。不得使用私有 Flight decoder，也不假定 action 的 ALS 会覆盖后续 RSC 渲染。
- [x] 保留已验证 eager-render 仅作技术证据；正式页面读取优先 POST DTO，避免 Next Server Actions 串行队列阻塞长 AI／导入任务期间的切页。所有财务读取必须在受控 callback 完成，不在返回树延迟取密钥。
- [x] 浏览器 IndexedDB 使用不可导出的本机 AES key 保护按原身份隔离的家庭码与草稿；内存镜像供运行期读取。显式退出／身份结束清理；同身份到期保留受保护码包及待确认 UUID，不自动重发。
- [x] 现有 form action/useActionState、直接结构输入和 fetch 仅在执行时向正文附加 encryption，服务端先剥离再传业务／Agent。新增原生 form wrapper，不用 hidden input、bound 参数、URL 或 Cookie 携钥。
- [x] 家庭管理页提供开启、关闭、备份回读、状态查询、独立换钥及手工／本机二维码导入；中英文文案同步。发布前从实际备份副本核验候选，存储不可用时需独立恢复副本。
- [x] Android Keystore 包保存于应用私有存储，桥复用同源主框架校验；移除启动时整个 WebStorage 的清空，保留受保护草稿／原 UUID；显式退出定向清理，HTTP 缓存和 TLS 清理保留。二维码权限仅可信同源按需请求，拒绝可粘贴。
- [x] GREEN：浏览器端到端、弱网／长任务切页、QR 权限拒绝、不同身份重登、Android unit/config/build检查分别记录；最后全量e2e为162 PASS／1原有可选性能SKIP。
- [ ] GREEN：Android真机持钥／重开／原UUID／身份结束及QR检查；已准备隔离debug instrumentation和runbook，尚无设备，不把编译或浏览器等同真机证据。

## Task 6：现有财务路径与 OPS 适配

**Files:** `src/lib/reports/query-home-report.ts`、`query-report-analytics.ts`、`src/lib/transactions/query-category-preferences.ts`；`src/lib/imports/drafts.ts`、`category-mapping-rules.ts`、`cmb-refund-history.ts`；`src/lib/exports/service.ts`、`temp-file.ts`；现有 actions／records search、voice entry/transcribe routes；`src/lib/ops/event-metadata.ts`、`record-event.ts`、`dashboard.ts`；相关集成／端到端测试。

**Acceptance:** 两种模式结果与原业务基线相同，无遗漏 raw SQL、日志、Agent 或临时文件明文旁路。

- [x] RED：报表上海区间、精确中位数／Top5、金额桶、来源去重与退款、映射 CAS、20k 批量导入及100k导出、AppEvent 原业务值物理扫描。
- [x] 加密报表显式同快照扫描后复用 aggregateHomeReport/buildReportAnalytics；原 SQL 仅未加密路径使用。列表总数与筛选、归档／历史成员及搜索令牌绑定一致，不提前分页或将旧 AUTH_SECRET 令牌变成明文旁路。
- [x] 替换加密分支的 Transaction INSERT…RETURNING fingerprint、映射复合键 upsert/CAS；原 source 从解密路径读取，锁 SQL 只取授权 ID／状态。保留分块、唯一冲突及单调 updatedAt。
- [x] 导出仍一致快照、授权领取、私有有界加密临时文件；语音 multipart 正文携钥，供应商音频路径不携钥，GET 结果兼容仅未加密。
- [x] AppEvent 原 summary／metadata 加密、明文白名单、OPS 通用摘要与行数统计、迟到事件最小记录及90天留存协调；OpsAuditLog／LedgerAuditLog 的既有安全用途不改变。
- [x] GREEN：针对性现有回归加新模式对照；供应商桩检查没有家庭码或历史批量数据；已提交 UUID 与旧摘要不重算。

## Task 7：维护工具、全量验收及 Git／发布

**Files:** `ops/encryption/` 专用合成转换／核验工具、`docs/runbooks/household-encryption.md`、必要 README 引用、计划证据；最终根版本字段。

- [x] 实现空隔离目标恢复、全表原字段与分组摘要核验、恢复点清单检查、源卷／WAL／备份处置清单；默认只检查，不删除真实副本，不 seed 生产。
- [ ] spec 验收1–9由 Task4/5 的默认模式、权限、双向转换、并发、旧客户端、再次开启和跨模式恢复证明；10–21由 Task2/4/5 的持钥、身份、换钥、失败恢复及丢钥规则证明。
- [ ] spec 验收22–25由 Task3/6 的物理金丝雀、AppEvent 存量及迟到事件／OPS 证明；26–32由 Task3/6 的篡改、UUID、列表报表、导入、导出、供应商和容量证明；33–40由 Task4/7 的旧库、缺失材料、物理切换、跨版灾备、回退和运行边界及交付记录证明。实施时按实际验收顺序复核映射，不遗漏任何一项。
- [x] 按 AGENTS 执行完整 lint/unit/integration/e2e；运行 Android unit/config/build、容量、合成迁移／灾备及配置检查。每项记录 pass/fail/未具备证据，不因部分通过降低要求。
- [x] 使用 `skills/billboard-security-review/SKILL.md` 审查实际最终 diff，输出 Findings、Verification、Residual Risk；未把F1／F2缺证据写成通过。
- [ ] 补齐实际HTTPS／转发日志及Android真机证据，解除F1／F2后通过完整安全验收。
- [x] 同步 Wiki 实际知识，核对任务所有权、根版本、敏感值与链接；刷新远端并核验远端 master 与本地一致。
- [ ] 按用户本次明确发布授权创建目标一致的feature提交，rebase并fast-forward master，仅推送master，核对远端SHA；F1／F2继续如实保留，实际结果以Git及发布记录为准。
- [ ] 发布输入为已验证已推送提交；普通部署只升级默认未加密模式，不执行生产账务转换。运行既有 Windows Docker 生产入口，核验健康及登录页；需要 APK 更新则按私有分发约定生成及核验。
- [x] 前次收尾因真实设备／外部日志证据缺失而保留工作；用户随后明确要求先提交推送和上线，本次据此恢复finalize。已完成其余独立验证，仍不把未验证项目写为通过。

## 验证记录

- 已取得密码基础初始 RED：缺失密码模块导致行为断言失败，退出码1；生产模块尚未写入时取得。
- 已完成隔离 Flight 实验：action 内 ALS 不覆盖稍后执行的嵌套 RSC，四组断言通过；正式读取据此采用 POST DTO，避免隐含上下文延续与串行动作队列。
- 基础仓库：1.55.3；正式服务不在本工作树直接构建或重启。
- 密码基础：36 个单测通过，包含独立 Node HKDF/AES-GCM 互操作、实体修订绑定及密文包的非认证元数据解析。上下文与流式响应验证包含真正脱离回调的异步任务，以及取消实际清理结束前不能释放上下文的 RED→GREEN。
- 物理存储：先复现原实现的金额／备注明文金丝雀失败；统一访问层接入后通过。全历史双向转换、独立换钥、当前码及独立包读取旧密文、关闭后新周期开启、原会话／原 UUID／原结果不变已在真实开发库验证。
- 并发与资源：19 个新并发用例及既有资源回归合计31项通过。发现并修复异步校验／发布期间到期，以及跨家庭 TTL 清理提前释放真实工作；新增仅含 token／时间的 ResourceExecution，实际工作及清理结束后才释放，崩溃不以 TTL 猜测已停止。
- 导入／报表：2万条软删除同源历史＋2万行新草稿，新增19998笔并保留两笔原值去重，完成重试／原摘要／退款／分类 CAS／历史成员与归档账本对照通过；SSJ 与微信的真实 XLSX 两模式补测通过。家庭 metadata/id 500条游标扫描只跑一遍，不按每组财务指纹反复解密全家。
- Android：Keystore／桥／摄像头安全边界相关34个 unit、lintDebug、assembleDebug通过；adb实际检查无连接设备，真机验收尚未完成，已向用户请求连接验收手机。
- 浏览器：两例真实流程通过，覆盖备份文件保存回读、默认模式、开启／独立换钥／关闭、正文携钥、初始 HTML 不含账务、原UUID记账、丢prepare/commit响应、过期重登与回执摘要异常、悬挂任务期间POST切页、显式退出清钥。390/768/1440截图已生成，390截图人工核验无横向溢出；后续编辑与六页补充断言待全量 e2e。
- 2026-10-22 首轮全量 integration：863 PASS，31 FAIL；失败涉及旧 mock 请求边界、新存储列对外隐藏、故障注入 Promise 适配、示例 env 预载，以及新增SSJ测试日期。已逐项定点修复，尚不能视为全量通过。完整 unit 在限制两 worker、保持原超时的条件下1046 PASS／2 SKIP；首次高并发下的PDF/大XLSX超时经该配置恢复，未削弱业务限制或断言。
- 2026-10-22 17:34 最终主体 integration：63 files、929/929 PASS，446.67 秒，包含27项转换并发、19项事件、13项独立数据库恢复及7项加密语音／UUID正文入口。命令使用 `node --env-file=.env.example node_modules/vitest/vitest.mjs run --dir tests/integration --no-file-parallelism`；Windows 上 `node --env-file=.env.example --run test:integration` 的子进程未保留 seed 测试所需 env，故改为直接启动同一 Vitest 脚本，未修改断言或超时。
- 2026-10-22 完整 unit：117 files、1065 PASS／2 SKIP，50.63 秒；`npm run lint` PASS。随后仅同源摄像头策略与原生退出／恢复的新增定点检查继续执行；完整 e2e 尚待统一运行，不将前期两个用例代替最终版本。
- 10万行加密导出实际成品5,885,070 bytes，临时密文5,885,104 bytes；本轮生成52.689秒，未修改60秒限制。实际下载并读取全部10万行通过，100001行明确拒绝。生成期采样 RSS 峰值265.61 MiB；测试读取完整 Excel 工作簿后的975.73 MiB及后续过量拒绝阶段1092.63 MiB包含测试持有的完整解码工作簿，不能当作服务端独立生成峰值。测试未打印任何实际账务或密钥。
- 真实旧密文备份已在源数据库实际删除后，仅凭当前码与独立BBP恢复到财务空目标，逐字段／分组比较和最新授权／确认删除检查点通过。默认CLI经 stdin 取得码，使用不可用 DATABASE_URL 仍只读校验成功，无数据库写入。
- 安全复核修复了明文写事务最终时钟、prepare/abort及返回结果PG时钟、事件加密／留存后失效只保留通用行、原UUID查询终态被误设只读、上传前同意校验误读账本名等实际问题，以上已包含主体全量回归。客户端复核闭合启动竞态、未知取消、不可读草稿覆盖、原生旧身份清理失败及提交成功后设备保存失败的恢复语义。
- 已实际只读检查当前正式HTTPS登录页：200、根路径、同源麦克风策略可见；当前旧版本登录响应缺少HSTS、frame protection、nosniff及Referrer-Policy，此为既有入口情况，未扩大本任务改动。Docker公开web只loopback发布、无NODE_OPTIONS／Node report env、实际core limit为0；日志driver为json-file。这些仅是现有运行观测，不证明新版镜像、转发服务日志或供应商历史保留已通过。
- 私有env值仅在进程内与实际diff比对，未发现真实私有凭据／入口值；只输出变量名级命中状态及计数。根版本及lock根字段一致为1.56.0，新增文档相对链接均存在。
- 后续补充：二维码所需同源摄像头政策已同步应用、可选nginx示例和network runbook；真实浏览器权限拒绝／粘贴检查待e2e。加密语音上传的延期扣额新增chargedAt元数据，只在完整有效输入和家庭码验证通过后实际扣额，针对性及最终回归待补齐。
- 2026-10-22 后续定点验证：延期扣额、原资源／语音／同意回归共7 files、113/113 PASS；`ResourceExecution.chargedAt` 迁移已在开发库执行。缺码、错码及非法额外字段不改变各窗口已用量／起始时间，不调用供应商。
- 查询／导出复核修复两项遗漏：独立加密多页读取自动进入 RepeatableRead，关联加载复用该连接；未加密家庭的临时 Excel 也始终从首字节加密。真实503行跨连接提交／关系变更和未加密文件磁盘扫描／实际下载已纳入3 files、36/36 PASS。
- 同组36项还验证声明超大 multipart 在底层 cancel gate 完成前维持未扣额租约，完成后413并释放。普通 WAV 及供应商 HTTP／业务拒绝的异步取消旁路也已闭合，4项真实流 gate 分别 RED→GREEN，相关59项 unit PASS；未改变超时或容量。
- 真实 HTTP 容量：普通随手记原端到端流程使用接近20 MiB的实际 XLSX 通过；新增加密模式上传同等大小文件也通过，检查实际 Content-Length、正文携钥、URL／headers 无码、物理草稿密文及解密后的原字段／来源指纹。测试沿用原解析预算，未以单元桩替代上传。
- 首轮全量 e2e 为99 PASS、60 FAIL、3未运行。实际 DOM 证实未加密 Provider 的延迟初始化打断流式 hydration，产生短暂重复表单；已恢复同步无钥 runtime 和纯视图原 SSR 边界，未改旧选择器或删除框架 DOM。普通支出／收入／映射／首页下钻4/4 PASS，加密流程3/3 PASS；最后本机提升完成时序微调获行为 unit RED→GREEN，聚焦14/14 PASS，待统一全量覆盖。
- 本轮完整 unit 为118 files、1074 PASS／2 SKIP，51.10秒；lint PASS。随后新增供应商响应取消两项和跨模式恢复完善，将在源代码冻结后执行最终回归。私有env中15项真实值只在进程内比对，diff无命中；三处根版本一致为1.56.0。
- 跨模式恢复补齐后，真实两数据库19/19 PASS，独立执行 `verify-recovery.mts --synthetic` 亦通过；加密源到已明确未加密目标不依赖在线 ring，明文源／目标均未加密时无需材料。最新授权／删除检查点、原 UUID／全字段及目标模式保持；错误历史包虽能解密源但与最近目标包不符仍拒绝。
- 最后携钥 route 取消复核新增9项真实 body gate，RED为8 FAIL／1 PASS；缓存并等待首次取消及声明超限清理后9/9 PASS，连同共享正文与语音取消共17/17 PASS。保持三个入口原有超时、容量及错误状态。
- 冻结应用代码后的完整 lint PASS；完整 unit 为119 files、1085 PASS／2 SKIP，54.22秒。Android 完整 `android:check` PASS（lint、34项JVM测试、debug及instrumentation APK构建），46秒；未连接真机，不把构建等同设备验收。最终 integration／e2e／build 正在执行。
- 恢复补充测试首轮GREEN曾出现17 PASS、2条成功用例在组合checkpoint guard返回RECOVERY_FOUNDATION。拆为相同语义的家庭／授权摘要／时间检查仅改善定位，不是已证实修复；原输出未保留分项值，根因未明。随后两项定点、完整19项及独立CLI均未再复现；最终全量继续检查该项，不将重复通过描述为已修根因。
- 2026-10-22 18:31–18:38 最终后端 integration：64 files、949/949 PASS，439.36秒；包含本次全部取消、延期扣额、RR关系快照、两模式临时文件和19项跨模式恢复。先前checkpoint拒绝未再复现，原因仍未查明，保留为诊断限制。十万行本轮生成51.462秒，成品5,885,280／密文5,885,314 bytes，实际下载519ms、完整读取2391ms；生成期RSS峰值260.04MiB。末轮全量e2e／构建及收起恢复码清理后的UI单测待完成。
- 收起恢复码清理：当前Next未开启cacheComponents，实际路由树不额外保留家庭设置页；但原生details关闭会保留children。新增3项行为unit先全部RED，改为仅展开挂载、收起清码后GREEN；文件引用／候选／UUID保留。最后完整lint PASS、unit 120 files／1088 PASS／2 SKIP（50.45秒），TS静态检查PASS；全量163项e2e加入真实details清理及显示码后SPA导航DOM检查，正在执行。该改动仅客户端展示，不改变已通过的后端集成路径。
- 首轮163项最终e2e为161 PASS、1原有条件SKIP、1 FAIL：新的家庭模式status与原邀请表单status是两个不同的合法元素，原账号测试使用全页单元素定位而冲突。仅将该断言限定到邀请表单，保留原邮件文案和全部身份／历史金额断言；完整移除／重新邀请／转让／退出流程定点PASS（12.2秒）。未改产品实现或削弱断言，正在重跑完整163项。
- 真机准备新增 `HouseholdKeyDeviceTest` 5项instrumentation：先核验isolated debug包／可调试／合成origin，随后真实Keystore非导出、身份及clear、Activity重建／重开和真实桥来源限制。只操作本次随机身份，复用已有WebView夹具，不新增生产接口。`android:check` 再次PASS（38秒），新类已编译进测试APK；未安装或运行设备，实际结果仍为未验证。执行步骤见runbook。
- 最后全量 `npm run test:e2e` 退出0，41 files、162 PASS／1原有条件SKIP，9.6分钟；原有SKIP为需显式 `WEAK_NETWORK_PRODUCTION_PERF=1` 的生产性能项，未增skip或削弱断言。最后Next 16.3.8生产构建PASS，编译3.2秒、TypeScript10.8秒。以同一standalone产物和随机临时AUTH_SECRET在自有随机loopback端口实际启动，登录页200、中文表单及camera/microphone同源策略PASS，进程已关闭；不把本机HTTP smoke称为正式HTTPS验收。
- 最终Git收尾：179个任务文件，无无关／已stage内容；master工作树干净且本地 master、origin/master 与远端一致。`next-env.d.ts`已由最终build恢复，无本次差异。未创建提交、未合并／推送、未生产重启；feature worktree与全部成果保留，结果为blocked。最终adb仍无设备，F1实际配置证据亦未收到。

## 验收对照

编号按 spec 验收条目顺序。下表区分本地可重复证据与真实设备／运行条件，不能把合成演练当作生产转换或发布完成。

| 编号 | 当前结果 | 证据 |
| --- | --- | --- |
| 1 | 本地通过 | 默认配置迁移、storage／lifecycle，以及普通记账浏览器回归；原会话不重建。 |
| 2 | 本地通过 | lifecycle／concurrency 的负责人、原身份、OPS及伪造材料拒绝。 |
| 3 | 本地通过 | lifecycle／imports-reports／events 原字段及分组核验；浏览器先实际备份回读再开启。 |
| 4 | 本地通过 | 错码、确认、关闭隔离目标及双向原值对照。 |
| 5 | 本地通过 | 27项 concurrency、延期资源、跨页快照、原任务与领取屏障。 |
| 6 | 本地通过 | concurrency、浏览器丢响应／原会话到期／原UUID恢复及取消终态。 |
| 7 | 本地通过 | 模式代次最终复核、旧格式／跨账本UUID与不可读草稿保护。 |
| 8 | 本地通过 | lifecycle 新周期／历史包验证；日常未加密不携钥；客户端候选恢复。 |
| 9 | 本地通过 | recovery 的两种源与两种目标、最近材料／检查点；runbook 披露中止关闭明文副本。 |
| 10 | 本地通过；真机待验 | 浏览器负责人生成／成员导入、角色拒绝；Android bridge／store 单测。 |
| 11 | 本地通过 | storage／page-entry 冷启动缺钥与账号自助、混合家庭测试。 |
| 12 | 本地通过 | context／concurrency／deferred-resource，以及错误码不扣额的真实上传入口。 |
| 13 | 本地通过 | context／response、正文和供应商真实取消 gate、ResourceExecution 实际占用。 |
| 14 | 本地通过 | session／identity／processing 回归与最终PG时钟／租约复核竞态。 |
| 15 | 部分通过；真机待验 | 浏览器进程重开及同身份重登录恢复原UUID、退出清理；Android仅34项JVM及构建。 |
| 16 | 本地通过；运行边界待验 | 浏览器请求／初始HTML／受保护存储检查、摄像头拒绝后粘贴；实际转发日志见39。 |
| 17 | 本地通过 | 独立换钥、旧请求拒绝、历史值和新版本存储；始终ENCRYPTED。 |
| 18 | 本地通过 | settings／client-recovery／browser-storage 的独立文件回读、保存失败及仅会话模式。 |
| 19 | 本地通过 | 原UUID丢响应、异常回执、持久候选、原会话终止及晚请求拒绝。 |
| 20 | 本地通过 | 身份回归及隐私文案；退出不触发自动家庭换钥。 |
| 21 | 本地通过 | 冷启动及错材料拒绝；未新增OPS、改密、邀请代解锁路径。 |
| 22 | 本地通过；旧物理副本未处置 | storage／events 物理金丝雀及独立备份认证；副本清单另行维护。 |
| 23 | 本地通过 | 19项 events 与双向转换，原summary／完整metadata／时间／归属保持，留存不复活。 |
| 24 | 本地通过 | 事件跨时钟／代次／屏障迟到只保留通用行，原业务成功结果不变。 |
| 25 | 本地通过 | OPS 允许列／通用标签／事件行数及既有安全审计回归。 |
| 26 | 本地通过 | 36项密码测试、独立Node互操作及上下文／密文关联篡改拒绝。 |
| 27 | 本地通过 | query-semantics／voice-transport／imports-reports、浏览器原UUID跨页／重开。 |
| 28 | 本地通过 | 明文基线对照、503行跨页筛选及并发快照，历史成员／归档／上海时间精确保持。 |
| 29 | 本地通过 | 四来源parser及导入回归、2万行批量确认／软删去重／退款；两模式真实XLSX上传。 |
| 30 | 本地通过 | record-export真实文件／内容／权限边界／异常清理，以及两模式临时文件加密。 |
| 31 | 本地通过；外部日志待验 | provider桩最小输入、语音转写／原UUID／同意和租约回归；实际日志见39。 |
| 32 | 本地通过 | 两模式近20MiB真实HTTP上传、2万行、10万行实际下载／全字段读取及100001行拒绝。 |
| 33 | 本地通过 | storage／lifecycle 全历史及会话状态；真实隔离数据库原样迁移与恢复。 |
| 34 | 本地通过 | 错材料、家庭关闭、负责人及历史引用异常拒绝；其他家庭未借钥。 |
| 35 | 合成演练通过；正式物理替换未执行 | 两个新PostgreSQL17数据库及原始迁移、全字段比较；普通部署不执行具体生产卷替换。 |
| 36 | 本地通过 | 源数据库实际删除，旧码／ring清空，仅当前码＋独立BBP恢复旧周期全部财务字段。 |
| 37 | 本地通过 | 缺包／损坏／错用途／跨家庭／缺历史版本／非可信摘要拒绝，空目标无部分写入。 |
| 38 | 本地通过 | 非空目标拒绝、最新撤销／停用／删除检查点不被旧快照覆盖；runbook要求保全新写入。 |
| 39 | 未验证，用户授权延后补证 | 实际TLS终止／转发日志未取得可核验证据；有限运行观测不能替代实际日志配置。 |
| 40 | 本地自动化通过；已授权执行Git／发布 | lint、1088项unit、949项integration、162项e2e、build／本地启动及Android构建通过；原有skip保留。用户要求先上线，F1／F2不作通过声明，实际提交／部署结果另行记录。 |

## 最终安全审查

### Findings

- **P2／F1，运行边界缺证据，用户授权上线后补证**：实际 HTTPS 终止／转发服务的请求正文、音频能力 URL／查询串、追踪和日志采集配置尚不可核验。应用不记录参数、no-store、示例nginx和服务200不能证明外部不会持久化解密材料。对应spec“整体方案”及验收39，仍须取得实际配置和必要的私有边界验证；不把缺证据改写为通过。
- **P2／F2，真机验收缺失、阻止完整交付**：新Keystore／桥仅有34项JVM及APK编译证据，新增5项真实Android instrumentation尚未执行；未连接验收手机。对应spec验收15／16／40，须按runbook在隔离debug包及私有合成前端验证重开、原UUID、身份结束及QR权限。浏览器、编译或模拟器均不能替代规定真机证据。

### Verification

- 完整 `npm run lint` PASS；最终UI收起清理后unit 120 files、1088 PASS／2原有SKIP；完整后端integration 64 files、949/949 PASS。
- 两模式近20MiB真实HTTP上传、2万行导入、10万行真实成品下载／全字段比较、19项独立数据库恢复及CLI合成演练PASS；容量／时间限制及原断言保持。
- `android:check` PASS，34项JVM、lint及debug／instrumentation APK编译完成；新增device类未执行。全量e2e 162 PASS／1原有SKIP、退出0；最终生产build／TypeScript和本机standalone启动smoke均PASS。
- 最新390／768／1440截图已逐张查看，无横向溢出；details清码及SPA离开后无密钥字段已在真实浏览器通过。
- 私有env真实值仅在进程内与diff比对，15项无命中；根版本1.56.0一致，9份变更Markdown的31个相对链接均存在，diff whitespace检查PASS。仅版本字段变化，未新增或更新依赖。
- 实际旧容器及HTTPS只读观测保留在验证记录：loopback发布、core limit=0、无Node report相关env，旧登录页200及同源麦克风；不能将这些观测称为新版运行验收。

### Residual Risk

- 这是按请求临时服务端解锁的静态存储保护；运行进程／TLS终止方可接触明文，JavaScript GC无法证明所有内存副本即时擦除。没有服务端密钥托管／池化路径，不承诺端到端加密。
- 未执行具体生产家庭转换、干净卷替换或旧明文WAL／备份／供应商副本删除；已验证逻辑转换不等于旧物理副本消失。实际维护须遵循已批准具体范围和runbook。
- 恢复新增用例早先两次checkpoint拒绝未复现、根因未查明；后续19项、CLI及本轮完整949项通过。现有失败路径整体回滚并保留原材料；保留诊断限制，不能声称已证实修复。
- 旧HTTPS登录响应缺少部分基础安全头为已观察的既有情况，本任务未扩大修复；新版镜像／实际临时目录、外部日志、具体备份及APK真机仍按各自环境核验。

安全审查未发现P0／P1，F1／F2仍未完成，**完整安全验收不标记通过**。[仓库安全skill](../../../skills/billboard-security-review/SKILL.md)要求：“缺少证据时，把它当作发现项，而不是当作安全假设。”用户随后于2026-10-22明确要求“先提交推送和上线”；按当前用户指令优先规则，执行提交、master推送及正式部署，同时保留上述发现、验证证据和残余风险。此授权不代表真机／外部日志验收通过，也不授权自动开启家庭加密、生产物理转换或删除旧副本。
