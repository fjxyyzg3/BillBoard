# 家庭主机 + ECS + frp 正式部署设计

日期：2026-05-04

## 1. 背景与目标

本设计定义 BillBoard 的正式部署方案。目标是让两人家庭记账服务可以通过公网域名稳定访问，同时把账本应用和 PostgreSQL 数据库保留在家里机器上，避免把家庭财务数据直接部署到云服务器。

已确认条件：

- 用户有一个阿里云购买的可用域名。
- 用户有一个可用的 ECS 实例。
- 正式入口采用公网域名访问。
- 公网到家庭网络之间使用自建 `frps`/`frpc` 隧道。
- 当前仓库已经具备 `Containerfile`、`podman-compose.yml`、Caddy、PostgreSQL、bootstrap、备份和恢复脚本。

本次部署设计服务于正式上线，不改变 BillBoard 的产品功能。应用仍然保持两人家庭记账、快速记录、按家庭成员视角查看和按时间范围复盘的核心体验。

## 2. 假设

- ECS 只作为公网入口和 frp 服务端，不保存 BillBoard 业务数据。
- 家里机器长期在线，并负责运行 BillBoard 应用、PostgreSQL 和 Caddy。
- 域名可以解析到 ECS 公网 IP。
- ECS 安全组可以放行 `80`、`443` 和 frp 控制端口。
- 家里机器可以主动连出到 ECS。
- 家里机器上可以运行 Podman 和可用的 Compose provider。
- 用户愿意为生产环境设置独立的强密码、真实 `AUTH_SECRET` 和可恢复的环境变量备份。

## 3. 已比较方案

### 3.1 ECS 跑 `frps`，家里机器跑完整生产栈

请求链路：

```text
浏览器 -> 域名 -> ECS:80/443 -> frp TCP 隧道 -> 家里机器:80/443 -> Caddy -> web:3000 -> db:5432
```

优点：

- 业务数据和数据库留在家里机器。
- 复用当前 `podman-compose.yml` 的 `web`、`db`、`proxy` 生产拓扑。
- Caddy 继续负责 HTTPS 证书申请、续期和反向代理。
- PostgreSQL 不需要暴露到公网或 ECS。
- ECS 侧职责简单，主要维护 `frps` 和安全组。

缺点：

- 家里机器、家庭宽带或隧道中断时服务不可用。
- frp 的 TCP 转发必须稳定，并且需要保护控制端口和 token。

结论：选择此方案。

### 3.2 ECS 跑 HTTPS 反代，家里机器只暴露应用 HTTP

请求链路：

```text
浏览器 -> 域名 -> ECS Caddy/Nginx HTTPS -> frp 隧道 -> 家里 web:3000 -> db:5432
```

优点：

- 公网 TLS 入口集中在 ECS。
- 家里机器不需要处理公网证书挑战。

缺点：

- 当前生产 Compose 没有把 `web:3000` 设计成公网入口。
- 需要新增隧道专用 override 或调整生产部署结构。
- 家里与 ECS 之间通常是隧道内 HTTP，边界比方案 3.1 更绕。

结论：暂不采用。它更适合后续需要把公网反代集中到 ECS 的阶段。

### 3.3 应用和数据库全部部署到 ECS

请求链路：

```text
浏览器 -> 域名 -> ECS Caddy -> ECS web -> ECS db
```

优点：

- 不依赖家庭网络在线状态。
- 部署模型更接近常规云服务器部署。
- 不需要 frp。

缺点：

- 家庭账本数据直接放到云服务器。
- ECS 上的数据库安全、备份和系统加固要求更高。
- 与“家庭数据留在家里机器”的目标不一致。

结论：不作为当前正式部署方案。

## 4. 推荐架构

推荐架构为：ECS 运行 `frps`，家里机器运行 `frpc`、BillBoard 生产栈和 PostgreSQL。

公网入口：

- 域名解析到 ECS 公网 IP。
- ECS 安全组放行 `80`、`443` 和 frp 控制端口。
- ECS 上的 `frps` 接收来自家里机器 `frpc` 的连接。
- `frps` 将公网 `80` 和 `443` 的 TCP 流量转发给家里机器。

家庭主机：

- `frpc` 将 ECS 的 `80` 映射到本机 `80`。
- `frpc` 将 ECS 的 `443` 映射到本机 `443`。
- `podman-compose.yml` 启动 `db`、`web` 和 `proxy`。
- Caddy 使用 `APP_DOMAIN` 对应的域名申请和续期证书。
- Caddy 将请求反代到 `web:3000`。
- `web` 通过 Compose 内部网络访问 `db:5432`。

数据库：

- PostgreSQL 只在 Compose 内部网络中被 `web` 和运维脚本访问。
- 不在 ECS、路由器或公网暴露 PostgreSQL 端口。
- 数据持久化在 `postgres-data` volume。

## 5. 域名、TLS 与端口设计

域名：

- 使用一个专用子域名，例如 `billboard.example.com`。
- DNS A 记录指向 ECS 公网 IP。
- 不建议长期使用裸公网 IP 或随机端口作为正式入口。

TLS：

- Caddy 在家里机器上终止 HTTPS。
- frp 对 `80` 和 `443` 做 TCP 透传，不在 ECS 上改写 HTTP 内容。
- Caddy 需要能从公网收到 Let's Encrypt HTTP-01 或 TLS-ALPN-01 验证流量。
- `APP_DOMAIN` 必须与用户访问的正式域名一致。

端口：

- ECS 公网放行 `80/tcp` 和 `443/tcp`。
- ECS 公网或受限来源放行 frp 控制端口，例如 `7000/tcp`。
- 家里机器本地监听 `80/tcp` 和 `443/tcp`，由 Caddy 使用。
- 不暴露 `3000/tcp` 和 `5432/tcp` 到公网。

## 6. 环境变量与密钥

生产环境至少需要维护：

- `APP_DOMAIN`：正式访问域名。
- `AUTH_SECRET`：真实随机密钥，不允许使用 `replace-me`、`change-me-before-launch` 等占位值。
- `POSTGRES_DB`：生产数据库名。
- `POSTGRES_USER`：生产数据库用户。
- `POSTGRES_PASSWORD`：生产数据库密码。
- `SEED_HOUSEHOLD_NAME`：初始家庭名。
- `SEED_USER_A_EMAIL`、`SEED_USER_A_PASSWORD`、`SEED_USER_A_NAME`：账号 A。
- `SEED_USER_B_EMAIL`、`SEED_USER_B_PASSWORD`、`SEED_USER_B_NAME`：账号 B。
- frp token：`frps` 和 `frpc` 共享的强 token。

密钥管理要求：

- 生产 `.env` 不提交到 Git。
- 生产 `.env`、frp 配置和恢复所需凭据必须保存在主机外的安全位置。
- 初始化账号密码上线后应按实际使用习惯确认是否需要更换。

## 7. 首次上线流程

首次部署按以下顺序执行：

1. 在 ECS 上安装并配置 `frps`。
2. 在阿里云安全组放行 `80`、`443` 和 frp 控制端口。
3. 将正式子域名解析到 ECS 公网 IP。
4. 在家里机器安装 Podman 和 Compose provider。
5. 在家里机器准备生产 `.env`。
6. 在家里机器配置并启动 `frpc`，映射 ECS 的 `80/443` 到本机 `80/443`。
7. 在家里机器启动数据库：`bash ops/podman/compose.sh -f podman-compose.yml up -d db`。
8. 首次初始化数据库：`bash ops/podman/compose.sh -f podman-compose.yml --profile bootstrap run --rm bootstrap`。
9. 启动应用和代理：`bash ops/podman/compose.sh -f podman-compose.yml up -d web proxy`。
10. 访问正式域名，确认 HTTPS、登录、首页、记账、记录页和备份正常。

如果是从旧机器或旧数据库迁移，不走 seed 初始化路径，应按 `docs/runbooks/restore.md` 先恢复备份，再启动 `web` 和 `proxy`。

## 8. 备份与恢复

备份继续使用现有脚本：

```bash
bash ops/backup/pg_dump.sh ./tmp/backups
```

恢复继续使用现有脚本：

```bash
bash ops/backup/restore-from-dump.sh /path/to/billboard-YYYYMMDD-HHMMSS.dump
```

上线前必须确认：

- 备份脚本可以生成 `.dump` 文件。
- dump 文件保存位置不只依赖同一块系统盘。
- 恢复文档包含生产 `.env`、frp 配置和数据库 dump 三类关键材料。

建议至少保留：

- 家里机器本地 14 天备份。
- 另一台设备或加密云盘上的周期性副本。

## 9. 安全边界

公网暴露面：

- 只暴露域名的 `80` 和 `443`。
- frp 控制端口必须使用强 token，并尽量通过安全组限制来源。
- 不暴露 PostgreSQL。
- 不直接暴露 Next.js `3000`。

应用安全：

- 所有正式访问必须走 HTTPS。
- `AUTH_SECRET` 必须是非占位值。
- 生产登录依赖已有账号密码，不开放注册入口。
- 家庭数据访问继续依赖当前 session 的 `householdId` 和 `memberId` 校验。

运维安全：

- ECS 只运行入口服务，不保存数据库。
- 家里机器的防火墙只允许必要端口。
- 生产配置和备份必须能在主机损坏时恢复。

## 10. 验证计划

上线前本地代码验证：

- `npm run lint`
- `npm run test:unit`
- `npm run test:integration`
- `npm run test:e2e`

生产部署验证：

- DNS 解析结果指向 ECS 公网 IP。
- ECS 安全组端口符合设计。
- `frps` 和 `frpc` 日志显示 `80/443` 映射在线。
- 正式域名可以打开 HTTPS 页面，浏览器证书有效且域名匹配。
- 两个内置家庭账号都可以登录。
- 可以新增一条支出和一条收入。
- `/home` 汇总随新增记录更新。
- `/records` 可以看到新增记录，并且编辑、软删除流程正常。
- `bash ops/backup/pg_dump.sh ./tmp/backups` 可以生成 dump 文件。

不允许把 e2e 测试直接指向生产数据库运行，因为 e2e 会在测试开始前和结束后清空 `Transaction` 表。

## 11. 错误处理与回滚

常见问题处理：

- DNS 未生效：先用 `nslookup` 或 `dig` 确认域名是否指向 ECS 公网 IP。
- HTTPS 证书申请失败：确认 `80/443` 是否从公网透传到家里 Caddy，且 `APP_DOMAIN` 与访问域名一致。
- 登录异常：确认 `AUTH_SECRET`、Cookie 域名、HTTPS 状态和 `web` 容器环境变量。
- 数据库连接异常：确认 `db` 服务健康，`DATABASE_URL` 使用 Compose 内部主机名 `db`。
- 家里机器断线：恢复 `frpc` 连接后再检查 `proxy` 和 `web`。

回滚方式：

- 应用容器更新失败时，保留数据库 volume，回退到上一版代码后重新构建并启动 `web`、`proxy`。
- 数据异常时，停止 `web`，按恢复文档从最近的 dump 恢复。
- frp 入口异常时，先关闭公网入口，保留家里机器内部服务和数据。

## 12. 成功标准

- 用户可以通过正式域名 HTTPS 访问 BillBoard。
- 账本应用、数据库和备份主要数据都保留在家里机器。
- ECS 只承担公网入口和 frp 服务端职责。
- PostgreSQL 不暴露到公网。
- 两个家庭账号可以完成登录、记账、查看和修改记录。
- 生产备份可以生成，并且恢复路径有文档可循。
- 方案不新增无关页面、复杂配置或泛化部署场景。
