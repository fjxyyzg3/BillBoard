# Podman Runtime Migration Design

日期：2026-04-27

## 1. 背景与目标

本设计定义 BillBoard 容器运行链路从 Docker 转向 Podman 的迁移方案。目标是让本地开发测试和 Linux 生产部署都以 Podman 为默认运行方式，同时保持现有家庭记账业务能力、数据库结构、认证逻辑和 UI 行为不变。

本次迁移服务的是运维和验证体验，不改变产品功能。BillBoard 仍然是两人家庭记账应用，核心体验继续围绕快速记录、按家庭成员视角查看、按时间范围复盘。

已确认范围：

- 本地开发测试数据库改用 Podman Compose 风格入口。
- 生产 `web`、`bootstrap`、`db`、`proxy` 栈继续使用 Compose 风格编排，但命令和文件命名转为 Podman。
- 备份和恢复脚本改为通过统一 Podman Compose 入口执行。
- Windows 本地开发测试提供 PowerShell 原生入口。
- Linux 生产部署提供 Bash 入口。
- 文档和 AI 执行规则中的主要容器命令改为 Podman。

不纳入范围：

- 不改 Next.js、Prisma schema、server actions、认证、查询或 UI 业务逻辑。
- 不设计旧 Docker volume 到 Podman volume 的迁移步骤。
- 不引入 Podman Quadlet、systemd unit、Kubernetes YAML 或更复杂的生产编排。
- 不自动安装 Podman、`podman-compose` 或其他 provider。

## 2. 假设

- 新部署和后续开发测试以 Podman 为准。
- Windows 开发机可以通过 Podman Desktop 或等价环境使用 `podman` CLI。
- Linux 生产主机可以直接运行 `podman` CLI，并安装可用的 Compose provider。
- 默认 Compose provider 应优先使用 `podman-compose`，但允许用户通过环境变量覆盖。
- 现有 Compose 服务拓扑足够简单，适合先做 Podman Compose 迁移，而不是改成 Quadlet。
- 备份恢复继续基于 PostgreSQL dump 文件，不直接搬运容器 volume。

## 3. 已比较方案

### 3.1 只替换文档命令

保留现有文件名和脚本结构，只把文档中的命令从 `docker compose` 改为 `podman compose`。

优点：

- 改动最小。
- 实现最快。

缺点：

- 仓库中仍保留大量 Docker 命名。
- Windows 和 Linux 的 provider 差异没有统一入口承接。
- 备份恢复脚本仍需要额外修改，整体迁移不完整。

结论：不采用。

### 3.2 Podman Compose 双入口

将容器文件命名切换到 Podman 风格，新增 PowerShell 和 Bash 两个轻量入口脚本，所有开发、生产、备份、恢复命令都通过入口脚本执行。

优点：

- Windows 本地开发测试和 Linux 生产部署各有自然入口。
- `PODMAN_COMPOSE_PROVIDER` 默认值集中处理，后续命令不重复平台判断。
- 迁移足够完整，但不引入额外编排系统。
- 备份恢复继续复用现有流程，数据风险低。

缺点：

- 需要维护两个入口脚本，必须保持行为一致。

结论：选择此方案。

### 3.3 Podman 原生长期运行模型

将生产部署转为 `podman pod`、Quadlet 或 systemd 管理。

优点：

- 更贴近 Podman 原生生产运维方式。
- 可获得更清晰的主机级服务管理。

缺点：

- 超出本次迁移目标。
- 会引入新的部署模型、更多文档和验证成本。
- 对当前四服务小栈来说偏重。

结论：不采用。

## 4. 文件与命名设计

容器相关文件命名改为：

- `Dockerfile` -> `Containerfile`
- `.dockerignore` -> `.containerignore`
- `docker-compose.yml` -> `podman-compose.yml`
- `docker-compose.dev.yml` -> `podman-compose.dev.yml`

`podman-compose.yml` 中的 build 配置显式指向 `Containerfile`。`podman-compose.dev.yml` 继续只包含开发测试用 PostgreSQL 服务。服务名保持 `web`、`bootstrap`、`db`、`proxy` 不变，避免影响服务间 DNS 名称和现有脚本语义。

Podman 官方文档说明 `podman build` 支持 `.containerignore` 和 `.dockerignore`，且两者同时存在时优先使用 `.containerignore`。因此本次使用 `.containerignore` 承接原忽略规则，避免继续保留 Docker 命名。

## 5. Compose 入口设计

新增两个入口脚本：

- `ops/podman/compose.ps1`
- `ops/podman/compose.sh`

两个脚本职责一致：

1. 检查 `podman` 命令是否可用。
2. 如果用户没有设置 `PODMAN_COMPOSE_PROVIDER`，默认设置为 `podman-compose`。
3. 将所有参数原样透传给 `podman compose`。

示例：

```powershell
.\ops\podman\compose.ps1 -f podman-compose.dev.yml up -d db
```

```bash
bash ops/podman/compose.sh -f podman-compose.yml up -d web proxy
```

Podman 官方文档说明 `podman compose` 是外部 Compose provider 的薄封装，provider 可通过 `PODMAN_COMPOSE_PROVIDER` 或配置文件控制。本设计采用默认 `podman-compose`、允许环境变量覆盖的策略，避免在项目脚本里写死某台机器的 provider 路径。

## 6. 开发测试流程

Windows 本地开发测试推荐流程：

```powershell
.\ops\podman\compose.ps1 -f podman-compose.dev.yml up -d db
npm run prisma:seed
npm run test:integration
npm run test:e2e
```

如果只需要启动数据库供开发服务器使用：

```powershell
.\ops\podman\compose.ps1 -f podman-compose.dev.yml up -d db
npm run dev
```

`.env.example` 中的 `DATABASE_URL` 保持 `127.0.0.1:5432`，因为开发数据库仍通过宿主端口暴露给 Node 进程。`POSTGRES_PORT` 仍用于覆盖宿主端口。

## 7. 生产部署流程

Linux 生产新部署推荐流程：

```bash
bash ops/podman/compose.sh -f podman-compose.yml up -d db
bash ops/podman/compose.sh -f podman-compose.yml --profile bootstrap run --rm bootstrap
bash ops/podman/compose.sh -f podman-compose.yml up -d web proxy
```

生产 Compose 拓扑保持现状：

- `db` 使用 `postgres:17`，通过 named volume 保存数据。
- `bootstrap` 运行 Prisma migration 和 seed，仅在 bootstrap profile 下按需执行。
- `web` 构建 Next.js standalone 应用，通过 `db:5432` 访问数据库。
- `proxy` 使用 Caddy，将外部 HTTP/HTTPS 流量反代到 `web:3000`。

`AUTH_SECRET` 的占位值保护继续保留在 `Containerfile` 的启动命令中。生产文档继续要求设置真实 `AUTH_SECRET`、`APP_DOMAIN` 和 seed 账号环境变量。

## 8. 备份与恢复

`ops/backup/pg_dump.sh` 和 `ops/backup/restore-from-dump.sh` 保留现有入口名称和参数，内部改为调用 `ops/podman/compose.sh`。

备份流程保持：

1. 启动 `db` 服务。
2. 等待 PostgreSQL ready。
3. 在 `db` 容器内执行 `pg_dump`。
4. 使用 `podman cp` 将 dump 文件复制到宿主机。
5. 删除容器内临时 dump。
6. 清理超过 14 天的本地 dump。

恢复流程保持：

1. 校验 dump 文件存在。
2. 启动 `db` 服务。
3. 等待 PostgreSQL ready。
4. 使用 `podman cp` 将 dump 文件复制到 `db` 容器。
5. 在 `db` 容器内执行 `pg_restore`。
6. 删除容器内临时 dump。

本次不写旧 Docker 数据迁移步骤。已有旧环境数据由使用者自行处理。

## 9. 错误处理

入口脚本只处理必要前置条件：

- `podman` 不存在时，输出明确错误并退出非 0。
- `PODMAN_COMPOSE_PROVIDER` 未设置时才写入默认值，避免覆盖用户自定义 provider。
- 其他错误交给 `podman compose` 原样返回。

备份恢复脚本继续处理：

- 缺少参数。
- dump 文件不存在。
- PostgreSQL 30 秒内未 ready。
- 无法解析 `db` 容器 id。

不做自动安装、不做复杂平台探测、不为不可达场景增加额外错误分支。

## 10. 文档更新

需要更新：

- `AGENTS.md` 中本地数据库启动命令。
- `docs/runbooks/home-network-checklist.md` 中生产部署、bootstrap、端口转发和验证命令。
- `docs/runbooks/restore.md` 中生产恢复命令和前置条件。

文档中的部署措辞统一使用 Podman，不再把 Docker 作为默认运行方式。必要时可以保留对官方术语的引用，例如 `PODMAN_COMPOSE_PROVIDER`，但不新增 Docker 兼容路径。

## 11. 验证计划

实现后按改动范围做最小充分验证：

1. 静态检查旧入口：
   - 确认 `Dockerfile`、`docker-compose.yml`、`docker-compose.dev.yml` 不再作为项目入口存在。
   - 确认主要文档和脚本不再使用 `docker compose` 作为运行命令。
2. 脚本轻量验证：
   - Windows 环境运行 `.\ops\podman\compose.ps1 --help`。
   - Linux 或 Bash 环境运行 `bash ops/podman/compose.sh --help`。
   - 如果当前机器未安装 Podman，记录为环境阻塞，不伪造通过结果。
3. 项目静态验证：
   - 运行 `npm run lint`。
4. 可选运行验证：
   - 如果 Podman 和 PostgreSQL 环境可用，运行 `.\ops\podman\compose.ps1 -f podman-compose.dev.yml up -d db`。
   - seed 数据后运行 `npm run test:integration`。
   - 涉及端到端流程验证时运行 `npm run test:e2e`。

本次迁移不触及业务纯函数或 UI 组件逻辑，因此单元测试不是必要验证项。若实现过程中改动到应用代码，再按 AGENTS 规则扩大验证。

## 12. 成功标准

- Windows 开发者可以用 PowerShell 入口启动测试数据库。
- Linux 生产主机可以用 Bash 入口启动数据库、bootstrap、web 和 proxy。
- 备份恢复脚本不再依赖 Docker 命令。
- 仓库容器入口文件使用 Podman 命名。
- 文档中的日常运行路径以 Podman 为准。
- 业务功能、金额分处理、Asia/Shanghai 日期逻辑、软删除过滤和 session household/member 校验不受影响。
