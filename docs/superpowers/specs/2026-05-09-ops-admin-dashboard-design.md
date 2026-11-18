# 本机后台运维与账号安全管理设计

2026-05-20 更新：`v1.4.1` 保留直接进程 env 的 `OPS_ADMIN_PASSWORD_HASH` 支持，但 env 文件优先使用 `OPS_ADMIN_PASSWORD_HASH_BASE64`。原因是 argon2 hash 包含 `$`，容易被 env 加载链路展开成损坏值。`v1.11.0` 将公网入口改为 nginx 根路径入口；后台仍只允许 `127.0.0.1:32768` 本机访问，不通过 nginx、frp 或 compose 暴露。

2026-05-16 更新：后台从纯只读看板扩展为“运维 + 账号安全管理”。OPS 管理员可以重置家庭成员账号密码、撤销该用户全部应用 session，或单独撤销某个应用 session。后台仍不管理 OPS 口令本身，不新增/删除用户，不修改分类或家庭账本交易。

## 背景

BillBoard 需要一个后台管理页面，用于本机查看服务运行、家庭账本活跃情况，并处理少量账号安全操作。后台只服务本机运维，不进入主应用导航，也不承担通用多用户管理系统职责。

## 假设

- 后台只在本机使用，通过独立 Next 运行实例监听 `127.0.0.1:32768`。
- 公网入口走 nginx 根路径到 `web:3000`，不代理后台端口。
- 后台认证使用独立口令哈希，不复用家庭账号登录态。
- 第一版事件保留 90 天，只记录轻量应用内事件和非敏感摘要。
- 家庭成员登录只校验账号密码和登录限流，不再使用设备白名单、设备凭据或请求设备校验。
- 登录成功后创建 server-side `AppSession`。后续请求统一校验该 session 未过期、未撤销，再从 session 派生 `householdId` 和 `memberId`。

## 目标

- 提供本机运维看板，查看应用在线状态、数据库连接状态、今日登录、今日访问、7 日事件趋势、今日关键动作、运行信息和最近事件。
- 按家庭/成员展示家庭成员账号和当前活跃应用 session。
- 允许 OPS 管理员直接重置家庭成员账号密码；新密码至少 8 位，提交前需要二次确认。
- 重置密码成功后撤销该账号全部活跃应用 session。
- 允许 OPS 管理员单独撤销某个应用 session。
- 记录最小 OPS 审计日志，并在后台显示最近 50 条安全操作。
- 记录登录、页面访问、交易新增/编辑/删除、导入草稿上传、导入确认等轻量事件。
- 确保事件表不会记录金额、备注、上传文件名、邮箱、真实公网入口、公网 IP、source fingerprint、原始导入行或密码相关数据。
- 后台入口显式启用，默认不开启，不进入主应用导航。

## 非目标

- 不管理 OPS 管理员口令；OPS 口令只通过私有 env 维护。
- 不新增或删除家庭成员账号。
- 不提供分类或交易的后台修改能力。
- 不记录请求级访问日志、状态码、耗时或 IP。
- 不使用 MAC 地址、硬件设备 ID、浏览器指纹或 IP 作为登录准入。
- 不新增远程日志、遥测或第三方分析服务。

## 架构

后台作为同代码库中的独立运行入口实现。主应用实例继续服务家庭记账页面；后台实例使用同一份构建产物，但以后台环境变量启动，并绑定到 `127.0.0.1:32768`。

应用登录仍使用 NextAuth JWT session，但 JWT 只作为客户端持有的会话外壳。登录成功时创建 `AppSession` 数据库记录，并把应用 session id 写入 JWT。每次受保护请求都要回查 `AppSession`，确认 `revokedAt: null` 且 `expiresAt` 晚于当前时间；通过后使用数据库中的 `User -> HouseholdMember` 关系派生 `householdId` 和 `memberId`。

OPS 后台安全操作写入 `OpsAuditLog`。审计日志只记录操作类型、`ops-admin` 操作者标识、目标用户/session id、摘要和时间，不记录明文密码、IP、MAC、硬件 ID、浏览器指纹或真实公网入口信息。

后台实例建议使用显式环境变量：

- `OPS_ADMIN_INSTANCE=true`：声明当前进程是后台实例。
- `OPS_ADMIN_ENABLED=true`：允许服务后台页面。
- `OPS_ADMIN_PASSWORD_HASH_BASE64=<base64-argon2-hash>`：后台口令哈希的 base64 形式，适合放入未跟踪 env 文件或私有部署配置。
- `OPS_ADMIN_PASSWORD_HASH=<argon2 hash>`：只建议用于直接进程 env，仍作为兼容路径支持。
- `DATABASE_URL=<private database url>`：连接当前应用数据库。
- `AUTH_SECRET=<private auth secret>`：用于现有 Next/Auth 运行要求，并可复用为后台 cookie 签名材料。

建议新增 `npm run ops` 或等价启动脚本，执行 `next start --hostname 127.0.0.1 --port 32768`。主应用实例默认不设置 `OPS_ADMIN_INSTANCE` 和 `OPS_ADMIN_ENABLED`，因此访问 `/ops` 返回不可用或 404。后台实例只允许 `/ops`、`/ops/login`、`/ops/logout`、Next 静态资源和必要的图标资源；普通应用路径不作为后台实例的产品入口。

生产 compose、nginx 和 frpc 不发布、不代理 `32768`。Windows 本机启动脚本如需支持后台，应只创建 loopback 监听，不创建公网映射。

## 后台认证

访问 `/ops` 时，如果没有后台会话，显示后台口令登录页。提交口令后使用 `argon2.verify` 校验解析后的 OPS 口令哈希；优先接受形态正确的 `OPS_ADMIN_PASSWORD_HASH`，否则从 `OPS_ADMIN_PASSWORD_HASH_BASE64` 解码。校验成功后写入仅后台使用的 httpOnly cookie；退出后台时清除 cookie。

后台认证只证明访问者知道本机后台口令，不代表家庭成员身份。后台可以执行有限账号安全操作：重置家庭成员账号密码、撤销该用户全部应用 session、撤销单个应用 session。后台不能调用家庭账本交易、分类或导入写入动作。

配置缺失时显示明确但不泄密的错误：

- 缺少 `OPS_ADMIN_ENABLED`：后台未启用。
- 缺少可解析的 OPS 口令哈希：后台口令未配置。
- 口令错误：后台口令不正确。

## 事件模型

新增 `AppEvent` 表，保存轻量应用事件。

建议字段：

- `id`
- `eventType`
- `householdId`
- `memberId`
- `path`
- `summary`
- `metadata`
- `createdAt`

`householdId` 和 `memberId` 在可以从已认证家庭 session 得到时写入；登录失败这类事件可以为空。`metadata` 必须走白名单，只允许 `source`、`transactionType`、`count` 等非敏感摘要。

第一版事件类型：

- `login_success`
- `login_failed`
- `page_view`
- `transaction_created`
- `transaction_updated`
- `transaction_deleted`
- `import_draft_uploaded`
- `import_confirmed`

写入新事件时顺手清理早于 90 天的事件，避免新增定时任务。事件写入失败不能阻断登录、记账、编辑、删除或导入流程。

## 应用 Session 模型

新增 `AppSession` 表，作为应用请求的可撤销 server-side session。

核心字段：

- `sessionKey`：服务端生成或从 JWT `jti` 派生的唯一 key。
- `userId`：关联家庭成员账号。
- `userAgent`：仅用于展示设备/浏览器名称，旧 session 缺失时显示 `Unknown`。
- `loginAt`
- `lastSeenAt`
- `expiresAt`
- `revokedAt`

活跃 session 定义为 `revokedAt: null` 且 `expiresAt` 晚于当前时间。`lastSeenAt` 至少间隔 5 分钟才更新一次，避免每个请求都写数据库。被撤销 session 下次请求会跳转登录页，并提示“登录已失效，请重新登录。”

不保存 IP 地址，不尝试读取 MAC 地址、硬件设备 ID 或浏览器指纹。设备名称只由 `userAgent` 自动解析，例如 `Chrome on Windows`、`Safari on iPhone` 或 `Unknown`。

## OPS 审计模型

新增 `OpsAuditLog` 表，保存最小安全操作审计。

第一版操作类型：

- `RESET_USER_PASSWORD`
- `REVOKE_USER_SESSION`
- `REVOKE_USER_SESSIONS_AFTER_PASSWORD_RESET`

后台页面显示最近 50 条审计记录。因为 OPS 后台当前只有共享口令，没有具名管理员身份，`operator` 固定记录为 `ops-admin`。

## 埋点位置

- 登录成功和失败：`src/auth.ts`。
- 页面访问：`/home`、`/add`、`/records`、`/records/import` 的 server component。
- 新增记录：`src/app/(app)/add/actions.ts` 成功创建后。
- 编辑和删除：`src/app/(app)/records/actions.ts` 成功后。
- 导入草稿上传和确认：`src/app/(app)/records/import/actions.ts` 成功后，或对应 draft 服务成功返回后。

埋点只保存动作摘要。交易事件不保存金额、备注或交易 id；导入事件不保存文件名、原始行、账号标识或 source fingerprint。

## 看板内容

后台首页为单页运维界面：

- 顶部状态：应用在线、数据库连接、今日登录、今日页面访问。
- 7 日趋势：按 `Asia/Shanghai` 日期聚合 `login_success`、`page_view`、关键动作总数。
- 今日关键动作：新增、编辑、删除、导入确认计数。
- 运行信息：应用版本、事件保留天数、后台绑定地址、当前环境。
- 最近事件：成员名、动作、页面或安全摘要。
- 用户与设备：按家庭/成员展示账号、状态、活跃 session、设备/浏览器、登录时间、最近活跃时间、过期时间，并提供重置密码和踢下线按钮。
- 最近安全操作：显示最近 50 条 `OpsAuditLog`。

最近事件示例：

- `老公 访问 首页`
- `老婆 新增支出记录`
- `老公 确认导入 支付宝 24 笔`

页面不继承主应用 `BottomNav` 或 `DesktopNav`。视觉风格保持 BillBoard 的清爽直接，但信息密度更接近运维仪表盘。

## 数据查询

看板查询使用只读 Prisma 查询：

- 数据库健康检查使用最小查询，例如 `SELECT 1` 或 Prisma 等价能力。
- 今日和 7 日范围统一按 `Asia/Shanghai` 计算。
- 成员显示名从 `HouseholdMember` 读取，不能信任事件 metadata 中的成员名。
- 用户与设备列表从 `Household -> HouseholdMember -> User -> AppSession` 查询，session 只展示未撤销且未过期的记录。
- OPS 审计列表按 `createdAt desc` 取最近 50 条。
- 查询失败时页面显示错误状态，不触发任何账本写入。

## 错误处理

- 数据库不可用：显示后台框架和“数据库连接失败”。
- 事件查询失败：显示对应区域错误，不影响其他静态运行信息。
- 埋点写入失败：吞掉错误或记录到服务端日志，不影响主流程。
- 后台 cookie 无效：回到后台口令页。
- 应用 session 被 OPS 撤销或过期：跳转 `/login?reason=session-expired`，显示“登录已失效，请重新登录。”
- 重置密码表单缺少二次确认、密码不足 8 位或两次输入不一致：不执行改密，回到 `/ops`。

## 测试计划

- 单元测试：后台口令哈希校验、应用 session 设备名称解析、`lastSeenAt` 5 分钟节流、事件 metadata 白名单、90 天清理范围、`Asia/Shanghai` 聚合边界。
- 集成测试：事件写入不阻断主流程、看板聚合只读查询、后台配置缺失/口令错误/成功登录、应用 session 创建/撤销校验、OPS 改密撤销 session、OPS action 在后台禁用时失败关闭。
- E2E 或 Playwright smoke：后台实例在 `127.0.0.1:32768/ops` 可打开，口令登录后显示概览。
- 文档和安全扫描：检查命令、环境变量、真实入口标识和凭据占位。

## 安全检查重点

- `podman-compose.yml` 不默认发布 `32768`。
- nginx 不代理 `/ops` 或 `32768`。
- README 和 runbook 只能写占位 env，不写真实口令、哈希、域名、公网 IP 或私有服务地址。
- 事件表不保存财务敏感内容或导入原始内容。
- `AppSession` 不保存 IP、MAC、硬件 ID 或浏览器指纹。
- OPS action 只能重置家庭成员密码和撤销应用 session，不能绕过家庭数据写入权限。
- OPS action 必须验证后台已启用、已配置口令哈希、当前请求带有效后台 cookie。
