# Restore Runbook

用于把已有 BillBoard 备份恢复到新机器或新建空数据库；从仍在运行的 Podman 服务迁移时先执行
[Podman 到 Docker Desktop 迁移](podman-to-docker.md)，以停止源库写入并取得一致备份。

## Prerequisites

- Windows 已安装并启动 Docker Desktop 的 Linux containers；命令固定使用 `docker --context desktop-linux`。Linux 使用 Docker Engine 与 Compose 插件，省略 context 参数。
- 目标仓库为已验证、已推送的 `master`，使用 `compose.yml`。数据库仍为 `postgres:17`，恢复不与数据库大版本升级混做。
- 从私有存储恢复 `.env.production.local`，保留 `AUTH_SECRET`、`POSTGRES_USER`、`POSTGRES_PASSWORD`、`POSTGRES_DB` 和 `OPS_ADMIN_PASSWORD_HASH_BASE64`。诊断 Agent API 已下线，不再使用诊断 token。禁止使用示例生产密码。
- 账号邮件同时恢复私有 `APP_PUBLIC_ORIGIN`、`SMTP_HOST`、`SMTP_PORT`、`SMTP_SECURE`、`SMTP_USER`、`SMTP_PASSWORD` 和 `SMTP_FROM_EMAIL`。可信入口必须是当前 HTTPS 根入口，发件人须与 SMTP 账号一致；配置只注入 web 与本机 OPS，恢复后用合成账号核验真实发信，不把链接或凭据写入恢复日志。配置说明见 [README](../../README.md#账号家庭与邮件)。
- Windows 正式启动脚本会生成容器内 `DATABASE_URL`；直接运行 Compose 时，在私有环境中提供指向 `db:5432` 且用户名、密码、库名已 URL 编码的连接串，不使用旧主机隧道地址。
- 已有 PostgreSQL custom dump、对应的 SHA-256，以及备份时记录的各表行数和校验摘要。备份含家庭财务与账号数据，只能置于私有、未跟踪的位置。
- 目标库必须为空，`web`、独立 OPS 容器及其他写入者保持停止。已有目标数据时先核验归属并另做备份，不能直接用 `--clean` 覆盖；不要删除旧引擎卷或现有生产卷。

## Restore Steps

1. 恢复私有配置，确认所选 Docker context、Compose project、数据库名和卷均为目标环境。开发 `billboard-dev` 与生产 `billboard` 必须区分。
2. 仅启动数据库并确认健康：

   ```powershell
   docker --context desktop-linux compose --env-file .env.production.local -f compose.yml up -d --wait db
   docker --context desktop-linux compose --env-file .env.production.local -f compose.yml ps
   ```

3. 在私有目录核对备份 `Get-FileHash -Algorithm SHA256 <private-dump-path>`，将备份复制入目标数据库容器，再执行 `pg_restore --list`。完整的 Windows 命令见迁移 runbook 的“恢复到 Docker 空库”。目录可读仅证明归档可解析，不能替代实际恢复验证。
4. 按迁移 runbook 的命令，用 `pg_restore --exit-on-error --single-transaction --no-owner --no-privileges` 手动恢复到目标空库。此路径不使用 `--clean`、`--create`、bootstrap seed，也不调用下方的覆盖式恢复脚本。
5. 在启动应用前，对照备份证据核验所有应用表的行数和稳定排序后的内容摘要，包括软删除交易、导入草稿及映射、用户、分类、`AppSession`、`OpsAuditLog` 和迁移历史。不输出原始记录、账号或口令哈希。
6. Windows 执行 `.\ops\windows\start-production.ps1`，由脚本构建镜像、等待数据库健康、执行 `npx prisma migrate deploy` 后启动 web/已启用的 OPS；它不执行 seed。Linux 按 README 的构建、数据库、`migrate deploy`、web 顺序发布。
   旧备份可能包含已确认删除的诊断报告。必须在开放服务前应用 `20261024030000_remove_client_diagnostic_reports`，删除 `ClientDiagnosticReport` 表和专用枚举；不恢复旧诊断接口。这是预期的数据删除，与第 5 步迁移前核验分开记录。
7. 检查本地登录页及静态 chunk，再确认 nginx/frpc 仍按根路径代理，最后恢复公网入口。Windows 无需 SSH 隧道；`3000` 和 OPS 的 `32768` 都只绑定 loopback，生产数据库不发布端口。
8. Windows 按 `home-network-checklist.md` 注册当前用户登录后启动的任务，并检查每日备份；Docker Desktop 不能保证用户登录前服务可用。

## 覆盖式灾难恢复脚本

`ops/backup/restore-from-dump.sh` 保留原有覆盖恢复语义，只适用于已明确授权覆盖目标数据库的灾难恢复，
不用于本次引擎迁移。它使用 `--clean --create --if-exists --no-owner --exit-on-error`，先连接 `postgres`，
按归档中的源数据库名重建数据库；它没有空库检查，也不是 `--single-transaction` 恢复。

执行前停止 `web`、独立 OPS 容器及其他写入者，备份现有目标数据，核对 Docker context、归档的源数据库名、
目标集群以及允许覆盖的数据范围。发生错误时保持服务停止，检查目标库状态，不能把部分恢复当作成功。

```bash
bash ops/backup/restore-from-dump.sh /path/to/billboard-YYYYMMDD-HHMMSS.dump
```

脚本默认加载存在的 `.env.production.local`；其他私有配置文件通过 `COMPOSE_ENV_FILE` 指定。
Windows 用 Bash 执行时设置 `DOCKER_CONTEXT=desktop-linux`。恢复完成后继续上面的数据核验、迁移及发布步骤，
不执行 seed。

## Validation Checklist

- 用原有账号登录，确认 `/home` 总额和历史记录与恢复前一致；迁移本身不修改账号密码或账本数据。
- 恢复前后的表级行数和摘要一致；若后续 Prisma migration 改变数据结构或迁移历史，单独记录预期变化。
- 当前迁移完成后，诊断表和专用枚举不存在；家庭、成员、账本、账务、业务事件及会话仍通过完整性核验。
- 登录页及引用的静态资源正常，无旧 Podman 隧道；仅公网 nginx `80/443` 对外暴露，OPS 仍只在本机可访问。
- 应用端到端测试只连接独立开发/测试库。Playwright 会清空导入草稿、映射和交易，严禁在恢复出的生产库上运行。
- 再做一次新备份并核验归档。Windows 备份脚本先保存到 `tmp/backups`，再复制至 `-BackupDir`；NAS 复制失败时保留本地文件并恢复备份目标后重试。
- 新库一旦接受写入，回退前必须停止写入并反向备份、恢复和核验最新数据；不能直接切回旧快照。详见迁移 runbook 的“回退”。
