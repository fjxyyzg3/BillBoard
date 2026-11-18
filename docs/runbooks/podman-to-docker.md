# Podman 到 Docker Desktop 迁移

本步骤把现有 BillBoard PostgreSQL 17 数据逻辑迁移到 Docker Desktop，不改账号、密码、分类或账本内容。
当前运行配置改为 `compose.yml`、`compose.dev.yml`，不再使用 Podman Compose wrapper 或 SSH 隧道。

## 边界与准备

| 环境 | Compose project | 卷 key | 数据库 |
| --- | --- | --- | --- |
| 生产 | `billboard` | `postgres-data` | 私有 `POSTGRES_DB`，默认 `billboard` |
| 开发 | `billboard-dev` | `postgres-dev-data` | `billboard_dev` |

两个引擎的同名卷不是同一物理卷。不得直接挂载、删除或覆盖旧 Podman 数据目录；迁移使用 custom dump 和
`pg_restore`，两侧均保留 `postgres:17`。生产和开发分别备份、恢复、核验，不能交叉连接。

1. 确认 Docker Desktop 已启动 Linux containers，`docker --context desktop-linux info` 正常；不修改全局 context。
2. 记录旧 Podman 容器、卷、运行镜像、启动任务和本项目 SSH 转发的归属，仅记录必要的非敏感标识。检查目标 Docker 卷是否已存在及是否有数据。
3. 在私有位置保留 `.env.production.local`、开发配置、nginx/frpc 配置和旧启动方式。不要将真实入口、账号、密码、token、哈希或数据库备份加入 Git。
4. 保留原有 `AUTH_SECRET`、数据库密码、诊断 token、OPS 哈希和所有应用账号。直接使用 Compose 时，私有 `DATABASE_URL` 指向 `db:5432`，用户名、密码和库名应 URL 编码；Windows 正式启动脚本会构造该连接串。
5. 先完成代码验证和可复用镜像构建，再进入数据切换窗口。发布仍须从已验证、已推送的干净 `master` 执行。

## 停止源写入并备份

- 暂停旧生产自启动任务及可能重新拉起服务的进程，停止公网转发和旧 `web`、OPS；开发迁移时同时停止开发服和测试。
- 保留源 PostgreSQL 运行用于备份，确认没有应用连接继续写入。不得让两套应用同时接受请求，也不能只停公网入口而留下本机 OPS 写入者。
- 从停止写入后的同一状态生成备份和表级校验摘要。摘要包含所有应用表及迁移历史，不能排除软删除记录；对各表按稳定主键排序、固定列序列化后计算校验值。只记录行数和摘要，不输出财务原文、账号或哈希列内容。

在 PowerShell 中，先将 `$sourceDb` 设置为已核实的源生产数据库容器名。以下示例只导出，不删除源数据：

```powershell
$sourceDb = "<podman-production-db-container>"
$migrationDir = Join-Path (Get-Location) ("tmp\backups\podman-to-docker-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
New-Item -ItemType Directory -Path $migrationDir -Force | Out-Null
$dumpPath = Join-Path $migrationDir "production.dump"
podman exec $sourceDb sh -c 'pg_dump --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --format=custom --file=/tmp/billboard-migration.dump'
if ($LASTEXITCODE -ne 0) { throw "Source backup failed" }
podman exec $sourceDb pg_restore --list /tmp/billboard-migration.dump | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Source archive validation failed" }
podman cp "${sourceDb}:/tmp/billboard-migration.dump" $dumpPath
if ($LASTEXITCODE -ne 0) { throw "Backup copy failed" }
Get-FileHash -Algorithm SHA256 -LiteralPath $dumpPath
```

另行保存已核验的备份副本到私有备份目标。PowerShell 不要用 `>` 或字符串管道传递二进制 dump；
先在容器写文件，再用 `podman cp` / `docker cp` 复制。`pg_restore --list` 仅验证归档目录可读，
完整恢复及源目标摘要一致才是迁移验收证据。

## 恢复到 Docker 空库

确保目标 `web` 和 OPS 未启动。只启动 Docker 数据库；若目标已存在任何应用表，先调查并保留数据，
不要用 `--clean`、`--create` 或 `down -v` 强行清空。

```powershell
docker --context desktop-linux compose --env-file .env.production.local -f compose.yml up -d --wait db
if ($LASTEXITCODE -ne 0) { throw "Target database startup failed" }
docker --context desktop-linux compose --env-file .env.production.local -f compose.yml ps
$targetDb = docker --context desktop-linux compose --env-file .env.production.local -f compose.yml ps -q db
if ($LASTEXITCODE -ne 0 -or -not $targetDb) { throw "Target database not found" }
$emptyQuery = "SELECT count(*) FROM pg_tables WHERE schemaname = 'public';"
$targetTableCount = $emptyQuery | docker --context desktop-linux exec -i $targetDb sh -c 'psql --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" -At -v ON_ERROR_STOP=1'
if ($LASTEXITCODE -ne 0 -or "$targetTableCount".Trim() -ne "0") { throw "Target database must be empty" }
docker --context desktop-linux cp $dumpPath "${targetDb}:/tmp/billboard-migration.dump"
if ($LASTEXITCODE -ne 0) { throw "Target archive copy failed" }
docker --context desktop-linux exec $targetDb pg_restore --list /tmp/billboard-migration.dump | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Target archive validation failed" }
docker --context desktop-linux exec $targetDb sh -c 'pg_restore --exit-on-error --single-transaction --no-owner --no-privileges --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" /tmp/billboard-migration.dump'
if ($LASTEXITCODE -ne 0) { throw "Target database restore failed" }
```

`up --wait` 等待数据库健康后才继续。默认生产配置不发布 PostgreSQL 主机端口，恢复通过容器执行。
此路径不使用 `ops/backup/restore-from-dump.sh`，因为该脚本保留覆盖式灾难恢复语义，见 [Restore Runbook](restore.md)。

## 核验与切换

1. 在目标启动应用前重新计算全部表的行数与稳定摘要，与源备份时的结果逐表比较。覆盖用户、家庭成员、分类、交易、软删除记录、导入草稿与映射、`AppSession`、`OpsAuditLog` 及 `_prisma_migrations`；任何不一致都先调查，不开放目标写入。
2. 数据一致后停止源数据库容器，但保留源容器、卷、镜像、私有配置和备份；仅停止本项目已核实的旧 SSH 转发，释放 `3000`、`32768` 及旧开发隧道端口。
3. 执行 `.\ops\windows\start-production.ps1`。脚本构建 Docker 镜像、等待数据库健康、运行 `npx prisma migrate deploy`，然后启动 web 和已启用的本机 OPS；不运行 seed。
4. 确认 `127.0.0.1:3000/login`、其引用的静态 chunk、原账号登录及已有账本汇总正常；启用 OPS 时检查 `http://127.0.0.1:32768/ops`。公共 web 不启用 OPS。
5. 恢复原 nginx/frpc 公网链路，只保留 `public 80/443 -> nginx / -> frpc remote 3000 -> 127.0.0.1:3000 -> web:3000`。不公开 `3000`、`32768` 或数据库端口，不改变真实入口配置。
6. 开发库按同样的停写、备份、空库恢复、核验流程单独迁移，改用 `compose.dev.yml`；`.env.local` 的开发连接改到 `127.0.0.1:5432/billboard_dev`。只在开发/测试库运行完整测试，严禁 e2e 连接生产。
7. 注册 `.\ops\windows\register-production-startup.ps1`，替换旧 Podman 启动任务；Docker Desktop 任务在当前用户登录后以 `Interactive` 运行，不保证登录前启动。验证每日备份能读取 Docker 数据库，并在复制目标失败时保留本地备份。
8. 新建一次 Docker 备份并核验。旧 Podman 卷和迁移备份继续保留；清理不是切换的必要步骤。

## 回退

- **目标尚未接受新写入**：停止 Docker web、OPS、自启动及公网转发，确认不会自动拉起；停止目标数据库后，恢复已记录的源 Podman 数据库和旧运行方式，核验原有数据、登录页和静态资源，再恢复公网入口。避免两边争用端口或同时写入。
- **目标已经接受写入**：先停目标写入，生成并核验最新 custom dump 和各表摘要，再恢复到核实为空的回退数据库。若新版本已执行 Prisma migrations，必须先确认旧应用与新 schema 的兼容性；不兼容时保留新应用版本运行在回退引擎，或单独制定可保留新数据的恢复步骤。不得直接切回旧 Podman 快照丢弃新增账目、密码重置或会话变更。
- 回退同样保留两侧卷和备份，不使用 `down -v`、全局 prune 或删除 Podman machine 作为恢复步骤。恢复后重做数据摘要、原账号登录及入口健康检查，确认只有一套应用接受写入。
