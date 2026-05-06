# AGENTS.md

本文件定义当前仓库的 AI 编码助手规则。代码和代码注释使用英文；聊天、计划、设计说明、验证记录、提交说明草稿使用中文。引用命令输出、错误信息、API、文件名、代码标识符时保留原文。

## 0. 当前仓库注意事项

- 设计目标：`BillBoard` 是两人家庭记账应用，核心体验是快速记录、按家庭成员视角查看、按时间范围复盘。所有改动必须服务这些目标，避免新增无关页面、复杂配置或泛化场景。
- 产品风格：保持现有移动优先、清爽直接、默认中文并支持英文切换的应用形态。新增 UI 文案必须同步 `src/lib/i18n.ts` 的双语文案；新增交互优先减少记账阻力和查看成本，不做营销化、装饰化设计。
- 业务约束：金额以整数分 `amountFen` 处理；交易按 `Asia/Shanghai` 做日期和范围计算；有效记录查询必须排除软删除数据；家庭数据访问必须基于当前 session 的 `householdId` 和 `memberId` 校验。
- 分类约束：默认分类由 `prisma/seed.ts` 维护；内置分类名在数据库中保存英文，中文 UI 仅通过 `src/lib/i18n.ts` 的 `getCategoryDisplayName` 做展示映射。新增内置分类时必须同步 seed、中文映射和相关测试。
- 内置账号：默认两人家庭账号由 `.env.example`、`prisma/seed.ts` 和 `podman-compose.yml` 的 bootstrap 环境共同维护；账号 A 为 `lehary@home.com` / `老公`，账号 B 为 `noma@home.com` / `老婆`，默认密码为 `10212286`。修改内置账号时必须同步这些位置和 e2e 登录测试。
- 验证方法：按改动范围选择最小充分验证。通用代码先跑 `npm run lint`；纯函数和组件逻辑跑 `npm run test:unit`；涉及 Prisma、server actions、认证或查询逻辑跑 `npm run test:integration`；涉及登录、导航、表单提交或端到端用户流程跑 `npm run test:e2e`。
- 测试环境：集成测试和 e2e 依赖 PostgreSQL 与 seed 数据；本地数据库优先用 `.\ops\podman\compose.ps1 -f podman-compose.dev.yml up -d db`，Linux/Bash 环境用 `bash ops/podman/compose.sh -f podman-compose.dev.yml up -d db`，开发 compose project 为 `billboard-dev`，默认开发库为 `billboard_dev`，seed 用 `npm run prisma:seed`。Playwright 默认使用 `http://127.0.0.1:2500` 并启动 `npm run dev`；e2e 会在测试开始前和结束后清空 `Transaction` 表，只能连接开发或测试数据库运行，禁止连接生产库。
- Windows Podman 排障：`Executing external compose provider "podman-compose"` 是信息提示，不是错误；若容器内 PostgreSQL 健康但 Windows 侧 Prisma 不能访问 `127.0.0.1:5432`，优先通过 `podman machine inspect` 的 SSH 参数建立 `127.0.0.1:15432 -> <db-container-ip>:5432` 隧道，并将 `DATABASE_URL` 指向 `postgresql://billboard:billboard@127.0.0.1:15432/billboard_dev?schema=public` 后再运行 migrate、seed 或 dev 服务。
- 启动服务测试：开发服默认使用 `2500`；正式服务默认通过生产 compose 暴露 `http://<host>:3000`，同时保留 `proxy` 的 `80/443 -> web:3000` 入口。当用户要求启动开发服务进行测试时，按访问方式选择 host。局域网直连优先绑定当时机器的局域网 IP；若 frpc 或隧道配置指向 `127.0.0.1:2500`，必须绑定 `0.0.0.0` 或确认 `127.0.0.1:2500` 正在监听。通过外网 IP 或域名访问 Next dev 时，必须确认 `next.config.ts` 的 `allowedDevOrigins` 包含该 host，否则客户端 JS/HMR 可能被拦截，登录表单会退化为普通 GET 提交。

## 1. 实现前先思考

禁止假设，禁止掩盖不确定性，必须说明关键权衡。

- 开始实现前，先列明假设。
- 需求存在多种解释时，先列出解释并询问。
- 存在更简单方案时，先说明更简单方案。
- 上下文不足时，停止实现，说明缺口并询问。

## 2. 简单优先

使用解决问题的最小代码，禁止推测性扩展。

- 禁止添加用户未要求的功能。
- 禁止为单次使用场景创建抽象。
- 禁止添加未要求的配置项或扩展点。
- 禁止为不可达场景增加错误处理。
- 代码能明显缩短时，先简化再提交。

自检标准：资深工程师认为方案过度复杂时，必须简化。

## 3. 外科手术式修改

只修改完成当前请求所需的内容，只清理本次改动引入的问题。

- 禁止顺手改进相邻代码、注释或格式。
- 禁止重构无关代码。
- 必须匹配既有风格。
- 发现无关死代码时，仅在回复中说明，禁止删除。
- 移除本次改动造成的未使用导入、变量、函数。
- 禁止删除本次改动前已存在的死代码，除非用户明确要求。

检验标准：每一行改动都必须直接对应用户请求。

## 4. 目标驱动执行

把任务转化为验证目标，并循环到验证完成。

- “添加校验” -> 先写无效输入测试，再让测试通过。
- “修复 bug” -> 先写复现测试，再让测试通过。
- “重构 X” -> 重构前后都运行相关测试。

多步骤任务必须先给出简短计划：

```text
1. [步骤] -> verify: [检查方式]
2. [步骤] -> verify: [检查方式]
3. [步骤] -> verify: [检查方式]
```

含糊目标必须先澄清，再执行。

## 5. 版本号与提交

项目使用三段式版本号：`vX.Y.Z`。提交信息带 `v` 前缀；项目版本字段不带 `v` 前缀。

- `X` 为主版本号。仅在用户明确指定时修改。
- 当版本号小于 `1.0.0` 时，框架、数据结构、数据库相关改动无需考虑对旧版本的兼容性问题；默认以当前代码和数据模型为准直接演进。
- `Y` 为功能版本号。每次 feature 提交递增 `Y`，并将 `Z` 置为 `0`。
- `Z` 为修复版本号。每次 bugfix 提交递增 `Z`。
- 文档提交按文档本身解决的问题判定版本递增：feature 文档按 feature 递增，bugfix 文档按 bugfix 递增。
- 非 feature 或 bugfix 提交，提交前先确认版本递增方式。
- 每次提交必须同步更新项目版本字段：`package.json` 的 `version`。
- lockfile 含根项目版本字段时，必须同步更新。
- 项目版本字段缺失时，先补充字段，再提交。
- 开发完成后必须跑完整验证：`npm run lint`、`npm run test:unit`、`npm run test:integration`、`npm run test:e2e`。全部通过后，可以直接在 `master` 提交并合并远端 `master`；未全通过禁止提交或合并。
- 提交前检查当前分支与 `origin/master` 的提交差异。如果多个差异提交属于同一个 feature 或 bugfix，必须整理成一条符合版本号规则的提交；不同目的的提交禁止强行合并。

提交信息格式：

```text
v0.1.0 一句话描述

详细描述，最多 256 个字符。多段描述的总长度仍不得超过 256 个字符。
```

提交前必须检查：
- 提交类型与版本号递增一致。
- 项目版本字段与提交信息版本号一致。
- 详细描述不超过 256 个字符。
