# Home Network Checklist

Use this checklist before exposing the production stack to the public internet.

## Secrets and Bootstrap

- Set a real `AUTH_SECRET` before starting the public stack. The production `web` container refuses to start with the placeholder value.
- Set a real `POSTGRES_PASSWORD` before starting the production stack. The production startup paths reject the default example password.
- 在私有 env 配置随机 `IMPORT_AGENT_TOKEN`（至少 32 个字符），仅供 web 与 Agent 的分类／自然语言解析端点验证内部请求；它与 WheelMaker API Key 分开，不发送给 Hub。
- “反馈卡顿”与诊断 Agent API 已下线。首次应用删除诊断表的迁移前，按 README 停止旧 web 与独立 OPS 并核验私有备份；迁移后确认诊断表不存在，其他业务数据保留。
- `import-agent` 统一调用 WheelMaker Hub（Codex）Responses API。在私有 env 设置 `WHEELMAKER_BASE_URL` 为 HTTPS `/v1` Base URL（示例 `https://chat-api.example.com/v1`）和 Hub 签发的 `WHEELMAKER_API_KEY`；`IMPORT_AGENT_MODEL` 默认 `gpt-6-luna`，`IMPORT_AGENT_REASONING_EFFORT` 默认 `high`。修改后重启 `import-agent`。地址和 Key 只传给 Agent 容器，不传给 web、OPS、浏览器或构建参数；不再需要 BillBoard 设备登录或旧供应商／回退配置。
- 启用长按语音时，在私有 `.env.production.local` 配置豆包语音控制台创建的 `VOLCENGINE_ASR_API_KEY`，确认所属项目已开通录音文件识别 2.0，固定资源为 `volc.seedasr.auc`。同时设置 `VOICE_AUDIO_PUBLIC_ORIGIN` 为供应商可访问的 HTTPS 根 origin，例如 `https://<domain>`，不含账号、路径、查询参数或 fragment；`APP_BASE_PATH` 保持根路径。两项仅注入 web，不注入 Agent、OPS 或构建参数；不打印真实值或完整 Compose 配置。未配置时文字和手工入口保持可用。
- Keep real `SEED_USER_*` emails and passwords only in private environment files, such as `.env.production.local`; tracked files may contain placeholders only.
- 第二期账号邮件使用私有 `APP_PUBLIC_ORIGIN` 和 `SMTP_*` 配置，完整字段见 [README](../../README.md#账号家庭与邮件)。可信入口限定当前 HTTPS 根入口，生产 SMTP 必须校验证书；web 与本机 OPS 共用两个发信名额，不向 Agent 或构建注入。开放前核验真实发信；SMTP 受理与实际收件分别记录，不能用受理结果承诺进入收件箱。
- Compose 将 web 的 `AUTH_URL` 设为同一 `APP_PUBLIC_ORIGIN`；实际容器须收到该值，不能仅以私有 env 文件存在为证据。只读访问实际 HTTPS `/api/auth/signout` 确认页，核验表单 action 与可信入口同源，不用真实账号提交退出作为发布探针。
- Keep the local OPS admin password hash private. In env files prefer `OPS_ADMIN_PASSWORD_HASH_BASE64`; use `OPS_ADMIN_PASSWORD_HASH` only for direct process env. The OPS admin must stay on loopback at `127.0.0.1:32768`.
- 若确认生产账号或秘密已泄露，按 `AGENTS.md` 事故规则下线止损、轮换受影响凭据并验证旧凭据失效；不要借迁移执行全库 seed 或重置未受影响账号。
- Windows 安装并启动 Docker Desktop（Linux containers），命令显式使用 `docker --context desktop-linux`；Linux 安装 Docker Engine 与 Compose 插件。当前配置文件为 `compose.yml`、`compose.dev.yml`。
- 当前生产公网链路为 `HTTPS 域名转发服务 -> frps remote 3000 -> frpc -> 本地 127.0.0.1:3000 -> web:3000`，应用使用根路径，远端未部署 nginx。`ops/nginx/billboard-location.conf` 仅为可选自管代理示例。
- Windows Docker Desktop 本机健康检查使用 `127.0.0.1:3000 -> web:3000`，不经过 SSH 隧道。
- 先恢复未跟踪的 `.env.production.local`。Linux 直接使用 Compose 时，其中的 `DATABASE_URL` 必须指向容器网络 `db:5432`，用户名、密码和库名须 URL 编码；Windows 正式启动脚本自动构造该值。
- 仅首次部署且目标库为空时，构建镜像并用 bootstrap 默认命令初始化账号和分类：
  `docker compose --env-file .env.production.local -f compose.yml build web bootstrap import-agent`
  `docker compose --env-file .env.production.local -f compose.yml up -d db`
  `docker compose --env-file .env.production.local -f compose.yml --profile bootstrap run --rm bootstrap`
- 已有生产库的发布只执行 `npx prisma migrate deploy`，不得执行 seed。Windows 使用下文启动脚本；Linux 按 README 的“构建、数据库、迁移、web”顺序执行。
- 旧 Podman 服务迁移遵循 `docs/runbooks/podman-to-docker.md`；从备份恢复遵循 `docs/runbooks/restore.md`，都不走新库 bootstrap seed 路径。

## Domain and DNS

- Confirm you control the production domain or subdomain for BillBoard.
- 真实 hostname、TLS 和转发目标仅保存在私有域名转发服务／frp 配置中；跟踪文件只含占位符。
- 按实际转发服务要求配置 DNS 和 HTTPS 根路径代理，确认页面直接来自应用，不使用跳转或 iframe 包装。服务名称及其日志控制能力仍须按实际配置核验。
- 如实际转发目标地址变化，按对应服务要求更新 DNS 或转发目标，不假定必须由本机接收公网 `80/443`。

## Ingress and Routing

- 核验域名转发服务能连接 frps 的 remote `3000`，frpc 使用 TCP 将该端口转发到 Windows loopback `3000`；应用容器仍只发布 `127.0.0.1:3000:3000`。
- 按转发服务真实来源核验并最小化远端 `3000` 的防火墙／访问范围，不能声称已对公网封禁，也不能直接套用仅允许远端 loopback 的假设。检查 frp 控制连接与代理健康状态，不输出真实地址或 token。
- 保留现有域名转发/frpc 链路，不增加本机直连公网端口、容器端口发布或不必要的路由器转发。
- Do not expose PostgreSQL to the internet.
- `import-agent:3100` 只供容器内部访问，不配置 nginx、frpc 或主机端口。Agent 与数据库分属不同网络，仅 web 连接两侧；Agent 的独立出站网络用于请求 WheelMaker API。每次模型调用使用 `ephemeral: true`、`store: false` 的独立请求，不复用 Session ID、不自动重试或回退。分类和自然语言任务不附加历史账本；AI 对账只提供用户明确选择期间／查看范围的明细、必要来源与精度标签，不发送消费比较期摘要、指纹、银行余额或导入原始行。
- 单批 Agent 总预算 45 秒，应用等待上限保持 55 秒，自然语言请求租约保持 75 秒；独立核验实际域名转发服务的请求超时，不套用 nginx 默认值或无证据延长应用预算。取消由 BillBoard 传播并等待本地请求／清理结束，Hub 负责停止或隔离运行器；现有 API 没有远端清理完成查询，不宣称两侧释放具有严格先后保证。核验迟到结果拒绝和本地清理后释放，不以固定延迟代替清理。
- AI 对账沿用独立 Astra 配置，单批最多 90 秒，完整上下文及跨批候选补扫共最多 24 批，不再调用消费总结，共享 AI 租约 9 分钟但整个任务含取数及窗口等待最多 8 分钟，不延长原分类和记账时限。`POST /api/reports/reconcile` 返回短 JSON 提交回执，进度和报告通过正文短查询读取；公网连接无需承载整个生成过程。实际入口须核验受保护短查询的认证边界和 `no-store`/`no-referrer`，同源校验、受理及后台生命周期通过隔离虚构家庭和真实自托管应用验证，不能只用登录页健康检查代替业务验收。以受控 Agent 延迟覆盖全部客户端离开后完成、超时与显式取消，记录非敏感时长/状态，不记录正文或真实入口；不新增公开探测端点。对账请求、应用选集及返回正文含财务信息，外部日志不得采集。
- 录音及家庭码本机扫码须通过 HTTPS 安全上下文；应用在 `next.config.ts` 提供 `Permissions-Policy: camera=(self), microphone=(self), geolocation=(), payment=(), usb=()`，仅允许同源页面按需请求摄像头／麦克风授权，前置转发服务不得覆盖为禁用。扫码不上传画面，拒绝摄像头仍可粘贴家庭码。音频下载端点保留 `no-store`、`nosniff`、`no-referrer`。
- 应用全站提供 `X-Content-Type-Options: nosniff`、`Referrer-Policy: same-origin`、`X-Frame-Options: DENY`、CSP 和 `Strict-Transport-Security: max-age=31536000`。HSTS 仅在 HTTPS 对当前主机生效，不启用 `includeSubDomains` 或 preload，不扩大其他子域名的 HTTPS 承诺。普通页面不通过 `Referer` 头向跨源导航发送页面地址，同源登录与提交仍可携带来源；账号、邮件链接及下载继续使用更严格的 `no-referrer`。
- `src/proxy.ts` 保持原 cookie-only 登录入口校验，并在页面请求中覆盖客户端传入的 CSP／nonce，生成每次独立的随机脚本 nonce，页面响应禁止缓存。生产拒绝无 nonce 的 HTML 内联脚本、内联事件处理器和 eval；`strict-dynamic` 允许带 nonce 的受信脚本动态加载依赖，不限制这些脚本创建的所有脚本。样式保留内联以兼容图表和动画；连接仅限同源，开发额外允许调试 eval 与热更新 WebSocket。不可在前置服务缓存 HTML、注入脚本或删除／放宽策略。发布时从实际 HTTPS 入口检查 `/login`、账号及未知路径 404 文档的 CSP、脚本 nonce 和缓存，复验登录提交、客户端导航、解析前注入的无 nonce 脚本被拒绝、原语音 Worklet 可加载；同时检查脚本／样式各自的响应头及正确 `Content-Type`，保留敏感路径覆盖策略。
- Next 配置响应头优先于 Route Handler 内的同名头；音频、导出、家庭视图／加密、安装包下载及更新接口的 `no-referrer` 同步列在 `next.config.ts` 的后置规则中。新增或调整敏感接口时须同时核验其真实响应，不能仅检查处理函数返回的 `Response`。
- 在实际 HTTPS 入口核验 `/account-link`、`/forgot-password` 与账号页面的 `no-store`、`no-referrer` 和禁止索引响应头。邮件 fragment 不进入 HTTP 请求；前置服务不能注入第三方统计脚本，也不能把客户端收集的完整链接或凭据送入日志。
- 在真实转发服务及日志采集配置中关闭 `/api/voice/audio`（含尾斜杠路径）的完整 URL、查询参数和音频记录，覆盖正常及失败请求。应用 `no-store`、短 TTL 和本地删除不能关闭外部日志；在服务配置尚未核实时保留待验状态。
- nginx 示例仅供以后选择自管代理时使用：精确音频 location 禁访问／错误日志，尾斜杠直接 404；须核验与应用响应头不冲突，先 `nginx -t` 再重载。当前没有需重载的 nginx，示例测试不能证明真实转发服务具备相同保护。
- 实际转发服务须给现有 20 MiB 账单及 multipart 留出上传空间；可选 nginx 示例使用 `client_max_body_size 25m`。已有更大上限无需降低，禁止把全站改为录音的 2 MiB。语音由 `/api/voice/transcribe` 独立限制 2 MiB、60 秒 PCM WAV，豆包 2.0 `submit/query` 的提交和有界轮询共用 30 秒总预算，与后续记账的 Agent 超时分开。超时、取消或供应商仍处理中均不记账，不承诺秒级完成，也不创建后台转写续作。

## Host Readiness

- 确认 Docker 引擎、Compose 插件可用；Windows 用 `docker --context desktop-linux info` 验证 Linux 引擎。
- Store the production env values in a recoverable private location outside Git, including `AUTH_SECRET`, `POSTGRES_PASSWORD`, optional `APP_BASE_PATH=/`, and the `SEED_USER_*` credentials used for bootstrap or credential rotation.
- Confirm the host firewall allows the selected production entrypoint ports.
- Make sure the machine has reliable storage for PostgreSQL data and backup output.
- web 的 `os.tmpdir()/billboard-voice` 下使用进程私有目录；Linux 生产目录权限为 `0700`、WAV 文件为 `0600`，Windows 开发继承当前用户临时目录 ACL。最多 16 个租约、活动文件总量 32 MiB、TTL 45 秒，完成、取消、过期后删除；启动时及短期延时清理过期遗留文件。Compose 将 `/tmp/billboard-voice` 挂为 `rw,nosuid,nodev,noexec,size=40m,mode=0700` 的 tmpfs，40 MiB 容量包含崩溃遗留文件，不挂持久卷、不备份；不改变当前 web runner 身份。清理保证仅适用于应用侧，不代表供应商留存承诺。

## Emergency Shutdown

- Stop the Windows startup task if it is running: `Stop-ScheduledTask -TaskName "BillBoard Production Startup"`.
- Stop the public ingress first, including `frpc` and any selected router or tunnel mapping for the production hostname.
- Windows 停止正式 Compose 服务：`docker --context desktop-linux compose --env-file .env.production.local -f compose.yml stop`；独立 OPS 容器另行停止：`docker --context desktop-linux stop billboard-ops`（若已启用）。Linux 命令省略 `--context desktop-linux`。
- 如仍有迁移前的 Podman 进程或 SSH 转发占用 `3000`、`32768`，先核验命令行与归属，只停止本项目遗留进程，不能按端口盲目终止其他服务。
- 事故恢复前核验备份和账本保留，按已查明的影响范围更新私有凭据，并确认旧凭据失效；普通发布和引擎迁移不轮换凭据。

## Validation

- 数据准备完成后，Windows 执行 `.\ops\windows\start-production.ps1`；Linux 按 README 发布顺序启动 `web`。
- 核验 frpc 的 `billboard-web` 代理在线、本机 `http://127.0.0.1:3000/login` 可用，再从实际 HTTPS 域名转发入口验证 `/login`；不得用 loopback 检查代替完整链路。
- 在实际转发服务中核验 TLS、远端 `3000` 访问来源、请求超时和日志控制，记录已验证与待验证项；仅凭 HTTPS 200 不能证明这些设置已满足要求。另须确认域名服务到 frps 的回源段使用加密传输或可信网络，不以入口 HTTPS 或来源 IP 限制代替回源机密性验证。
- 发布 AI 对账时，另核验短提交、状态查询、原子应用及未知回执契约和安全响应头，并以隔离测试证明全部客户端断开后仍在原 8 分钟预算内完成；显式取消与原身份撤销仍须停止。服务器重启按中断收敛，不恢复执行；不能以登录页健康检查冒充这些生命周期验收。
- 若以后采用自管 nginx/TLS，再单独核验其 include 和证书配置；遇到 Let's Encrypt `rateLimited` 时等待返回的 `retry after`，不反复重启。
- Confirm login works through the selected production entrypoint.
- 从实际 HTTPS 入口核验 `Permissions-Policy` 包含 `microphone=(self)`；在移动 Safari／Chrome 和桌面浏览器验证授权、采集、松开发送、上滑取消及切后台关闭轨道。仅检查 loopback 页面或模拟录音不证明公网策略和真实设备可用。
- 用合成普通话、英语及中英混合收支录音验证豆包项目权限、异步 submit/query 业务状态和 Agent 解析；确认供应商通过短期能力链接取音频，30 秒预算内未完成时固定失败且不记账。取音频仅依赖随机 256 位 token，`GET/HEAD` 不要求 cookie；链接和本地路径不得出现在前端响应。确认完成、取消、超时后的链接失效、文件删除及 45 秒租约兜底清理。
- 用合成标记和受控正常／失败请求核验真实转发服务及其日志采集不记录音频能力链接，Next.js 开发请求日志也忽略该 URL；其他路径日志保持原策略。检查日志时只报告是否出现合成标记，不输出日志原文、有效 token 或真实入口。生产 Next.js 默认不记录 incoming requests，应用错误保持固定文案；外部服务日志未核实前不能标记通过。
- 确认两阶段不会重复入账、刷新只恢复 UUID、取消转写无后续记账，保留原账单导入上传能力。真实 ASR smoke、实际转发服务与真机录音需分别记录证据，不能用静态示例或模拟测试声称已验收。验证证据不得包含录音、原始转写、能力链接、Key 或真实公网入口。
- Linux 执行 `bash ops/backup/pg_dump.sh ./tmp/backups`；Windows 执行 `.\ops\windows\backup-production.ps1 -BackupDir <private-backup-directory>`，确认生成可读取的 custom dump，并按下文检查计划任务。

<a id="analysis-runtime-cleanup"></a>

## 分析执行者回收

`ResourceExecution` 残留不能按 TTL 删除。AI 对账沿用账单分析的本地执行者 ID、runtime、PID 和启动时间识别所有者；同 runtime 下只有实际进程退出或本地工作/HTTP 清理已结束才可回收。未知 runtime、当前仍运行的实例和普通 HTTP 断连均不能当作已停止证明。

Windows `start-production.ps1` 在替换前静默捕获旧 web 的完整容器 ID、Compose 身份及默认唯一 hostname；替换后确认旧容器确已删除，或在再次核验身份后明确 stop 并确认不运行/不重启，才以 tools 镜像调用回收器。无法核实会保留占用并给出受控错误，不删除当前实例或无关任务，不执行 seed。

Linux/手工维护须由宿主先核对旧完整容器 ID、`billboard` project、`web` service、非 one-off 身份及默认唯一 hostname；确认退休容器停止/删除且不会自动重启之后，才将该 runtime 作为已核实停止证明传给维护入口：

```bash
docker compose --env-file .env.production.local -f compose.yml run --rm --no-deps bootstrap node --import tsx ops/reports/reap-bill-analysis.mjs --stopped-runtime "<confirmed-stopped-runtime>"
```

占位参数必须替换为私有维护现场核实的 runtime，不得照抄、不从浏览器请求取值、不用新实例启动或租约到期代替停止证据。入口只回收匹配分析占用，先将旧任务标为不可再提交、清活动指针并保留报告正文；不会恢复旧 UUID 执行，也不增加 Hub 远端停止确认。结果仅输出回收数或固定错误，真实地址、凭据和财务正文不进入日志。

## Windows Docker Desktop

正式运行入口是 `.\ops\windows\start-production.ps1`。脚本读取 `.env.production.local`，固定使用
`desktop-linux` context；Docker Desktop 未就绪时后台启动并等待 Linux 引擎，不修改全局 Docker context。

现有家庭首次跨入历史成员／默认账本模型，先执行 [第一期迁移](household-ledgers-migration.md)。
可用 `-BuildOnly` 在停机前准备已发布提交的镜像；普通启动遇到尚未迁移的已有家庭会拒绝继续。

- 保留原有 `AUTH_SECRET`、数据库密码、账号密码、诊断 token 和 OPS 哈希；脚本拒绝占位生产密钥。`AUTH_SECRET` 改动会使现有 JWT cookie 失效。
- `VOLCENGINE_ASR_API_KEY` 和 `VOICE_AUDIO_PUBLIC_ORIGIN` 随私有 env 载入，由 Compose 只传给 web；启动日志同时遮盖文件值和进程环境中的值，不把它们加入 OPS 启动参数。设置或更新后重新启动 web；脚本不管理域名转发服务，麦克风策略和能力链接日志保护仍须在实际入口独立核验。
- 从已验证且已推送的干净 `master` 发布。Compose 使用 `default` builder，在明确指定的 `desktop-linux` context 下构建 `web`、`bootstrap` 与 `import-agent` 镜像，并核验提交 SHA 标签；`-SkipBuild` 仅复用当前提交对应的已构建镜像。不要根据独立 `docker build` 的 builder 名称替换 Compose 参数。
- PostgreSQL 保持 `postgres:17`；健康检查通过后执行 `npx prisma migrate deploy`，成功后才启动 `web`，不执行 seed。
- `APP_BASE_PATH=/` 是构建时配置。`Containerfile` 包含 standalone 应用和 `.next/static`，不依赖主机 `.next` 或手动复制静态文件。
- `web` 仅发布 `127.0.0.1:3000:3000`，生产数据库不发布主机端口。开发库由独立 `billboard-dev` project 发布 `127.0.0.1:5432`。
- `import-agent` 以非 root 用户运行，只读根目录、有限内存/进程和临时工作区；不注入数据库／应用密钥，不挂载仓库、主机 HOME、Docker socket 或 Codex 认证卷；升级不删除已有卷数据。镜像须包含分类／自然语言协议及上海日期校验模块，两类任务共用串行处理。`/health` 仅证明进程可用；用合成分类和自然语言输入验证真实 WheelMaker Responses 调用，用隔离 HTTP fixture 验证认证失败、非完成结果、工具／图片输出、畸形 JSON、超限响应、超时及取消，确认迟到结果丢弃和自然语言仅一次提交。Hub 接受输出 token 参数不代表实际限额，须保留应用有界读取。不发送真实账本，不通过删除正式认证或改动正式 Key 制造故障。
- `OPS_ADMIN_ENABLED=true` 时，脚本用相同 web 镜像在 `billboard_default` 网络中单独启动 `billboard-ops`，仅发布 `127.0.0.1:32768:3000`。禁止将 OPS 加入公共 Compose 端口、nginx、frp 或任意公网映射。
- frpc 仍按 `ops/frp/frpc.billboard.toml.example` 将 remote `3000` 转发到 Windows `127.0.0.1:3000`，公网由 HTTPS 域名转发服务提供根路径入口。不再使用容器 IP 或 SSH 转发。
- 本地验证 `/login`、页面引用的至少一个 `/_next/static/chunks/*.js` 和已启用的 `http://127.0.0.1:32768/ops`；然后验证 `curl.exe -I https://<domain>/login --connect-timeout 20`。日志和报告不得包含真实公网入口或凭据。

## Windows Autostart

先完成一次正式发布并确认 `.env.production.local` 可用，再在运行 Docker Desktop 的 Windows 用户会话中注册：

```powershell
.\ops\windows\register-production-startup.ps1
```

任务名仍为 `BillBoard Production Startup`，使用 `AtLogOn` 和 `Interactive`，当前用户登录后运行
`start-production.ps1 -SkipBuild -StayAttached`。注册时替换旧的开机 `S4U` 任务。
Docker Desktop 依赖用户登录会话；这不是无人登录即可启动的服务器方案，不保存 Windows 密码，也不配置自动登录。

Useful checks:

```powershell
Get-ScheduledTask -TaskName "BillBoard Production Startup"
Get-Content .\tmp\logs\production-startup.log -Tail 80
Invoke-WebRequest http://127.0.0.1:3000/login -UseBasicParsing
netstat -ano | Select-String -Pattern ':3000 '
```

`LastTaskResult` 为 `267009` 表示任务正在运行；`-StayAttached` 用于保持运行监测，不再守护 SSH 隧道。
任务失败时先查看日志、Docker Desktop Linux 引擎以及当前工作树和已发布镜像 SHA，不要回退到旧 Podman 自启动。

## Windows Backups

Windows 备份使用 `.\ops\windows\backup-production.ps1 -BackupDir <private-backup-directory>`，
先在 `tmp/backups` 生成并通过 `pg_restore --list` 核验 custom dump，再复制到目标目录或私有 NAS。
NAS 不可用时命令返回非零并保留本地备份；脚本不删除旧备份。备份含家庭账本数据，必须保存在未跟踪的私有位置。

已有 `BillBoard Daily Backup` 任务继续调用同名脚本和 `-BackupDir` 参数；检查其执行身份可访问 Docker Desktop
和备份目标，确认最近运行成功，并抽查目标备份，而不是仅确认任务存在。Docker Desktop 未运行或用户会话不可用时，
不能假设备份仍会执行。

Linux/Bash 备份和恢复脚本默认加载存在的 `.env.production.local`；可用 `COMPOSE_ENV_FILE` 指定其他私有 env 文件。
Windows 上通过 Bash 调用时显式设置 `DOCKER_CONTEXT=desktop-linux`。不要使用 `docker compose config` 的完整输出记录生产环境变量。
