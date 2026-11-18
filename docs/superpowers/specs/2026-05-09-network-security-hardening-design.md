# 网络安全加固设计

当前状态：本设计已在 `v1.0.8` 完成。2026-05-20 的 `v1.11.0` 后续将公网入口从 Caddy 改为 nginx 根路径入口，并保留“公网不直连 `web:3000`、loopback `3000` 仅供代理/隧道使用”的安全边界。当前运维步骤以 `README.md` 和 `docs/runbooks/home-network-checklist.md` 为准。

说明：下方目标和设计记录的是 `v1.0.8` 当时的加固方案；Caddy 入口细节为历史实现，当前入口以 nginx 根路径和 frpc loopback `3000` 为准。

## 背景

本次加固来自 2026-05-09 的只读网络安全审计。审计未发现未登录即可读写家庭账本数据的问题；主要风险集中在生产网络入口、默认生产数据库密码、安全响应头、登录入口防护和依赖漏洞。

## 目标

- 生产默认不公开直连 `web:3000`，公网入口默认走 Caddy/HTTPS。
- 生产启动拒绝空值、占位值或默认值的关键凭据。
- 为 HTTPS 入口补充基础安全响应头。
- 保留当前 email 维度登录失败锁定，不引入复杂 IP 识别逻辑。
- 小步升级相关依赖，降低 `npm audit` 报告中的已知风险。

## 非目标

- 不新增管理后台、配置页面或泛化安全策略系统。
- 不在本次实现应用内 IP 限流表或代理 IP 解析逻辑。
- 不改变现有账本、导入、认证会话和家庭隔离业务语义。
- 不把真实域名、公网 IP、密码或密钥写入 Git 跟踪文件。

## 设计

### 网络入口

`podman-compose.yml` 的 `web` 服务默认不再发布 `${APP_PORT:-3000}:3000`。`proxy` 服务继续发布 `80` 和 `443`，作为生产默认公网入口。

需要临时直连调试时，通过显式 profile 或覆盖配置启用 `web:3000` 端口发布。该入口默认关闭，避免正式服务在 HTTPS 入口之外保留明文登录通道。

Windows fallback 启动脚本中的 web SSH tunnel 默认绑定 `127.0.0.1:3000`，只供本机健康检查和临时排障。当时的 HTTPS 域名入口使用 `127.0.0.1:8080/8443 -> Caddy:80/443 -> web:3000`，由 frpc 将公网 `80/443` 映射到本机 `8080/8443`。

### 凭据防线

生产启动脚本继续拒绝空的 `AUTH_SECRET` 和已知占位值，并新增 `POSTGRES_PASSWORD` 校验：

- 缺失时拒绝启动。
- 等于 `billboard` 等默认示例值时拒绝启动。
- 等于明显占位值时拒绝启动。

`podman-compose.yml` 中数据库密码不再提供生产可用的默认值；示例值只保留在 `.env.example` 和开发 compose 中。生产文档同步说明必须在未跟踪的 `.env.production.local` 或部署私有配置中设置真实数据库密码。

### 安全响应头

Caddy 作为 HTTPS 入口时统一追加基础响应头：

- `Strict-Transport-Security`：仅对域名 HTTPS 入口生效。
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: same-origin`
- `Permissions-Policy`：关闭不需要的高风险浏览器能力。
- `X-Frame-Options: DENY`

CSP 暂不在本次加入强策略。Next.js App Router 和 Auth.js 客户端脚本可能需要更细的 nonce 或哈希策略；贸然加入容易破坏登录和表单交互。本次先落地低风险安全头。

### 登录入口防护

保留当前 `LoginThrottle` 的 email 维度失败锁定。由于生产流量可能经过 Caddy、frp、Windows SSH tunnel 和 Podman 多层代理，本次不新增应用内 IP 限流，避免错误识别代理地址导致误封或无效限流。

入口级 IP/连接限流作为后续增强记录在文档中，优先放在 Caddy/frp 或云安全组层处理。

### 依赖升级

小步升级：

- `next` 升到当前 16.2.x 最新。
- `prisma` 和 `@prisma/client` 升到当前 6.x 最新。
- 如果 Next 当前稳定版仍精确依赖有 audit 报告的嵌套 `postcss`，使用 npm `overrides` 将该嵌套依赖提升到已修复补丁版。

升级后运行 `npm audit --json`。如果仍有只能通过 canary、降级或大版本迁移解决的报告，本次记录为残余风险，不做破坏性版本跳跃。

## 数据流与错误处理

运行时请求仍按现有路径进入：

浏览器 -> Caddy `80/443` -> `web:3000` -> Auth.js / App Router / Prisma -> PostgreSQL。

默认情况下，浏览器不应直接访问 `web:3000`。Windows fallback 的本机 `127.0.0.1:3000` 只用于脚本健康检查。生产凭据校验失败时，启动脚本直接停止并输出不包含真实密码的错误信息。

## 测试与验证

- 静态检查 `podman-compose.yml`，确认 `web` 默认不发布 `3000`。
- 静态检查 `ops/windows/start-production.ps1`，确认默认 tunnel 不绑定 `0.0.0.0:3000`。
- 静态检查 Caddy 配置，确认基础安全响应头存在。
- 运行 `npm audit --json`，记录升级后的剩余风险。
- 运行完整验证：`npm run lint`、`npm run test:unit`、`npm run test:integration`、`npm run test:e2e`。

## 风险与权衡

- 关闭默认直连 `3000` 后，依赖直连端口的临时访问方式需要显式开启。这是为了换取更清晰的生产入口边界。
- 不加入 CSP 强策略会留下部分浏览器侧加固空间，但能避免本次安全修复破坏登录与客户端交互。
- 不做应用内 IP 限流会保留密码喷洒风险的入口层治理缺口；当前 email 锁定仍能保护单账号暴力破解，入口层限流应作为后续独立任务实施。
