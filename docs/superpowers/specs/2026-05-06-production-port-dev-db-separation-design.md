# 正式端口与开发数据库隔离设计

实施状态：已在 `v0.11.0`（commit `fd0055f`）完成并推送到 `master`。

## 背景

`BillBoard` 当前生产容器内部使用 `3000`，但生产入口主要通过 `proxy` 服务的 `80/443` 转发到 `web:3000`；本地开发和 Playwright e2e 也默认使用 `3000`。开发数据库和生产数据库虽然使用不同 volume，但默认库名都叫 `billboard`，在环境变量或 compose 项目复用时容易误连。

本次目标是让 `3000` 明确成为正式服务可直接访问的宿主机端口，让开发服改用 `2500`，并让开发和正式数据库默认分离。

## 确认范围

- 正式服务必须能通过 `http://主机:3000` 访问。
- 开发服务默认通过 `http://127.0.0.1:2500` 访问。
- 保留现有 `proxy` 服务，不把 Caddy 入口从生产 compose 中移除。
- 开发数据库默认使用独立库名，避免开发、seed、e2e 误写生产数据库。
- 不新增无关页面、业务功能或复杂配置。

## 方案

### 端口

- `package.json` 的 `dev` 脚本改为 `next dev --port 2500`。
- `playwright.config.ts` 的 `baseURL` 和 `webServer.port` 改为 `2500`，让 e2e 跟随开发服。
- `podman-compose.yml` 的 `web` 服务增加宿主机端口映射，默认 `"${APP_PORT:-3000}:3000"`。
- `Containerfile` 继续保留 `PORT=3000` 和 `EXPOSE 3000`，因为正式服务容器内部端口不变。
- `proxy` 服务和 `ops/caddy/Caddyfile` 保持现状，继续支持 `80/443 -> web:3000`。

### 数据库

- `.env.example` 的 `DATABASE_URL` 默认指向开发数据库 `billboard_dev`。
- `podman-compose.dev.yml` 的 `POSTGRES_DB` 默认改为 `billboard_dev`。
- `podman-compose.yml` 的生产数据库默认值继续为 `billboard`。
- 开发 compose 使用独立 project 名 `billboard-dev`，生产 compose 使用 `billboard`，避免同目录运行时 `db` 服务、网络和 volume 名称互相覆盖。
- 开发和生产继续使用各自 volume：`postgres-dev-data` 与 `postgres-data`。

### 文档

- `README.md` 更新本地启动、LAN 测试、隧道测试、Playwright 说明。
- `AGENTS.md` 更新仓库协作规则中的默认开发端口、e2e 端口和数据库隔离提醒。

## 验证

1. 配置搜索确认：`rg -n "3000|2500|billboard_dev|DATABASE_URL" ...`
2. 代码质量：`npm run lint`
3. 如提交本次功能：按仓库规则运行完整验证 `npm run lint`、`npm run test:unit`、`npm run test:integration`、`npm run test:e2e`

## 权衡

保留 `proxy` 可以兼容现有 `80/443` 部署文档和后续域名访问；同时直接暴露 `web` 的 `3000` 可以满足正式服务端口固定为 `3000` 的要求。代价是生产 compose 中会同时存在两个入口，但文档会明确 `3000` 是正式服务直连入口，`proxy` 是保留的反代入口。
