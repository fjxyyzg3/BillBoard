# 第四期开放保障实施计划

> **For agentic workers:** REQUIRED SKILL: Use implement to execute this plan task-by-task. Respect the handed-off git_state: inherit prepared, otherwise prepare; use git-workflow for checkpoint/finalize. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付可安全退出、导出和选择外部处理的家庭账本，为小范围朋友试用补齐资源及运行保障。

**Scope Source:** `docs/scope/2026-10-21-multi-household-ledgers.md` 第四期，用户于 2026-10-21 审查后批准。

**Architecture:** 沿用原 AppSession、家庭优先锁和短事务写入；本人能力选择只控制新任务准入，原任务以有界受理事实延续。数据库共享额度保护导入、AI、语音和导出；Excel 在私有临时位置按一致快照分批生成、授权复核后下载。生命周期保留全部历史财务引用。

**Tech Stack:** Next.js 16、React 19、Prisma 6、PostgreSQL 17、ExcelJS、Vitest、Playwright。

**Verification:** lint、全部 unit/integration/e2e、生产构建；并发准入、语音阶段衔接、退出与下载竞态、真实隔离恢复及合成供应商 smoke；安全审查、远端 SHA 与发布健康检查。

---

## Git、所有权与执行顺序

继承已准备的 `feature/household-phase-four` 与 `.worktrees/feature/household-phase-four`，基线 `v1.54.1`；初始无任务外修改。原 master 干净，原有其他 worktree 保留。spec 与本次实现为同一 feature，checkpoint 核对证据及所有权，不单独提交未实现的设计。最终版本 `1.55.0`，仅在完整验证和安全审查后提交、合回并推送 master。

根代理负责 schema/迁移、能力选择、文字／语音、共享客户端选择组件、i18n、文档、整合测试、运行证据与 Git／发布。身份代理负责 account/households 服务及账号／家庭页面和 actions；导出代理负责 exports、下载 route、记录页导出入口与新测试；资源代理负责 resources、四来源上传／确认与推荐服务和新测试。共享文件只由根代理编辑。数据库和浏览器测试统一串行，不能并发清理共享开发库。

## 1. 批准、Wiki 与结构合同

**Files:** 本计划、原 spec；三个已确认的 `docs/wiki/households-and-ledgers.md`、`natural-language-accounting.md`、`import-category-agent.md`。

- [x] 核对批准稿摘要与 prepared 上下文，记录批准，不重新确认范围。
- [x] 先同步三个 Wiki 的稳定约定，保留原文档范围与第一行摘要。
- [x] 对照 spec 自审全部任务及实际文件；文档 checkpoint，依偏好留待 feature 一并提交。

## 2. 本人选择与数据库增量

**Files:** `prisma/schema.prisma`、新 migration；新建 `src/lib/processing/types.ts`、`preferences.ts`、`voice-admission.ts`；`src/app/api/account/processing/route.ts`；`src/components/processing-preferences-form.tsx`、`processing-provider.tsx`；`src/app/account/privacy/page.tsx`；`src/lib/i18n.ts`；新 `tests/integration/processing-preferences.test.ts`、`tests/unit/processing-policy.test.ts`。

**Contract:** User 新增默认 false 的 `aiProcessingEnabled`、`voiceProcessingEnabled`，不通过 seed、存量使用或邀请自动同意。本人有效会话读取／修改，并按家庭优先锁与新任务受理串行；审计仅记录开关动作和目标。新 `VoiceProcessingAdmission` 保存原 UUID、身份／会话／账本、音频摘要、转写摘要、期限与消费状态，不存正文；新 ResourceWindow/ResourceLease 由任务 3 复用。账号状态增加 DEACTIVATED，区别既有 LOCKED。

- [x] 先对既有文字入口写“无同意不得外发”测试，实际运行确认旧行为不满足，再实现准入；用真实数据库及 HTTP fixture 隔离外部供应商。
- [x] 覆盖本人／无家庭／跨账号隔离、存量默认关闭、跨设备更新、无效会话及同意与关闭竞争；只修改必要测试 fixture，不引入测试绕过。
- [x] 增量迁移、Prisma generate、字段与约束验证；迁移不更新原业务字段或 seed 正式库。
- [x] 客户端首次说明、拒绝／保存／错误状态与账号设置、隐私及申请指引中英文完整；检查手机和桌面可读性。

## 3. 共享额度与导入

**Files:** 新 `src/lib/resources/policy.ts`、`admission.ts`；`src/lib/imports/drafts.ts`、`agent-suggestions.ts`、`xlsx.ts`、相关 source 解析及 import actions；新 `tests/unit/resource-policy.test.ts`、`tests/integration/resource-admission.test.ts`；相关导入集成 fixture。

**Contract:** `acquireResourceLease(tx,session,kind,options)` 可在原受理事务内取得额度；`withResourceLease` 支持同事务 `admit(tx)`；`assertResourceLease(tx,lease)` 在写入／返回结果前校验，`releaseResourceLease` 在工作实际停止后释放。kind 为 import/ai/voice/export，窗口同时检查全局、家庭、成员；AI 原全局硬上限保持 1。使用数据库时间、固定期限和一致锁序，拒绝零扣减；切换、重登和终态查询不增加名额。

- [x] 用既有导入／推荐入口构造并发行为 RED，再实现共享窗口及租约，新增模块单测验证精确规则。
- [x] 集成真实数据库验证家庭/全局争用、取消与超时后释放、进程边界、失效 token fencing、关闭选择前后新旧批次、已完成导入查询不扣。
- [x] XLSX 保留 child close 后才释放；PDF/ZIP 增加原有大小边界内的取消与有限处理期限；最终导入事务检查有效租约。
- [x] 固化窗口、并发、期限及返回码，记录代表性负载结果；不扩展套餐或管理面板。

## 4. 文字与语音的一次受理

**Files:** `src/lib/transactions/natural-language-entry.ts`、`natural-language-agent.ts`、`natural-language-types.ts`；`src/app/api/voice/transcribe/route.ts`、`entry/route.ts`；`src/lib/voice/accounting-queue.ts`、`transcribe.ts`；`src/components/natural-language-provider.tsx`、`voice-accounting-provider.tsx`、`natural-language-form.tsx`、`import-category-mapping-form.tsx`、`app-shell.tsx`；新增集成／单元和 e2e。

**Contract:** 新文字请求在原 UUID 锁及家庭锁内检查 AI 选择并取得 lease；原成功／失败只返回终态。语音受理时须两项选择，固定原任务与录音摘要；转写后只给本次输出生成有限延续依据。提交同一 UUID、转写摘要与上下文才可消费；关闭开关不拒绝该原任务，换正文／目标／身份、过期或重复使用不能产生新任务。每阶段复核真实 AppSession；最终写事务检查权限及租约，归档／退出／撤销仍阻止入账。

- [x] 用关闭前受理、受理后关闭、浏览器尚未受理、换正文和失效身份写行为 RED；保留实际输出。
- [x] 接入新准入和有限延续，不在 URL/sessionStorage 保存延续凭据、正文或音频；仍只恢复已提交账务 UUID。
- [x] 模型失败／超时／取消释放占用，业务失败不自动切换 UUID 或重做；旧 UUID 不需要新同意，不重新外发。
- [x] 聚焦 voice/controller/NL 集成与 e2e GREEN，记录关闭选择与两阶段跨设备、晚响应及存储失败证据。

## 5. 账号停用与家庭关闭

**Files:** `src/lib/identity/account.ts`、`households.ts`；`src/app/account/actions.ts`、`page.tsx`、`household/page.tsx`；新 `tests/unit/identity-lifecycle-actions.test.ts`、`tests/integration/identity-lifecycle.test.ts`、对应 e2e。

**Contract:** 服务也校验 confirmed 与当前密码。OWNER 先转让或明确关闭，停用不是关闭授权；关闭只结束当前家庭成员及邀请，不触碰已离开并加入其他家庭者的新会话。保留 User、历史成员及账务，恢复密码不恢复 DEACTIVATED。

- [x] 先测试既有 action 的 close 操作实际返回 INVALID_INPUT 的 RED，再新增真实行为。
- [x] 实现 `deactivateOwnAccount`、`closeHousehold` 与页面；覆盖无家庭、负责人约束、他人及跨家庭隔离、错误密码／确认、会话与 token 撤销。
- [x] 并发验证迟到写入被拒、历史统计不变、关闭后账号仍可登录无家庭引导；新增中英文及用户操作 e2e。

## 6. Excel 导出

**Files:** 新 `src/lib/exports/*`、`src/app/api/records/export/route.ts`、`src/components/record-export.tsx`；`src/app/(app)/records/page.tsx`；新 `tests/unit/record-export.test.ts`、`tests/integration/record-export.test.ts`、`tests/e2e/record-export.spec.ts`。

**Contract:** POST 输入账本、上海日期范围与 locale，其他列表筛选不改变导出并在 UI 明示。RepeatableRead 一致快照按 ID 游标分批写私有临时 Excel；记录、文本、文件、生成与下载时间均有界。生成和领取授权复核；结束、取消、失败与过期清理，无公开领取 URL。

- [x] 用真实 Excel 读回断言金额分／元、上海时间、历史成员／归档与公式安全；用双家庭和软删除记录验证范围。
- [x] 实现受保护生成／下载、稳定分批、大小／时限上限与取消清理，复用 export lease 并持有至流真正结束。
- [x] 验证生成后撤销访问、并发更新快照一致、过大范围可重试、手机下载和英文文案；容量检查记录行数、耗时和内存。

## 7. 完整回归、安全与发布

**Files:** 根版本、README、适用 runbook、AGENTS／安全规则必要增量；私有 `tmp` 保存部署及恢复证据。

- [x] 整合后执行 lint、unit、integration、e2e 和生产构建；DB 测试串行，只用本地开发／测试库；新增合成 fixture 明确选择，不自动同意生产账号。lint、完整 unit/integration/e2e、最终 Linux 候选镜像构建及镜像内实际导出均已通过；既有条件跳过明确记录。
- [x] 用 billboard-security-review 检查实际面，报告 Findings/Verification/Residual Risk；私有敏感值、真实入口、音频 URL 和正文不得进入跟踪文件或公开日志。
- [x] 私有正式快照恢复到空 PostgreSQL 17 演练增量迁移及重试，比较全部原字段／行数／家庭成员月份统计；保留备份及原镜像，不执行生产 seed。
- [x] 核验供应商配置、HTTPS/OPS 隔离及维护者确认的转发日志边界，以合成输入验证外部服务及代表性容量；已有邮件验收在有效边界内复用，维护者确认与独立配置检查的证据来源分别记录。
- [x] 同步版本1.55.0，刷新远端、只提交本任务、rebase/FF合回并推送master，核对实际SHA后发布；停写最终备份，正式迁移，按既有启动脚本恢复并检查健康、登录及历史读取。
- [x] 更新证据与 spec 真实交付状态，清理本次干净且已合并推送的 worktree/branch；实际朋友邀请只处理明确提供的受邀对象，不猜测收件人。

## 验证记录

批准稿正式 review-spec 为 P0/P1/P2=0/0/0。首轮整合单元测试 97 文件、930 通过、2 项既有跳过。最新整仓 lint 通过。

针对性集成第一轮 379 通过、5 失败；已修复跨进程模块加载，原 CMB 并发用例按新准入验证 BUSY 零副作用后显式重试，未放宽生产额度。资源、CMB 及 2×20,000 行真实解析容量整合复验共 41 项通过；窗口清理保留实际 RED（2 个旧窗口未清理）与 GREEN。

独立安全复核发现语音在读体前受理、供应商名未规范化、偏好读体超时仍保存三项问题。语音慢体及坏 WAV 先分别复现错误 200 和残留 grant，改为上传仅占资源、有效完整音频才原子复查选择并绑定摘要；语音 22 项通过。偏好超时及预取消先分别复现错误 200，再拒绝 408/499 并贯穿事务取消；偏好和语音整合 58 项通过。元数据大小写／空白用例 3 项先失败，修复后所属 15 单测通过。语音队列修改文本也受八项上限约束，保留实际 RED 与 26 项单测 GREEN。

最终完整单元测试 97 文件、934 通过、2 项既有跳过，整仓 lint 通过。完整集成首轮 827 通过、4 项失败来自两份旧测试的全局身份额度残留，隔离合成测试状态并给等待门闩立即挂异常处理后，所属 28 项复验通过；未修改生产额度或原断言。最终完整集成 52 文件、831 通过。迁移摘要新增真实资源表与 2001 行分页测试，实际 RED 为稳定键缺失，兼容 `key`／`token` 后所属 4 项通过。

首轮浏览器 26 项中 23 通过：Excel 三项与既有语音 18 项通过。账号生命周期两项受旧限流 fixture 污染，已统一隔离；跨设备选择另实证隐藏表单常驻导致旧状态，已修为新弹层重新读取，原跨设备断言保留且最终复验通过。首次选择、导出及生命周期已检查 390／768／1440 三宽截图；嵌入选择表单省重复标题，截图等待实际面板动画结束。

完整 e2e 第一轮 114 通过、38 失败、1 未运行。已定位 `ProcessingProvider` 在 SSR 已给出 `initialChoices` 时重复首次 GET，触发父 context 更新与流式 hydration 竞争，临时保留 `S:0` 隐藏片段；A/B/A 对照为原逻辑 RED、略过首次挂载 GET 通过、恢复原逻辑再次 RED。修复保留 focus/change 刷新；原快速记账、草稿恢复及中英文处理选择六项聚焦复验全部通过，没有批量改旧选择器或加等待。最终完整 e2e 为 152 通过、零失败、零 flaky、1 项既有条件跳过，耗时约 7.9 分钟。跳过的是 `WEAK_NETWORK_PRODUCTION_PERF=1` 且需独立生产构建服务的性能基准，未把它记为已通过；普通弱网恢复和原 UUID 确认用例均通过。

Linux 候选 runner 中实际 bundled ExcelJS 验证通过，证据为主工作区私有 `tmp/validation/phase-four/export-linux-build-review.json`。本次在 `network=none`、只读 probe 挂载、无发布端口、无私有环境变量且无数据库／供应商调用的容器中，实际生成并读回一笔合成账务的 5,953 字节工作簿；字面公式文本保持、ZIP 有效、临时文件清理后为零，耗时 169 ms、退出码 0。该报告为候选构建证据，`publishedReleaseShaVerified=false`，不能当作正式发布验收。

SSR 修复后的最终 Linux 候选镜像重新构建通过，实际 bundled ExcelJS 再验生成 5,952 字节工作簿、耗时 202 ms，读回及清理均通过，35 项模块解析没有越出应用目录；镜像内无私有 env、应用 tmp 或运行时秘密。新增证据为主工作区私有 `tmp/validation/phase-four/export-final-linux-build-review.json`，仍为未发布的候选证据。清理生成的 `tsconfig.tsbuildinfo` 后，最终私有值扫描 628 文件、16 个值与 22 种表示均零匹配；8 份 Markdown 的 21 个相对链接及三处版本 `1.55.0` 一致。

私有 `tmp/migrations/multi-ledger-phase-four/prepared/` 的维护脚本静态审查及纯合成 probe 通过：PowerShell 保护 55/55、结构／历史／manifest 及 TERM 84/84、匿名 HTTP 离线 fixture 36/36；5 个 PowerShell AST 和 4 个 Node 语法检查均通过。这些 probe 的生产命令、数据库命令均为零；没有复制第三期运行 JSON 或把离线结果记为正式运行结果。

真实只读正式备份已恢复到核实为空、无公开端口且网络隔离的 PostgreSQL 17，演练报告保存在私有维护目录。全部原表、行和账务分组摘要在两次增量迁移及重试后全部一致；迁移历史由 18 个已应用、2 个待应用变为 20 个已应用、零待应用，原／新增 checksum 全部匹配。目标 28 表及精确约束、存量两项默认关闭、原账本元数据和分组摘要均通过。clone 新增一笔合成账务及三张资源／受理表状态后再次备份，恢复到第二个空库后，各表行数、分组摘要和全部字段一致；两份 clone 已停止、卷与校验一致的双备份保留，无生产停写、迁移或 seed。

首次演练严格 checksum 拒绝了 Windows checkout 的五份 CRLF 字节，已仅将这五份恢复为与原 Git blob 完全一致的 LF；原 18 份文件的实际字节均匹配上期已应用 checksum。`.gitattributes` 只对已证实的五份旧 LF 文件固定换行、对两份新迁移冻结字节，保留既有冻结规则和其他旧文件行为，未改写原 SQL blob 或数据库历史。

当前供应商、密钥隔离、音频 tmpfs、HTTPS 麦克风和 OPS 隔离已实测；主模型路由及 DeepSeek 独立后备各一次合成文字 smoke 通过，未使用真实账务。维护者于 2026-10-21 明确确认实际转发服务不会记录完整音频 URL、查询参数或音频，本次将其作为外部日志边界的维护者事实确认，解除此前证据阻塞；没有将其写成 agent 独立读取服务商配置，也未以 frpc TCP、短 TTL 或 nginx 示例替代。真实 ASR 合成 smoke 通过：本机新合成 5.32 秒非财务中文音频，一次正式转写请求 HTTP 200、1,744 ms、2/2 预期片段命中，线上私有音频文件实测 0→1→0，本地合成 WAV 已删除；只有允许的正常会话 lastSeen 更新，没有新建会话、写账、发信或改配置。证据为私有 `tmp/validation/phase-four/real-asr-smoke.json`，基于未改变的既有供应商与真实转发链路，第四期新准入另由完整集成／e2e 覆盖。朋友邀请仍只在取得明确受邀对象后发送。受控恢复／删除的公开申请原则及私有逐次核实操作指南已准备，没有实际删除授权或真实删除。

独立代码安全复核未发现未修复的本期新增阻塞问题；外部日志原 P2 缺口由上述维护者确认补足。远端来源限制仍不冒称已封禁，沿用现有未变更入口并保留残余风险说明。只读恢复检查已穷尽仓库相关运维文本、私有配置和非敏感 HTTPS 响应头；`Via` 只提示 Caddy 软件，未作为服务商身份或日志关闭的证明。另 `npm audit` 返回 25 条既有告警（17 high、6 moderate、2 low），依赖与锁文件仅根版本变化；本期 ExcelJS 写入路径不调用受影响的 npm tmp，UUID 及 archiver 的新增调用路径未命中所列漏洞条件，其余既有运行／工具依赖保留独立维护事项，未擅自升级。

证据在本次私有 `tmp/validation/phase-four/` 和 `tmp/migrations/multi-ledger-phase-four/`，最终安全记录包含 Findings、Verification、Residual Risk。完整 lint/unit/integration/e2e、最终 Linux 构建与镜像内导出、真实恢复演练及真实 ASR 均有上述通过证据，安全审查没有未关闭的本期阻塞项。本轮继承原 Git prepared 上下文和通过的最终改动验证，只补充维护者确认及真实运行证据，不重复完整应用测试。

## 正式交付记录

2026-10-22 已将 `v1.55.0 完成多家庭账本第四期开放保障`合回并推送 `master`，核对实际远端 SHA。从该干净提交归档构建 tools／runner／agent 三镜像并核对 digest 与 revision；正式 runner 中实际 bundled ExcelJS 生成及读回 5,951 字节合成工作簿、223 ms，字面公式安全、35 项模块解析及临时文件清理通过。独立证据为私有 `export-published-linux-build-review.json`，不以候选镜像代替。

正式维护核验通过。启动入口使用操作系统独占读取围栏，停止明确写入者并等待收敛，再取得校验一致的最新双份备份，在新的空 PostgreSQL 17 clone 实际恢复、迁移和重复执行核验后，才迁移正式库。原表行数、各组摘要和全部原字段保持一致；迁移历史由 18 到 20，迁移后已复核全库行数，新增选择默认关闭，未 seed、未覆盖恢复、未删除共同历史。clone 已停止，备份、卷与旧镜像保留。

释放围栏后，使用原 `start-production.ps1 -SkipBuild -PrivateSmokePort 33001` 检查私有新版本，再以 `-SkipBuild` 恢复原端口；两次均只显式执行 `prisma migrate deploy`，没有执行 bootstrap 默认 seed。最终实际三镜像均对应 `v1.55.0`，web／OPS 只绑定本机、后台无公开端口，重启策略正常。HTTPS 登录、静态资源、同源麦克风、七个受保护页面、私有页面响应头及公网 OPS 404 均通过；两个原有效 AppSession 的身份、历史查询、账本页面、处理选择 GET 和隐私页通过，原身份密钥保持，没有新建会话或修改本人选择。

发布后独立边界复核 `post-release-boundary-review.json` 通过：实际 processing DTO 的精确键及服务字段与 Agent 主服务、后备配置和语音配置一致，私钥隔离与音频 tmpfs 的实际挂载及保护标志均成立；复用前述真实主／备模型及 ASR smoke，未重复外发。外部日志依据维护者明确确认，远端来源限制和既有依赖告警按前文保留残余风险，不虚构独立配置核验。

干净且已合并推送的任务 worktree 与本地分支已删除，其他 worktree 保留；86 份任务验证文件（含 15 张本期截图）已保存至主工作区私有 `tmp/validation/phase-four/`。没有明确收件人，因此未发出朋友邀请。此次验收记录属于文档收尾，根版本同步为 `1.55.1`，按文档-only 规则执行文本、版本与安全检查并提交推送，不再次重启；正式应用继续运行已核验的 `v1.55.0` 镜像。

## 四期补漏维护范围

2026-10-22，维护者确认本轮完成六项补漏，作为 `1.55.2` 维护变更：退出及切换账号撤销原会话、导出遗留文件独立清理和删除重试、支付宝解析有界让出与线性退款分组、语音文件工作结束后释放处理占用、归属成员筛选、任务结果固定原账本。第一期遗漏的发布状态勾选同步按已有证据补齐，不重复迁移。

成员范围采用首页、分析、记录统一联动，默认全部成员；包含原历史身份，同名重新加入按不同原 ID 分别选择。Excel 默认沿用页面归属成员，弹窗明确展示并允许切回全部成员；搜索、收支方向、分类和金额不改变导出范围。

外部验收仍须补证：远端 `3000` 按转发服务实际来源限制访问，以及转发服务至 `frps` 的传输加密或受信网络条件；真实 Safari／Chrome 录音及英文、中英混合语音识别的端到端结果。仓库和现有私有配置不足以独立确认，不能用本机检查或模拟音频代替。已确认的邮件收发及外部音频日志控制继续沿用，不重复索取确认。

第四期审计记录中的 25 条既有依赖告警单独安排升级，本轮不调整依赖版本。后续维护须重新核对告警与实际调用路径、升级依赖及锁文件，再完成完整回归和发布验证。

本轮同时覆盖 Auth.js 原生退出入口：保留真实 CSRF 校验，撤销原服务端会话；存储故障返回可重试错误并保留 Cookie。实际退出确认页检查发现正式容器未接收已有可信根入口，现由 `APP_PUBLIC_ORIGIN` 派生 `AUTH_URL` 注入 web；真实入口和凭据仍只保存在私有配置中。

最终补漏验证通过 lint、TypeScript 检查、968 项单元测试、839 项集成测试及 158 项端到端测试；另有 2 项单元测试和 1 项端到端既有条件跳过，未记为通过。成员筛选与导出完成中英文、三种视口的真实浏览器复核；Linux 候选 runner 的独立遗留文件清理、真实 JWT／CSRF 与存储失败路径共 19 项探针通过。安全审查未发现本轮未修复的阻塞问题，私有证据保存在 `tmp/validation/four-phase-gaps/`；这些是提交前验证，正式镜像、原会话及 HTTPS 运行验收须在实际发布后另行记录。
