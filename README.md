# BillBoard

BillBoard 是移动优先的家庭共享记账应用。核心流程是快速记录、按整个家庭查看和按时间范围复盘；不同家庭相互隔离，现有两人家庭账目与归属继续保留。

正式版本的源码来自 [BillBoard-public 的 master 分支](https://github.com/fjxyyzg3/BillBoard-public/tree/master)。

## Current Product Shape

- `/login`：账号密码登录，支持原家庭账号和本人完成邀请验证后的账号。
- `/help`：无需登录的中英文完整使用教程、Android APK／Windows x64 EXE 下载与邮箱注册申请；登录页、手机“更多”和桌面侧栏均可进入。
- `/home`：突出所选范围支出，辅助展示收入、结余与记录笔数；趋势点可先查看金额再进入明细，手机分类分析优先展示横向占比条。
- `/records/reconcile`：从记录页进入独立 AI 对账页面，按月／年扫描，支持人工确认重复记录及保留项。任务提交后锁屏或关闭应用仍继续，重开可从家庭共享报告列表查看状态和结果。
- `/add`：手工填写或自然语言记账。手工收支草稿刷新后恢复，保存后保持可连续记账；自然语言模式用文本框和导入按钮识别人民币收入、支出及混合交易，整段校验后一次入账，显示笔数及收入／支出各自合计。手机操作栏避让软键盘。
- `/records`：常驻搜索与可展开筛选，所有筛选草稿统一提交，已生效条件可逐项移除；列表展示备注摘要并对齐金额，支持编辑、软删除及按账本与日期导出 Excel。
- `/records/import`：随手记、微信支付、支付宝和招商银行借记卡账单导入。按上传、映射、核对、完成展示进度与待处理摘要，保留家庭共享映射、同源去重、逐行复核及批量确认。
- `/ledgers`：家庭共享账本管理，成员可新建和重命名，负责人设置默认、归档及恢复。归档历史仍可查并纳入家庭汇总；默认账本须先更换才能归档。
- `/account`：本人邮箱、密码、登录会话、AI／语音选择及停用账号；`/account/household` 提供家庭成员、可选账本加密与负责人关闭家庭入口，`/account/privacy` 说明隐私、数据保留和申请方式。
- 查看范围在家庭总览与单账本间切换，设备按当前成员身份记住选择；新记账另行显示目标，家庭总览保留上次有效记账账本。移动记录保留成员和来源，导入仍在整个家庭去重。切换不改写在途文字、语音或导入任务的原目标，缺少明确目标的旧页面须刷新后提交。
- 默认中文，支持英文切换。手机底部仅保留三个主入口，语言、反馈和版本放在顶部「更多选项」；桌面在侧栏显示。
- 长按导航中的“记一笔”在当前页语音记账，松开后自动转写并入账，上滑松开取消；短按仍进入 `/add`，底层页面筛选与草稿保留。

## Key Rules

- Store money as integer fen in `amountFen`.
- Calculate transaction dates and ranges in `Asia/Shanghai`.
- Exclude soft-deleted transactions from active lists and reports.
- Scope household data by the current session's `householdId` and `memberId`.
- App requests use a server-side `AppSession` behind the JWT. A valid app session must exist, be unexpired, and not be revoked.
- 登录在密码校验前取得数据库原子额度：全局最多同时校验 2 次，每个账号最多 1 次；突发容量 10 次，每 3 秒恢复 1 次。已知账号连续失败 5 次锁定 15 分钟。全局额度不足时所有新登录提示稍后重试，已有 `AppSession` 不受影响；未知邮箱不创建独立限流记录，限流拒绝不逐次写入应用事件。
- XLSX 在独立进程中解析，每个应用进程最多同时处理 2 份，30 秒超时后终止解析。上传上限为 20MB；ZIP 最多 2,048 个条目，单条目解压最多 32MB、总解压最多 64MB，并检查实际解压字节数。解析进程有 256MB V8 堆上限，结果上限 32MB；最多 16 张表、25,000 个非空行、每行 128 列、总计 500,000 个单元格，业务导入仍限 20,000 行。超过边界时提示拆分账单，繁忙时提示稍后重试，不生成草稿。
- Default categories are seeded from `prisma/seed.ts`; built-in category names are stored in English and translated only for UI display.
- Imported transactions keep `source`, `sourceFingerprint`, and `sourceImportedAt` metadata for same-source dedupe; manual transactions leave them empty.
- Imports never create categories. Users map each source's category key to existing categories, and mapping choices are shared by the household.
- 招商银行快捷退款只与同份账单中商户一致、较早发生且剩余可退金额足够的唯一支付合并；同日付款、多候选、缺少原支付及超额退款转人工复核。部分退款按原支付日期记净支出，全退不计收支；历史记录或退款关联变化时不自动改写账本。
- 招商银行已完成导入草稿保存支付与退款的关联，用于防止重复抵扣。`ImportDraft` 和 `ImportDraftRow` 是长期账本元数据，备份、恢复时必须一并保留，不作为临时草稿清理。

## 家庭账本可选加密

新建及升级后的家庭默认未加密。当前负责人可为整个家庭开启、关闭或独立换钥；换钥保持加密状态。开启／换钥前须保存并回读验证家庭码、独立密文恢复包和本次操作恢复文件，有效成员导入家庭码后使用全部获准账本。关闭需要当前有效码及明确确认，再次开启使用新周期并保留历史恢复点依赖的包封密钥。

浏览器使用本机不可导出的密钥保护 IndexedDB 中的家庭码、草稿及待确认 UUID；Android 使用 Keystore。家庭码只随当次 HTTPS POST 正文上传，服务端仅在有界请求或已接管的对账任务内临时解密处理，不持久保存可复用密钥，也不把家庭码发送给 AI／语音供应商。主动退出登录／身份变化清理可用密钥；重开只查询原任务或家庭报告状态，不自动重发输入。对账的独占任务上下文在结束时释放，服务器重启不自动续跑，见[AI 对账说明](docs/wiki/ai-bill-analysis.md)。

这保护已加密家庭的当前静态账务，服务端处理期间仍可接触明文。开关不会消除数据库旧行版本、WAL 或既有备份；家庭须自行保管码及独立恢复包，维护者无法代解锁。逻辑转换、跨版本空库恢复、旧副本维护及实际运行边界要求见[家庭账本加密与独立恢复](docs/runbooks/household-encryption.md)。合成演练和本机测试不能替代真实入口日志及 Android 真机验收。

## AI、语音与隐私选择

每个账号的“允许 AI 处理”和“允许语音识别”分别保存，存量及新账号默认均关闭，跨设备生效。本人可在 `/account` 或首次使用时查看实际启用的模型服务及数据去向，再选择并保存；保存选择后须重新明确发起任务，不自动提交页面草稿。家庭负责人不能替其他成员选择，无有效家庭的已登录本人仍可管理选择。

AI 选择覆盖自然语言记账、导入智能推荐和 AI 对账；语音记账需要两项都开启。关闭或暂不使用后，手工记账、手工分类映射、历史查询和已提交任务的结果确认继续可用。

关闭后服务端拒绝新任务；关闭前已正式受理的原任务可在原期限内完成并可能入账。语音须完整上传、通过音频校验并复核当前选择后才算受理，上传占用和浏览器排队不授予延续资格；原任务继续固定本次音频、转写、账号、会话、成员、账本及 UUID。退出、移除、停用、家庭关闭或目标归档仍会阻止不合法的后续处理和写入。关闭开关不能撤回已发送给供应商的数据。

隐私说明位于 `/account/privacy`，包含维护者可接触的服务端数据、共同历史与备份保留边界及私下申请方式。永久删除或重新启用须另行核实本人及具体范围，处理原则见[账号与数据申请](docs/runbooks/account-data-requests.md)。

## Excel 导出与繁忙处理

首页与记录页可按账目归属成员筛选，默认包含全部成员；汇总、分析、搜索与钻取使用同一成员范围。历史身份保留标记，同名重新加入的身份可分别选择，筛选不改变当前授权身份或新记账归属。

在 `/records` 选择家庭总览或单账本后点击“导出”，确认账本、归属成员及上海日期的起止日，再点击“下载 Excel”。成员默认沿用页面选择，也可在弹窗切回全部成员；导出包含所选范围内归档账本、历史成员的有效账目，排除软删除记录。搜索、收支方向、分类和金额等其他列表筛选不影响导出。导出只包含账本、成员归属、记录成员、收支方向、分类、金额、发生时间、备注和来源，不含账号邮箱、来源指纹或原始导入行。

金额（元）列使用精确小数文本，金额（分）列使用整数，可按整数分汇总校验；发生时间明确标注 `Asia/Shanghai` 并保留毫秒。备注等文本保持字面内容，不生成公式或外部链接。单次最多 100,000 笔，累计文本上限 16 MiB、文件上限 32 MiB；生成最多 60 秒、下载最多 110 秒，超过范围或时限时保留选择，缩短日期后重试。

生成和领取均复核原会话与家庭访问权限，不提供公开共享链接，下载不缓存。私有临时产物有效期为 180 秒，完成、取消、失败或到期后清理；Node 服务启动和独立有界巡检会清理过期遗留文件，临时删除失败会重试，不依赖下一次导出。持续文件系统故障仍需恢复底层条件。停用、退出或家庭关闭后不能领取原产物，需在操作前按需导出。

导入、AI、语音和导出受跨进程一致的全局、家庭及成员额度保护，AI 任务全局最多同时处理一份。看到繁忙／限额提示时，保留当前范围、原任务和草稿，等待后手动重试；结果待确认时先确认原任务，不通过切账本、重新登录或更换 UUID 重发。手工记账和基本查看不占这些重处理名额。具体额度见[资源政策](src/lib/resources/policy.ts)。

## 使用教程与客户端下载

`/help` 面向首次安装和日常使用，提供安装登录、邀请与密码找回、手工／文字／语音记账、查询统计与编辑删除、四种来源导入及 Excel 导出、账本与家庭成员、账号隐私与 AI／语音选择、家庭加密与备份恢复、客户端更新和常见问题的中英文图文说明。教程示例使用演示数据，不展示真实家庭账目。

首次使用可在本页提交邮箱申请，按邮件提示确认后进入本机 OPS 审批。获批后会收到用于建立独立家庭的平台注册邀请，仍须本人完成邀请注册／接受流程；提交申请或确认邮件不会直接取得账号和家庭访问。

教程、Android APK 和 Windows EXE 公开提供。`GET /api/downloads` 提供这两个平台的版本及大小，`GET /api/downloads/android` 和 `GET /api/downloads/windows` 分别下载对应安装包。iPhone 的 Ad Hoc 安装区要求指定家庭的有效会话，系统安装链接有效期为 10 分钟。

首次安装请用浏览器打开帮助页；原生壳限制普通安装包下载，已安装客户端使用 Android“应用更新”或 Windows“客户端更新”。安装包包含服务地址，公开范围限于已发布的正式产物；真实入口仍不得写入 Git 跟踪文件或历史，私钥、本地配置和未发布产物不公开，不新增第三方托管。公开下载不授予账号、家庭或账务权限。帮助页随服务端部署更新，不要求重建两端客户端。

## Android APK

Android 家庭客户端通过系统 WebView 访问现有 HTTPS 服务，保留登录、记账、账单导入和语音功能。正式签名 APK 从公开帮助页下载，应用内更新仍通过 `/api/android/update` 及其摘要下载路径校验有效 `AppSession`；构建配置和签名材料保存在 Git 外。安装工具链、初始化签名、执行 `npm run android:check` / `npm run android:build` 及手机安装流程见 [Android APK 构建与家庭分发](docs/runbooks/android-apk.md)。

## Windows EXE

Windows x64 家庭客户端通过 Electron 独立窗口连接现有 HTTPS 服务，使用当前用户级 NSIS 安装包，提供桌面、开始菜单和卸载入口。账号、账目与手机和网页共用，使用者不需要安装 Node.js 或数据库。

客户端支持应用内检查、下载和确认安装；原生更新的 `/api/windows/update` 及其摘要下载路径需要有效原 `AppSession`，并以独立 Ed25519 签名、大小和摘要校验。录音、记账、导入导出及家庭加密操作未完成时阻止安装，安装器等待正常退出，不强杀客户端。覆盖升级保留已持久化资料；首版未购买 Windows 发布者证书，系统可能显示发布者未知。

正式安装包从公开帮助页下载，构建与签名材料继续私下保管。独立依赖、签名备份、`npm run desktop:check` / `npm run desktop:test:windows` / `npm run desktop:build` 及发布步骤见 [Windows 安装包构建与家庭分发](docs/runbooks/windows-exe.md)。

## iPhone 客户端构建和发布

使用 GitHub 托管 macOS runner 构建 `ios/BillBoard.xcodeproj`。Windows 生产机核对发布提交的验收回执及 GitHub 来源证明，再解密并对指定家庭提供安装包。Apple 签名材料、部署配置及实际操作见 [iPhone Ad Hoc 构建和家庭分发](docs/runbooks/ios-ad-hoc.md)。

## Local Setup

开发和正式构建使用 Node.js 22 及其配套 npm。按锁文件安装依赖，并确认 Prisma 和原生模块的安装脚本正常完成：

```powershell
npm ci
```

Start the development PostgreSQL database:

```powershell
docker --context desktop-linux compose -f compose.dev.yml up -d db
```

The development compose project is named `billboard-dev`; production compose uses `billboard`.

Windows 使用 Docker Desktop 的 Linux containers，先启动 Docker Desktop 并确认引擎可用：

```powershell
docker --context desktop-linux info
```

Linux 使用 `docker compose -f compose.dev.yml up -d db`。开发数据库直接发布到
`127.0.0.1:5432`，不再依赖 Podman machine 或 SSH 隧道。Prisma 使用：

```powershell
$env:DATABASE_URL = "postgresql://billboard:billboard@127.0.0.1:5432/billboard_dev?schema=public"
```

Prepare the schema and seed data:

```powershell
npm run prisma:migrate
npm run prisma:seed
```

Run the app:

```powershell
npm run dev
```

For ad-hoc manual startup without a local `.env`, set at least `DATABASE_URL` and `AUTH_SECRET` before `npm run dev`:

```powershell
$env:DATABASE_URL = "postgresql://billboard:billboard@127.0.0.1:5432/billboard_dev?schema=public"
$env:AUTH_SECRET = "replace-me"
npm run dev
```

The development server listens on `http://127.0.0.1:2500` by default.

For LAN device testing, bind the dev server to the machine's LAN IP:

```powershell
npm run dev -- --hostname <LAN_IP> --port 2500
```

If a tunnel such as frpc maps `127.0.0.1:2500` to an external IP and port, bind Next.js to all local interfaces so both loopback and LAN access work:

```powershell
npm run dev -- --hostname 0.0.0.0 --port 2500
```

When using an external IP or domain with `next dev`, set `NEXT_ALLOWED_DEV_ORIGINS` in a private env file such as `.env.local`, then restart the dev server. Use a comma-separated list for multiple hosts. Otherwise Next.js can block development resources, leaving the login form without client-side `signIn` handling. Do not commit real domains or public IPs.

The seed login variables are documented in `.env.example` with placeholder values.
For real deployments, keep actual household account emails and passwords only in
private env files such as `.env.local` or `.env.production.local`.

## Production Entrypoint

当前生产公网链路为 `HTTPS 域名转发服务 -> frps remote 3000 -> frpc -> 本地 127.0.0.1:3000 -> web:3000`，应用使用根路径，远端未部署 nginx。
Build the app with `APP_BASE_PATH=/` or leave the value unset; this is a Next.js
build-time setting, so changing it requires rebuilding the web container. The `web`
service publishes `3000` only on loopback for local health checks and frpc.

Windows 正式服务使用 Docker Desktop。在未跟踪的 `.env.production.local` 中恢复原有
`AUTH_SECRET`、`POSTGRES_USER`、`POSTGRES_PASSWORD`、`POSTGRES_DB` 和其他启用功能的私有配置，
并设置随机的 `IMPORT_AGENT_TOKEN`（至少 32 个字符），然后执行：

```powershell
$env:APP_BASE_PATH = "/"
.\ops\windows\start-production.ps1
```

“反馈卡顿”及其 Agent API 已移除，不再需要诊断 token。首次升级到包含
`20261024030000_remove_client_diagnostic_reports` 的版本时，先用 `-BuildOnly` 构建并核验新镜像，
再停止 `web` 和独立 `billboard-ops` 容器、取得并核验私有备份，最后用 `-SkipBuild` 执行正式启动。
迁移会删除全部历史诊断报告、`ClientDiagnosticReport` 表及其专用枚举，其他业务数据保留；
在迁移完成前保持旧应用停止。Linux 同样在构建后、迁移前停止 web 与独立 OPS 并备份。
启动脚本固定使用 `docker --context desktop-linux`，将数据库用户名、密码和库名 URL 编码后生成指向
`db:5432` 的容器内 `DATABASE_URL`，构建 `web`、`bootstrap` 和 `import-agent` 镜像，等待数据库健康，
执行 `npx prisma migrate deploy`，再启动 `web` 和 `import-agent`。它不会执行 production seed，也不会改写私有凭据。

Linux 使用 Docker Engine 与 Compose 插件，先通过私有 env 文件提供容器内 `DATABASE_URL`
（指向 `db:5432`，凭据必须 URL 编码）和其他生产变量，再按以下顺序发布：

```bash
docker compose --env-file .env.production.local -f compose.yml build web bootstrap import-agent
docker compose --env-file .env.production.local -f compose.yml up -d db
docker compose --env-file .env.production.local -f compose.yml --profile bootstrap run --rm bootstrap npx prisma migrate deploy
docker compose --env-file .env.production.local -f compose.yml up -d web import-agent
```

`Containerfile` 在 Linux 容器中构建 standalone 应用并复制 `.next/static`；无需主机 Node.js 构建或
手动复制静态资源。`.dockerignore` 排除私有 env、备份和本机工作目录。

从 Podman 迁移的现有服务必须先按 [迁移与回退步骤](docs/runbooks/podman-to-docker.md) 迁移数据；
两个引擎的同名卷不是同一份数据。新机器从备份恢复使用 [Restore Runbook](docs/runbooks/restore.md)，
不要用 bootstrap seed 替代恢复。仅全新空库的首次部署才使用 bootstrap 默认命令初始化账号和分类。

真实 hostname、TLS 和转发设置仅保存在私有服务配置中；`ops/frp/frpc.billboard.toml.example` 展示
TCP remote `3000` 到本机 loopback `3000` 的 frpc 配置。远端 `3000` 的访问限制须按转发服务的实际
来源核验并最小化，不能假定已对公网封禁，也不能假定转发服务位于同一主机。生产仍拒绝示例数据库密码。

语音入口要求 HTTPS 和同源麦克风许可。应用通过 `next.config.ts` 提供
`Permissions-Policy: camera=(self), microphone=(self), geolocation=(), payment=(), usb=()`；
前置域名转发服务不能覆盖为麦克风禁用。音频下载端点另有 `no-store`、`nosniff` 和 `no-referrer`，
全站提供 CSP、`X-Frame-Options: DENY` 和 `Strict-Transport-Security: max-age=31536000`。
HSTS 仅约束当前 HTTPS 主机，不启用 `includeSubDomains` 或 preload；HTTP 本机开发不受其影响。
`src/proxy.ts` 为每次页面响应生成随机 nonce，传给 Next.js 的框架脚本并禁止页面缓存；生产脚本不允许
`unsafe-inline` 或 `unsafe-eval`，样式保留内联以兼容图表和动画。连接仅限同源，开发额外允许热更新的
WebSocket 和调试 eval。无 nonce 的 HTML 内联脚本及事件处理器被拒绝；`strict-dynamic` 允许受信脚本动态加载依赖，
不表示禁止它们创建的所有脚本。跨源连接、嵌入框架和插件默认拒绝；摄像头／麦克风仍须用户授权。
发布时从实际 HTTPS 入口核验这些响应头、脚本 nonce、登录、页面导航及语音 Worklet，不以本机检查代替公网验收。
转发服务须保留现有 20 MiB 账单及 multipart 上传空间，不把全站上限收紧为录音的 2 MiB。
转写端点独立执行 2 MiB 限制，不需要新增端口、frp 路由或延长 Agent 超时。

实际转发服务及日志采集器不得记录 `/api/voice/audio`（含尾斜杠路径）的完整 URL、查询参数或响应音频。
需在真实服务配置中核验并关闭相应日志；应用的 `no-store`、45 秒租约和文件删除不能关闭外部日志。
转发服务名称、日志控制和远端端口限制仍须按实际配置核实，HTTPS 页面可达不代表这些保护已生效。

`ops/nginx/billboard-location.conf` 仅为可选的自管 nginx 示例，不代表当前已安装、部署或核验。
若以后采用它，需核验应用与代理响应头不冲突；其精确音频 location 禁用访问／错误日志，尾斜杠直接 404，
上传示例上限 `25m` 保留原有账单空间。配置须先 `nginx -t` 再重载，不能将此步骤套用到当前转发服务。

Windows 直接发布 `127.0.0.1:3000 -> web:3000`，不再建立 SSH 隧道；HTTPS 入口由域名转发服务与 frpc
链路提供。`ops/windows/register-production-startup.ps1` 将 `BillBoard Production Startup` 注册为
当前用户登录后运行的任务。Docker Desktop 依赖用户登录会话，不能保证无人登录时自动启动。
检查和恢复说明见 [Home Network Checklist](docs/runbooks/home-network-checklist.md)。

现有家庭首次升级到历史成员与默认账本模型，须先执行
[家庭与账本第一期迁移](docs/runbooks/household-ledgers-migration.md) 的私有恢复演练和维护切换。
`start-production.ps1 -BuildOnly` 可在停机前构建并核验已推送提交的镜像；普通启动会拒绝直接迁移已有家庭。
迁移保留原账号、有效登录态和全部历史数据，不执行 seed；第一期仍使用固定默认账本。

## 导入分类智能推荐

在 `/records/import` 的分类映射表单点击“智能推荐”，Agent 只处理尚未选择的分组；检查预填结果后
点击“保存映射”，最后单独确认导入。不确定项保持空白，已保存规则和本次手动选择会保留。
只发送来源、收支类型、原分类/交易对方、少量商品文本及候选分类，不发送原文件、金额、时间或成员信息。

`import-agent` 仅在容器网络提供内部受认证服务，导入分类、自然语言记账和 AI 对账统一调用 WheelMaker Hub（Codex）
的 Responses API。开发 `.env.local`、生产 `.env.production.local` 中配置以下私有值；示例地址和 Key 均须替换：

```dotenv
WHEELMAKER_BASE_URL=https://chat-api.example.com/v1
WHEELMAKER_API_KEY=replace-with-private-hub-key
IMPORT_AGENT_MODEL=gpt-6-luna
IMPORT_AGENT_REASONING_EFFORT=high
BILL_ANALYSIS_AGENT_MODEL=gpt-6-astra
BILL_ANALYSIS_AGENT_REASONING_EFFORT=high
```

Base URL 使用 HTTPS `/v1` 地址，Agent 自动追加 `/responses`；不要填写完整的 `/v1/responses` 地址。
调用 Key 在 WheelMaker Hub 中签发、绑定 Codex 并管理，上游登录也由 Hub 负责。BillBoard 不再运行
Codex CLI、执行设备登录或挂载专用认证卷；升级保留已有 Docker 卷数据，不再使用旧供应商选择与 DeepSeek 回退配置。
API 地址和 Key 仅注入 Agent 容器，不写入镜像、web、OPS、浏览器或日志。内部 `IMPORT_AGENT_TOKEN`
继续只用于 web 与 Agent 之间认证，不发送给 Hub。修改配置后重启 `import-agent` 生效。

分类推荐和自然语言记账的每个任务只发起一次模型请求，设置 `ephemeral: true`、`store: false`，不复用 Hub Session ID，不自动重试或回退。
两类任务保持 45 秒总预算，应用等待 55 秒，自然语言租约 75 秒；取消传到 HTTP 请求并等待本地清理，Hub
负责其运行器的停止与回收。现有 API 不提供远端清理完成查询，不承诺 BillBoard 占用释放严格晚于 Hub 清理。
助手文本、完成状态和任务 JSON 必须通过本地大小及业务校验，超时或异常结果不会入账。Hub 的输出 token
参数不能替代应用侧长度限制。服务不可用时保留手工映射和记账路径，修复配置后可主动重试。

该服务无需 nginx/frpc 路由或主机端口。`/health` 只检查进程可用，模型联通需使用合成分类和自然语言输入验证，
不得发送真实账本。批量大小、最小权限及排查说明见 [导入分类 Agent](docs/wiki/import-category-agent.md)。

## 自然语言收支记账

在“记一笔”切换“自然语言”，输入例如“老婆昨天收到奖金 500 元，我今天午饭 35 元”，点击“导入”后自动拆分、分类和入账。每次至多 2,000 字符、合计 20 笔收入与支出；成功显示总笔数及实际包含方向的各自合计。工资、奖金、报销、退款、投资收益等使用现有收入分类；退款新增正数收入，不关联、改写或抵扣原支出。纯自有账户或家庭成员间转账不入账，明确的工资转账到账可记录为收入。

信息缺失或含糊时整段不入账，保留当前页面原文并提示修改。支出归付款者、收入归获得者，省略成员时归当前成员；使用上海时间，只给日期时使用当日 `00:00`。成功后可在记录页编辑或删除。

自然语言与分类建议共用 `import-agent`，通过独立协议和固定指令处理。模型会收到本次文本、上海时间参照、必要分类及匿名成员候选；不附加历史账本、文件、账号或会话凭据。自然语言原文不存入浏览器，刷新后只用待确认请求 UUID 查询结果；重复点击、断网恢复和未受理请求关闭都按同一请求的服务端终态处理。

长按导航“记一笔”可直接录音，也可用键盘打开浮层后开始、停止提交或取消。最多 60 秒，到限停止录音但等待松开才提交；尚未发送时松开过早、失焦、切到后台或导航离开仍会取消。松开发送后立即收起浮层并释放输入，可以继续录音、手工填写、文字记账或切换页面。语音任务在当前应用会话的队列内串行完成转写与记账，使用独立 HTTP 入口，避免长记账请求阻塞手工保存。成功后在前台显示短暂轻提示；处理失败或结果待确认只显示可打开的处理入口，缺失信息保留文字供修改，不自动弹窗打断下一次操作。

启用语音时，在开发 `.env.local` 或生产 `.env.production.local` 中设置 `VOLCENGINE_ASR_API_KEY`，使用豆包语音控制台创建且已开通录音文件识别 2.0 的项目 Key，固定资源为 `volc.seedasr.auc`。同时设置 `VOICE_AUDIO_PUBLIC_ORIGIN` 为供应商可访问的 BillBoard HTTPS 根 origin，例如 `https://<domain>`；不能包含账号、路径、查询参数或 fragment，生产 `APP_BASE_PATH` 保持根路径。两项配置仅由 Compose 注入 web，不传给 Agent、OPS、浏览器或镜像构建；Windows 启动日志同时遮盖文件值和进程值。未配置、入口不可达或权限不足时转写失败，仍可使用文字和手工记账。不要打印生产 `docker compose config` 完整输出，不把私有配置放进 `NEXT_PUBLIC_*` 或命令参数。

浏览器生成 16 kHz 单声道 PCM16 WAV，最多 60 秒、请求上限 2 MiB。web 校验会话、同源、音频和调用额度后，将 WAV 写入 `os.tmpdir()/billboard-voice` 下的进程私有目录；Linux 生产目录权限为 `0700`、文件为 `0600`，Windows 开发环境继承当前用户临时目录的 ACL。最多 16 个租约、活动文件合计最多 32 MiB，租约 TTL 为 45 秒。Compose 为该目录提供 40 MiB 的 `tmpfs`，包含崩溃遗留文件的容量，带 `nosuid,nodev,noexec`，不进入持久卷或备份。完成、取消和过期都会清理租约及文件，启动时及短期延时清理过期遗留文件。

web 通过随机 256 位 token 构造短期 `GET/HEAD /api/voice/audio?token=...` 能力链接，仅交给豆包录音文件识别 2.0 的 `submit/query` 接口取音频；取音频无需 cookie，链接和本地路径全程不返回前端。提交与轮询共用 30 秒服务端总预算，不承诺秒级完成；供应商仍处理中、超时或取消均不触发记账，也不继续后台等待。应用不持久保存转写任务或原文，临时文件清理规则不代表供应商侧留存承诺。

有效转写文字返回浏览器后才交给原 Agent，语音通过同源 `/api/voice/entry` 提交与查询，继续校验 AppSession、成员归属及原请求 UUID。已发送任务不因应用内导航、失焦或页面隐藏而取消；浏览器挂起时可能推迟后续调度，回到前台后继续。录音和转写正文仅保留在内存；刷新或关闭页面会丢失尚未提交的排队、转写任务，已提交账务则在刷新后按 UUID 自动查询，不能重发原文或换 UUID 猜测结果。sessionStorage 只保存已进入账务提交的 UUID 列表，不能写入并读回时保留文字并提示，不能发出账务请求。Next.js 开发日志忽略音频能力链接并关闭 Server Function 参数日志，生产默认不记录 incoming requests；应用异常只使用固定提示，不能输出音频、token、原文或供应商原始响应。真实项目联调、实际转发服务的日志与响应头、移动 Safari／Chrome 及桌面采集仍须独立验收；合成音频应覆盖普通话、英语和混合收支，模拟录音不能替代真实设备检查。

部署需同时更新 web、bootstrap 与 Agent 镜像并执行 `prisma migrate deploy`；本人处理选择、语音受理事实和共享额度使用增量迁移承接，存量选择默认关闭，现有生产库不 seed。自然语言协议为 `natural-language-entry.v2`，分类与交易均带明确类型；分类建议协议保持不变。旧成功快照按原笔数／金额展示为支出，旧失败终态不重新受理。旧页面无法显示新版结果时保留待确认 UUID，刷新后查询；新页面也会拒绝清除无法识别结果的 UUID。构建的 Agent 镜像沿用上海日期校验、专用登录、内部认证和无公开端口边界。规则与恢复机制见 [自然语言收支记账](docs/wiki/natural-language-accounting.md)。

## 月度与年度 AI 对账

从记录页点击“AI 对账”进入 `/records/reconcile`，按月／年、账本和归属成员识别重复记录，以及明确关联的退款／报销抵扣。首页不再放完整对账模块，主导航保持三项。原分析报告保留只读；高可信建议默认勾选，不确定项手动选择。

关联提示按同账本、同原成员、同方向、同金额自动分组，按交易时间从早到晚展示，默认只勾选每组第一笔。勾选表示保留，支持多选；其余记录待删除，至少保留一笔，全选则跳过该组。所有组与 AI 建议统一预览和应用，未调整组也按默认选择处理。跨账本／成员、归档或相交选集不能应用，退款／报销的证据门槛保持不变。人工草稿只存当前身份和报告代次绑定的内存，切页返回保留选择，刷新不恢复；跳过的组后续仍可核对。

发起扫描须本人允许 AI。模型接收所选期内日期时间及精度标签、金额、分类、原文备注和来源类型，成员与账本用代号；不发送来源指纹、银行余额、账号邮箱或家庭码。模型只给关联建议，服务端重算金额并核验来源证据，不能凭模型置信度绕过转账／借还款等边界。导入补齐时间不等于精确时间，无法核实是否已抵扣的历史记录不自动改账。

修改预览列出原记录、理由、保留／删除／净额结果，以及整体和分日／分月统计变化。单纯抵扣在完整选集内保持结余，但回写原支出日期会改变各月／日分布。一键应用只处理所选建议；任一涉及记录改动、删除、移账或归档都整批不应用，不跳过冲突项。原来源、归属、日期、备注及 UUID 保留，软删除继续参与来源去重。

`POST /api/reports/reconcile` 使用受保护同源正文完成短提交、共享状态／报告、原会话取消和应用核验。任务提交后锁屏或关闭全部客户端仍在原预算内继续，重开不会自动重发扫描或改账。应用未知时只查询原 UUID；明确拒绝先保存稳定终态，后来的条件恢复不能使原 UUID 生效。旧 `/api/reports/analyze` 新生成返回 `410`，历史读取仍可用。

上下文扫描和跨批候选补扫共用最多 24 批、每批 500 笔／256 KiB、累计 8 MiB、最多 10,000 笔；单批 90 秒、任务含等待总预算 8 分钟、租约 9 分钟且不续租。没有旧消费总结调用；任一超限或失败均不发布部分建议。结果另受 200 项／1,000 笔／64 KiB 上限保护。10,000 笔是硬上限，候选密集或备注较长时可更早超限，不承诺同规模真实模型均能完成。

报告、内部证据和应用回执按家庭加密设置保护。恢复格式 v3 覆盖新增应用回执及删除检查点；旧 v1／v2 按各自固定实体集合验证原 proof 后兼容，不重建会话、在途任务或自动应用能力。正式升级执行增量迁移，不 seed。原 owner 停止证明、受控回收、短请求响应头与全部客户端离开后的隔离运行验证继续适用，见 [AI 对账说明](docs/wiki/ai-bill-analysis.md) 和 [网络检查清单](docs/runbooks/home-network-checklist.md#analysis-runtime-cleanup)。

## Local Ops Admin

Windows 正式启动脚本复用 `web` 镜像，在生产数据库网络内单独运行 OPS 容器，仅发布
`127.0.0.1:32768:3000`。它不属于 Compose 服务，不增加公共入口；私有 env 中须启用 OPS 并配置口令哈希。
下面的 Node.js 命令保留用于主机本地手动运行，不能与容器 OPS 同时占用 `32768`：

The ops admin is a local-only operations and account-security dashboard. Start it on loopback with private runtime values:

```powershell
$env:OPS_ADMIN_INSTANCE = "true"
$env:OPS_ADMIN_ENABLED = "true"
$env:OPS_ADMIN_PASSWORD_HASH_BASE64 = "<base64-argon2-hash>"
$env:DATABASE_URL = "<private-database-url>"
$env:AUTH_SECRET = "<private-auth-secret>"
npm run build
npm run ops
```

Open `http://127.0.0.1:32768/ops` from the same machine. Do not publish `32768` through nginx, compose ports, frp, or any public tunnel.

The OPS dashboard shows runtime activity plus household member accounts and active app sessions. An OPS admin can reset a household member password and revoke that member's active sessions, or revoke a single session. Password reset requires a second on-page confirmation and then signs out that user's sessions. OPS also issues and revokes email-bound platform invitations; the invited person verifies the address to create their own account and household. OPS does not directly add or delete users, manage the OPS admin password itself, create categories, impersonate users, or modify ledger transactions.

OPS 同时处理已完成邮箱确认的注册申请：批准后自动发送平台邀请，拒绝后发送不含理由的简短通知。审批结果与邮件发送状态分别显示，邮件失败时由 OPS 明确重试；重试不重复审批，也不恢复旧失败凭据。申请审批仍仅在独立本机 OPS 中进行。

Active sessions are server-side `AppSession` rows. The displayed device label is derived from `userAgent`; the app does not record IP addresses, MAC addresses, hardware device IDs, or browser fingerprints.

Generate the admin password hash locally with a private password:

```powershell
$hash = node -e "const argon2=require('argon2'); argon2.hash(process.argv[1]).then(console.log)" "<private-admin-password>"
$env:OPS_ADMIN_PASSWORD_HASH_BASE64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($hash))
```

`OPS_ADMIN_PASSWORD_HASH` is also supported for direct process env usage. Prefer
`OPS_ADMIN_PASSWORD_HASH_BASE64` in env files so `$` characters in argon2 hashes
cannot be expanded by env loaders.

## 账号、家庭与邮件

账号入口为 `/account`，家庭管理为 `/account/household`；无家庭的已登录账号仍可管理本人邮箱、密码、会话及 AI／语音选择，或办理停用。存量邮箱初始未验证，原账号、密码和账目保持不变。本人可验证原邮箱，或通过当前密码申请换绑；找回密码仅对已验证邮箱生效，改密、恢复和成功换绑后需重新登录。

需要重新登录的身份更新在业务事务内立即撤销旧 `AppSession`，先返回重新认证结果；浏览器清理本机密钥和身份草稿后，再由 `finishReauthenticationAction` 清除 Cookie 并跳转到固定的 `/login?reason=account-updated`。不要在返回重新认证结果的同一 Server Action 内修改登录 Cookie：这会触发当前受保护页面重渲染，使 `session-expired` 与成功跳转竞争；客户端也不再对旧账号页执行 `router.refresh()`。Cookie 收尾的延后不延长旧会话授权。

平台注册邀请由本机 OPS 直接签发，或在批准已验证邮箱的申请后自动签发，接受后建立独立家庭、负责人及默认账本；家庭负责人发送另一种邀请，只加入明确的现有家庭。已有账号须本人登录、受邀邮箱已验证且无有效家庭身份，才能复用账号创建／加入。邀请七天有效，新账号待完成注册验证三十分钟有效；最后负责人退出须先在家庭管理页明确关闭家庭。

公开申请入口为 `/help`，填写邮箱并可选填最多 80 字的多行说明，帮助管理员识别申请人。说明去除首尾空白，空白按未填写处理，超长时提示修改；说明绑定本次确认链接，本人确认后才随申请进入 OPS 待处理列表，并在审批后保留。历史申请和已发出的旧确认链接允许没有说明，OPS 显示“未填写”；说明仅在受保护的本机 OPS 中以纯文本展示，不进入邮件、URL、日志或审计正文。邮箱先去除首尾空白并转为小写，同一规范化邮箱同时最多一份 `PENDING` 申请，重复提交不能覆盖原说明。处理完成后允许再次申请，但每次都须重新邮件验证。匿名响应统一说明条件受理，不透露账号、申请或审批状态，也不承诺已送达。

批准／拒绝与通知发送分别记录；失败邮件不会撤回已经完成的审批。OPS 可明确重试失败通知，涉及平台邀请时使用新凭据并保持旧失败链接失效，不能重复审批或直接建立账号、家庭。注册申请不会绕过现有账号状态、有效家庭身份、邀请消费或会话授权规则；申请、确认和通知受共享限流与有界待处理容量保护。

本人停用账号与负责人关闭家庭都需当前密码及明确确认。停用结束本人有效家庭身份并撤销登录及恢复凭据；负责人须先转让身份，或单独关闭家庭后再停用。关闭家庭结束其所有成员的家庭访问并撤销未使用邀请，其他成员账号仍可登录账号页。两种操作均保留历史成员、共同账目及长期导入来源；重新加入使用新成员身份，不能恢复旧会话或旧任务。账号重新启用通过私下核实及逐次授权的受控流程申请，密码找回不会启用停用账号。

永久删除与数据恢复按[账号与数据申请](docs/runbooks/account-data-requests.md)核实处理，停用或关闭本身不授权清空账目。朋友试用开放仍以 spec 要求的完整回归、安全审查、实际备份恢复、真实入口及供应商／转发边界和容量检查为门槛；实际邀请只发送给明确指定的受邀对象。

在未跟踪的开发 `.env.local` 或生产 `.env.production.local` 中配置以下变量；真实邮箱、授权码、入口和供应商地址不进入跟踪文件：

| 变量 | 内容 |
| --- | --- |
| `APP_PUBLIC_ORIGIN` | 可信应用 HTTPS 根 origin，例如 `https://<domain>`；禁止路径、用户凭据、查询和 fragment |
| `SMTP_HOST` | 供应商 SMTP 主机 |
| `SMTP_PORT` | 供应商加密端口，例如 `465` |
| `SMTP_SECURE` | 隐式 TLS 使用 `true`；STARTTLS 使用 `false`，生产仍强制升级 TLS |
| `SMTP_USER` | 完整发信邮箱地址 |
| `SMTP_PASSWORD` | 供应商生成的授权码／专用 SMTP 凭据 |
| `SMTP_FROM_EMAIL` | 与发信账号一致的发件邮箱地址 |

Compose 仅将邮件变量注入 web，Windows 正式启动脚本也将其注入独立本机 OPS；不传给 Agent、镜像构建或浏览器，启动日志遮盖文件和进程 env 值。web 的 `AUTH_URL` 同时从 `APP_PUBLIC_ORIGIN` 派生，使原生认证表单保持在可信 HTTPS 根入口；无需另配不同的认证源。手动启动 OPS 需要自行加载同一私有运行环境。配置不完整或发送失败会拒绝实际投递；公开注册申请、找回／换绑入口只返回条件受理，不暴露目标账号是否存在，也不声称已经送达。

普通身份邮件每个目标最多每小时五封且间隔至少一分钟，身份操作有共享全局预算。公开申请的请求、邮件确认和确认信发送使用独立额度，不消耗正常身份请求或收件人发信额度；表单提交后显示六十秒重新提交倒计时，具体额度与窗口见[公开注册申请与 OPS 审批](docs/wiki/households-and-ledgers.md)。SMTP 最多两个跨进程并发，其中公开申请确认信最多占用一个，单次发送有二十五秒总时限。申请确认、邀请、验证与恢复凭据均绑定用途、短期有效、一次消费，持久化时只保存摘要。邮件链接凭据位于 fragment，页面立即清理并只在内存持有，经用户确认的 POST 才消费；不得将完整链接放入日志、截图、诊断或第三方分析。开发／e2e 仅对 loopback SMTP fixture 允许非加密运输，生产验证 TLS 证书。

邮件收发沿用已有用户验收，只有发信配置或相关边界变化时补验；实际 HTTPS 入口仍须核验。后续增量迁移不执行 seed；发布前备份须实际恢复并核对旧字段、历史归属及统计。账号／家庭规则见[家庭、成员与账本](docs/wiki/households-and-ledgers.md)。

## 依赖安全维护

安全更新优先保持框架主版本，只升级相关依赖。以下定点覆盖由 `package.json` 维护；调整时须重新验证实际调用及 Linux standalone 构建，不能只检查审计数量：

| 覆盖 | 原因与兼容边界 |
| --- | --- |
| `next → postcss 8.5.31` | 修复来源映射读取问题，替换旧的 `8.5.14` 覆盖；与项目直接使用的 PostCSS 一致。 |
| `exceljs → uuid 11.1.1` | 修复命名空间 UUID 的缓冲区边界检查，保留 ExcelJS 使用的 CommonJS 无参 `v4()`；固定该兼容版本。 |
| `@prisma/config → deepmerge-ts 8.0.2` | 修复循环对象导致的栈耗尽，保留 Prisma 6 的配置加载方式；以真实配置合并与客户端生成验证兼容性。 |
| `@typescript-eslint/typescript-estree → minimatch 11.0.1` | 限制恶意 glob 的预处理扩增；该调用方仅使用具名 `minimatch` API，验证 lint 与实际 glob 行为，不对旧 CommonJS 调用方全局替换。 |

`zod` 使用 `4.6.7`，修复[超限集合逐元素校验导致内存耗尽](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)；回归直接验证分类建议与自然语言结果的超长数组先被长度上限拒绝。
`src/instrumentation-client.ts` 在客户端校验模块初始化前设置 `jitless`，避免 Zod 的动态编译探测触发生产 CSP；服务端与 Agent 保持原有校验配置。

2026-11-01 完整审计仍有 22 项 moderate，生产依赖单独审计为 8 项 moderate，均无 high／critical。
剩余项全部由同一 [minimatch 公告](https://github.com/advisories/GHSA-g3hv-75wg-m249) 沿 ESLint、ExcelJS 的依赖链传播，实际保留的版本是 `3.1.5` 和 `5.1.9`。
这两个旧版源码不包含公告所述的 `firstPhasePreProcess`／`optimizationLevel` 算法；ExcelJS 现有读取与导出路径也不把业务输入作为 glob pattern，归档使用 `append/file`。
上游公告仍将这些版本列入范围，不能视为官方豁免；现有调用方依赖 callable CommonJS 默认导出，而修复版 `11.x` 已改为具名导出，禁止为清零审计而全局覆盖、降级 ESLint 或移除导出能力。
保留告警并跟踪上游的范围更正、兼容补丁或调用方升级，后续替换需同时复验 lint、账单读取及 Excel 导出。

## Verification

During development, run the smallest command that proves the change:

```powershell
npm run lint
npm run test:unit
npm run test:integration
npm run test:e2e
```

Pass a specific test file after `--`, for example `npm run test:unit -- tests/unit/money.test.ts`, `npm run test:integration -- tests/integration/create-transaction.test.ts`, or `npm run test:e2e -- tests/e2e/create-expense.spec.ts`. A development checkpoint on a task branch requires full lint, affected tests, a security review, and synchronized versions. It does not authorize merging, pushing, or publishing. Before merging into or committing directly on `master`, pushing, or publishing code/tooling changes, all four full checks must pass. Documentation-only checks follow `AGENTS.md` section 6. Reuse still-valid verification evidence across delivery stages. After a localized failure, rerun the failed files and affected scope, retaining the original run and rerun records to demonstrate complete passing coverage; shared infrastructure changes require reassessing all dependent evidence. A final focused PASS alone is insufficient.

Initialize the dedicated test databases once, and again after adding migrations:

```powershell
docker --context desktop-linux compose -f compose.dev.yml up -d db
npm run test:prepare
npm run verify:full
```

Linux uses `docker compose -f compose.dev.yml up -d db`. `test:prepare` creates missing databases, applies migrations and seeds synthetic accounts; it never drops/resets an existing database or modifies `billboard_dev`. The local PostgreSQL role needs `CREATE DATABASE` permission. Development seed remains `npm run prisma:seed` and is separate from test preparation.

| Suite | Default database | Override in untracked `.env.test.local` |
| --- | --- | --- |
| Integration | `billboard_integration_test` | `INTEGRATION_DATABASE_URL` |
| E2E | `billboard_e2e_test` | `E2E_DATABASE_URL` |

Test configuration loads process variables, then missing values from `.env.test.local` and `.env.example`; application `DATABASE_URL`, `.env` and `.env.local` do not choose test targets. Only loopback PostgreSQL URLs with the `public` schema and `billboard_` names ending in the corresponding `_integration_test` / `_e2e_test` suffix are accepted. Both npm commands and direct Vitest/Playwright test execution select their own target. Do not use production data or credentials in test configuration.

`verify:full` runs lint and unit tests first, then integration and E2E concurrently on their separate databases. Unit tests use at most four workers to avoid CPU contention between crypto, import and security scans. Each database suite still runs files serially; concurrency inside individual integration cases is retained. Do not raise database-suite worker counts without further isolation, or run two copies of the same database suite simultaneously. Playwright starts its own Next dev server at `http://127.0.0.1:2501`, leaving the regular development server on port `2500` alone; port `2501` must be free before E2E starts. E2E setup and teardown clear only the configured E2E database's transactions, import drafts/mappings and task/resource tables. The development and integration databases are not cleanup targets.

Every lint/test command records wall-clock time and exit status in ignored `tmp/verification/<run-id>/summary.json`; full runs include the ten slowest test files. Vitest file durations cover tests/hooks, while Playwright durations sum attempts, including retries; startup, compilation and suite cleanup are included in wall-clock time, not assigned to individual files. Parallel file durations must not be added together to infer wall-clock time. `tmp/verification/latest.json` contains the last completed run and can be a focused run: check `mode`, `scope`, `passed`, and the actual source changes before using any evidence. Reports contain no command arguments, environment values, test bodies or stdout/stderr. They are observations, not a test cache; filters, failures and interrupted runs cannot satisfy full verification. The full entry rejects command-line filters/overrides; Vitest and Playwright also reject committed `.only` cases. Use file/name filters for focused development checks.

如果 Prisma 报 `P1001`，先检查 `docker --context desktop-linux info`、
`docker --context desktop-linux compose -f compose.dev.yml ps` 和 `127.0.0.1:5432` 的端口占用，
确认 `.env.local` 未残留旧隧道端口。不要把测试连接改到生产库。

数据库协议层验证：

```powershell
$env:DATABASE_URL = "postgresql://billboard:billboard@127.0.0.1:5432/billboard_dev?schema=public"
'SELECT 1;' | npx prisma db execute --stdin --schema prisma/schema.prisma
```

## Operations Docs

- `docs/runbooks/home-network-checklist.md`: production home-network launch checklist.
- `docs/runbooks/restore.md`: restore procedure for a rebuilt or replacement machine.
- `docs/runbooks/podman-to-docker.md`：Podman 到 Docker Desktop 的数据迁移、核验和回退步骤。
- [账号与数据申请](docs/runbooks/account-data-requests.md)：重新启用、永久删除及数据恢复的身份、范围、授权和备份边界。
- `docs/superpowers/specs/` and `docs/superpowers/plans/`: historical design and implementation records.
