# 第二期账号与家庭自助实施计划

> **For agentic workers:** REQUIRED SKILL: Use implement to execute this plan task-by-task. Respect the handed-off git_state: inherit prepared, otherwise prepare; use git-workflow for checkpoint/finalize. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在默认账本基础上交付真实邮件、邀请及本人账号和家庭自助，保留存量账号与全部历史账务。

**Scope Source:** `docs/scope/2026-10-21-multi-household-ledgers.md` 第二期，以及 2026-10-21 用户对 163 SMTP 与第二期设计的确认。

**Architecture:** 账号级授权页面独立于家庭账务布局。账号与邀请服务共享数据库凭据摘要、邮件运输、全局有界密码计算及家庭优先锁序；最终消费和身份变更在短事务中重新验证。邮件 fragment 只在内存中持有，通过明确提交完成消费，不通过 GET 或回调参数传递。

**Tech Stack:** Next.js 16、React 19、Auth.js、Prisma 6、PostgreSQL 17、argon2、SMTP。

**Verification:** `npm run lint`、`npm run test:unit`、`npm run test:integration`、`npm run test:e2e`、生产构建、真实邮件及 HTTPS smoke、私有备份恢复和原数据摘要对照。

---

## Git 与文件归属

基线 `v1.52.1`，开始时原工作区干净；任务分支 `codex/household-self-service`，worktree `.worktrees/household-self-service`。首次写入前已刷新 `origin/master`，无差异。根代理负责统一提交、合并、推送与发布；不提交独立计划或未完成模块。按仓库偏好，完成所有实现、全测、安全审查及版本同步后形成同目标 feature 提交。

## 工作单元

### 1. 设计与共享基础

**Files:** 原 spec、`docs/wiki/households-and-ledgers.md`、`prisma/schema.prisma`、新增 migration、`src/lib/identity/shared.ts`、`src/lib/identity/mail.ts`、`src/lib/auth/login-admission.ts`、`tests/unit/identity-mail.test.ts`、`tests/integration/identity-shared.test.ts`。

**Acceptance:** 原用户验证时间为空；邀请／账号凭据仅存摘要；严格可信邮件入口；邮件失败脱敏；共享密码和发信预算；与旧写账兼容的锁序。

- [x] 恢复批准范围、完成 Git prepare，并同步已确认稳定 wiki 约定。
- [x] 写凭据、可信入口、邮件失败和有界预算的最小行为测试，记录 RED。
- [x] 新增增量表及约束；生成 Prisma client，在开发库迁移，保留原表和字段。
- [x] 实现共享账号锁、随机凭据、限流、密码预算和 SMTP 运输，重跑聚焦测试得到 GREEN。

### 2. 账号自助

**Files:** `src/lib/identity/account.ts`、`tests/integration/identity-account.test.ts`。

**Acceptance:** 本人验证／换绑／改密／会话撤销有服务端权限；未验证邮箱不能找回；一次性恢复、当前密码错误和并发旧 hash 均安全拒绝；邮件失败不破坏旧凭据；公开响应不枚举邮箱。

- [x] 用真实开发库与仅隔离 SMTP 的测试覆盖本人／越权／重放／失败／竞态，先观察缺少功能的 RED。
- [x] 实现本人安全 DTO、验证换绑、改密恢复、会话撤销与最小审计，运行同组 GREEN 及认证回归。

### 3. 邀请与家庭生命周期

**Files:** `src/lib/identity/invitations.ts`、`src/lib/identity/households.ts`、`tests/integration/identity-invitations.test.ts`、`tests/integration/identity-households.test.ts`。

**Acceptance:** 两类邀请各自创建正确目标，现有账号不复制；注册／邀请仅一次消费；资格变化和旧负责人邀请失效；退出、移除、并发转让不破坏负责人或历史统计，也不放过在途写入。

- [x] 添加双家庭、邀请并发消费、身份变更与在途写账的真实行为 RED。
- [x] 实现邀请状态、有限待注册和原子消费；实现转让、退出、移除、会话与凭据撤销及最小审计。
- [x] 运行生命周期 GREEN，核对历史成员与交易引用、金额和笔数无变化。

### 4. 页面与流程

**Files:** `src/app/account/**`、`src/app/(auth)/account-link/**`、`src/app/(auth)/forgot-password/**`、`src/components/identity-*`、`src/components/account-access-state.tsx`、`src/components/mobile-utilities.tsx`、登录／OPS 页面与 actions、`src/middleware.ts`、`src/lib/i18n.ts`、相关组件与 e2e 测试。

**Acceptance:** 无家庭可管理本人和接受邀请；家庭账务继续受家庭授权；邮件凭据清除且无 GET 消费；所有按钮实际可用，失败可重试，中英文与手机布局完整。

- [x] 读取当前 Next.js actions／forms／安全文档，以现有移动样式规划账号、家庭和邀请流程。
- [x] 先定义可观察导航／表单／公开邮件受理断言，再实现 server actions 与页面。
- [x] 用浏览器完成两类首次注册、已有账号入家／建家、验证／改密／恢复、本人会话和成员操作；检查手机、平板及桌面截图。

### 5. 私有配置、完整验收与发布

**Files:** `.env.example`、`compose.yml`、适用 Windows OPS／部署脚本、README、安全 skill 与 AGENTS 中适用的 OPS 邀请边界、根版本字段。

**Acceptance:** SMTP 与可信入口只经私有配置注入；公共 web 不开放 OPS；正式迁移不 seed，不损失存量数据；真实合成邮件及 HTTPS 验证通过，镜像与已推送 SHA 一致。

- [x] 同步占位配置与运维说明，私有 env 中保存实际参数；运行配置检查及依赖 audit。
- [x] 执行 lint、全部单元／集成／e2e 和生产构建；失败先诊断修复，不降低门槛。
- [x] 按 `skills/billboard-security-review/SKILL.md` 审查实际变更面，记录 Findings、Verification、Residual Risk。

发布收尾按以下门禁顺序执行。实际提交 SHA、正式迁移与健康结果写入未跟踪的私有运维记录，不在实现提交中预写尚未发生的结果：

1. 版本同步、刷新远端、只提交任务文件、rebase、合回 master、推送并核对远端 SHA。
2. 从该 master 构建并核验镜像；停止全部相关写入者，取得正式一致备份并实际恢复到新空目标，验证新增迁移保持原字段和历史统计；通过后才迁移正式库，不执行生产 seed。
3. 从 master 恢复正式服务，验证健康、真实 HTTPS、旧账号登录态和历史只读查询；保留脱敏证据，完成 Git finalize 与干净任务 worktree 清理。

## 验证记录

随工作单元完成记录实际命令和结果；未经执行不勾选。任务中产生的私有日志、凭据、真实入口、真实数据与邮件链接不进入此文件。

- 开发库两项增量迁移已部署；私有 PostgreSQL 17 空目标恢复演练通过，原有各表的列、行数及历史分组保持一致；新增五表为空，已核对存量账号的邮箱验证字段。再次执行迁移无变化。正式库尚未迁移。
- 本期两条迁移通过 `.gitattributes` 保留已验证的原始字节，防止 Windows／Linux checkout 的自动换行转换改变 Prisma checksum。既有迁移不调整；第一条已应用迁移的 CRLF 和末尾空行原样保留。
- 基线完整验证：lint 通过；单元 850 通过、2 项平台条件跳过；集成 41 文件、669 通过；e2e 136 通过、1 项原有性能条件跳过。账号与家庭页面在 390／768／1440 像素下检查通过，设计检查无 FAIL／WARN。
- 安全复核发现并修复 SMTP 伪取消和旧凭据创建会话两个 P1。SMTP 真实 TCP 回归已从 RED 变为 GREEN，确认二十五秒后连接归零、并发峰值为二且名额释放后可继续发送；另有十项真实 loopback 隐式 TLS／STARTTLS、证书拒绝、IP SAN 和延迟建连检查通过。首次空限流表的八请求并发从唯一键冲突 RED 变为原子初始化 GREEN。
- 最终创建会话事务按家庭、成员、账号加锁重验原邮箱、密码哈希、状态和成员身份。尚未映射的旧 JWT 按原签发时间和保留的敏感撤销审计判定，失败直接返回空登录态；middleware 只验证 cookie，不重签或更新 `iat/jti`，避免绕过审计和原撤销映射。认证相关真实数据库回归 84 项、middleware 实际 Auth.js 加密回归 15 项通过；独立最终静态复核无剩余阻塞发现。
- 私有邮件单次合成发送已获 SMTP 受理；用户于 2026-10-21 补充确认第二期真实邮件收发已验收通过。邮件收发结论来自用户确认，凭据消费及重放拒绝沿用既有自动化验证记录。邮件正文、链接及真实邮箱不记录到仓库。
- PowerShell 语法与 Compose 展开检查通过；web 仅 loopback 发布，正式数据库不发布主机端口，七项邮件私有配置只注入 web／本机 OPS，不注入 AI agent 或构建。
- 依赖审查：邮件库固定使用独立别名的当前 Nodemailer，Auth.js 升级至修复版本；两者无 audit 告警。本机依赖 audit 仍有 25 项现有告警（0 critical），已按生产可达路径核查，不在本期顺带升级无关解析或开发工具链。
- 最终源的 lint 通过；单元 91 文件、878 通过及 2 项平台条件跳过；集成 43 文件、692 通过。首次完整 e2e 在并行容器依赖构建期间有一次登录保护超时；无并行构建的完整重跑已通过对应成员生命周期场景，原安全限制及超时未放宽。
- 最终完整 e2e 重跑 136 通过、1 项原有性能条件跳过；生产构建及 TypeScript 检查通过。版本同步为 `1.53.0`；最终刷新远端仍为原基线，原 master 工作树干净。

### Findings

最终安全审查未发现剩余阻塞问题。SMTP 取消、凭据与身份竞态、legacy JWT 重签窗口和首次限流初始化问题均已修复并有实际回归；新增页面及 actions 的家庭／本人／OPS 权限、凭据用途和一次性语义已核验。

### Verification

完整 lint、单元、集成、e2e、生产构建通过，结果如上。PowerShell、Compose、迁移约束及真实备份恢复演练通过；扫描 579 个候选源文件及 22 项实际私有值／编码形式／入口表示，无真实凭据或入口命中。根代理复核手机截图，页面可读、表单及历史身份区分正常。

### Residual Risk

尚未映射旧 JWT 的兼容恢复依赖敏感撤销审计保留，当前无生产清理路径，该约束已写入 wiki 与安全审查规则。既有依赖告警按当前可达性保留，未混入无关大版本升级。真实邮件收发已由用户确认验收通过，原收件未确认保留项已关闭；实际 HTTPS、正式停写迁移及发布结果见私有运维记录。
