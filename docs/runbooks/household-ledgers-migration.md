# 家庭与账本第一期迁移

本流程用于现有 PostgreSQL 17 家庭账本的增量升级。原账号、密码、成员／交易 ID、来源元数据、旧 UUID 结果、有效登录态及原有效期保持。邀请、邮件与多账本管理按后续期次交付。

## 演练与证据

1. 从正式服务生成私有 custom dump，校验 SHA-256，恢复到独立、核实为空的 PostgreSQL 17 容器。容器不发布端口，使用 `--network none`；一次性 tools 容器通过 `--network container:<restore-container>` 访问，不连接 Agent 或公网。
2. 用当前源码构建的 `tools` 镜像运行核验工具；`DATABASE_URL` 仅通过进程环境注入。执行 `snapshot --output /evidence/before.json`，再运行 `npx prisma migrate deploy`，最后 `verify --foundation --baseline /evidence/before.json --output /evidence/after.json`。证据目录必须是私有 bind mount，仓库内使用已忽略的 `tmp/migrations/`。
3. `snapshot` 固定全部原表和原字段，分批计算稳定行摘要；`verify` 使用同一原字段清单比较，迁移历史仅比较原有行，预期新增的账本及 migration 单独核验。账务同时核对家庭、实际成员、创建成员、上海月份、方向和软删除状态分组摘要。
4. 覆盖软删除交易、pending/completed 草稿、退款来源指纹、分类／成员映射和旧请求终态。报告只含计数、摘要和 pass/fail，不输出真实账号、哈希、原账单、备注或真实入口。
5. 重跑部署与本次回填 SQL，应无新增重复账本、交易或会话绑定。用合成旧库验证缺失负责人、跨家庭关联和无法唯一绑定的有效会话会停止，而非猜测修复。
6. 演练新版接受一笔合成写入后重新备份、恢复并核验最新数据；回退默认向前修复，旧快照不能覆盖新版新增账目。保留旧镜像、私有配置、原备份与恢复副本。

自动化测试仅使用合成数据和独立开发／测试库；禁止对正式快照运行会清库的 Playwright 或集成测试。真实备份和内容不能发送给外部 AI。

## Windows 正式维护切换

先确认本任务完整测试、安全审查及私有演练通过，已提交并推送干净 `master`，实际远端 SHA 与本地相同。维护时长根据演练估算。

默认流程通过 Docker 停止旧 web 接收请求，保留现有 frpc 链路；迁移后先在独立 loopback 端口验证同一新版镜像，原 `3000` 上游保持关闭，检查通过才恢复原端口。备用端口默认 `33001`，无 frp／公网映射，不改变最终网络拓扑。

如运行环境能够控制独立正式入口，可额外提供两个未跟踪的私有 PowerShell 脚本：前者仅停止已核对归属的 BillBoard 入口，后者恢复同一入口并验证实际 HTTPS `/login`。两者须成对提供，失败必须 throw 或非零退出。脚本输出被捕获，不得按进程名停止其他转发，不把真实入口或路径提交到 Git。

```powershell
.\ops\windows\migrate-household-ledgers.ps1 `
  -PrivateDirectory <private-existing-evidence-directory>
```

维护脚本依次执行：

1. 通过 `start-production.ps1 -BuildOnly` 预构建并核验镜像，预检原数据和账号／成员关联。该步骤不迁移数据库或重启应用。
2. 如提供私有入口钩子先调用；停止 OPS，向 web 发送 SIGTERM 停止接收新请求，并允许至多 180 秒完成在途请求，Agent 此时保持可用；随后停止 Agent，检查数据库不再有其他客户端。
3. 等待自然语言租约到期，安全关闭已过期的处理中尝试，不重开任何已完成请求；未知活动租约或写入者未收敛时停止流程。
4. 取得最终原字段摘要和 custom dump，核验归档及 SHA-256；将该最终备份实际恢复到另一个空的私有容器并比较原字段。
5. 执行 `prisma migrate deploy`，比较全部原字段与账务摘要，检查默认账本和关联约束。失败保持停写，禁止 seed、丢记录或略过核验。
6. 经原启动脚本 `-SkipBuild -PrivateSmokePort 33001` 在备用 loopback 端口验证登录页、静态 chunk 和本机 OPS，确认原上游尚未重新监听；然后使用相同镜像恢复原端口。如提供入口恢复钩子则调用，最后核验实际 HTTPS `/login`。使用原身份的合成兼容回归及受控正常登录／历史查询 smoke 核验会话与历史可用。

脚本将最终备份、摘要、旧镜像 ID 与核验结果保留在独立私有运行目录；不自动删除恢复容器或卷。日志只有安全状态，不记录环境变量值、账号、账本原文或公网地址。

## Linux 等价路径

在相同演练和证据门槛下，预构建已推送提交镜像，停止实际入口，依次收敛并停止 web、OPS 和其他写入者，执行相同 `quiesce`／`snapshot`，生成并实际恢复最终备份，然后 `prisma migrate deploy` 与 `verify --foundation`。验证通过才 `up -d web import-agent`、恢复本机 OPS 与实际入口；使用 `docker compose --env-file .env.production.local -f compose.yml`，不执行 bootstrap 的默认 seed 命令。

## 失败与恢复

- **尚未恢复新版写入：** 保持入口及写入者停止；可先修复失败原因并重试。确需恢复旧版本时，核验备份、目标归属及允许覆盖范围，优先恢复到新的空库并逐表核验后切换，不直接清空当前库。
- **新版可能已接受写入：** 立即停止入口和全部写入者，保存最新 custom dump 与摘要，向前修复；必须回退时先验证兼容转换和全部新增数据保留，再恢复服务。不得直接恢复旧快照。
- **入口或 smoke 失败：** 不宣称上线完成，不发放邀请；先保留全部数据和证据，再诊断对应链路。恢复／覆盖真实数据若超出已有明确授权，按具体目标与影响取得授权。
