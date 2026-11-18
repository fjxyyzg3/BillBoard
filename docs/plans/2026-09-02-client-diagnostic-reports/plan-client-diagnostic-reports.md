# Client Diagnostic Reports Implementation Plan

> 状态：已完成
> 来源规格：docs/scope/2026-09-02-client-diagnostic-reports.md
> 目标分支：codex/client-diagnostic-reports

## 目标与假设

实现已批准的“客户端诊断现场上报”功能：用户主动打开低干扰反馈入口时，冻结最近 60 秒的受控诊断事件；客户端仅提交符合固定 schema、脱敏且不包含账本业务数据的报告；服务端按当前 session 绑定家庭和成员、执行幂等与每日限流；agent 使用独立 bearer token 拉取 OPEN 问题、读取详情并幂等标记 RESOLVED。

假设：

- 现有 Prisma 数据库为 PostgreSQL，迁移由仓库既有 Prisma 流程执行。
- 诊断提交沿用当前 AppSession 认证；agent 接口不复用 OPS cookie。
- 不引入第三方监控 SDK，不新增本地或 session storage，不自动上传。
- 诊断报告的 schema 和 UI 文案是本次功能所需的最小新增内容。
- 按仓库 Git 偏好，本功能最终合并为一个 feature 提交并递增版本到 1.32.0。

## 技术方案

- Prisma 新增 ClientDiagnosticReportStatus 和 ClientDiagnosticReport，保存固定 schema 的 JSON、clientReportId 幂等键、session 派生 household/member、OPEN/RESOLVED 状态和时间索引。
- 浏览器内存 recorder 保存最多 60 秒或 100 个事件；导航采用 navigationId、latest-intent-wins、superseded/route_error/stalled 明确终态；错误仅映射到固定 name、messageCode 和受限 stackFrames。
- Zod strict schema 同时约束客户端生成和服务端接收，报告总 JSON UTF-8 字节数不超过 64 KiB，事件不超过 100、错误不超过 20、路径使用固定枚举。
- 用户入口位于现有桌面/移动导航版本附近，打开即冻结快照；取消不触发诊断请求，提交失败只保留当前内存快照供重试。
- Agent API 固定返回 diagnostic-agent.v1 wire contract，列表仅返回 OPEN 且不分页，详情仅返回 OPEN，resolve 幂等；token 缺失时 fail-closed。
- OPS 只展示受控诊断字段，不展示账户管理能力或账本内容；提交、OPS 访问和 agent 访问触发 30 天清理。

## 执行顺序

### Task 1：持久化、迁移、配置和项目 wiki

文件：

- prisma/schema.prisma
- prisma/migrations/20260902120000_add_client_diagnostic_reports/migration.sql
- .env.example
- podman-compose.yml
- tests/e2e/db-cleanup.ts
- docs/wiki/wiki.md
- docs/wiki/client-diagnostic-reports.md
- tests/integration/client-diagnostic-reports.test.ts

步骤：

1. 先写数据库模型、状态枚举、迁移与配置的失败测试，运行 npm run test:integration -- tests/integration/client-diagnostic-reports.test.ts，预期在实现前失败。
2. 实现模型、迁移、env 示例、web 容器透传和 e2e 清理；创建项目 wiki 索引与诊断功能页，记录数据边界、agent wire contract、生命周期和排障流程。
3. 运行 npx prisma generate、npm run test:integration -- tests/integration/client-diagnostic-reports.test.ts 和针对性文本安全检查，预期通过；记录工作单元 checkpoint。

验收：

- report 表有幂等键、状态、创建/解决时间、家庭/成员外键和查询索引。
- 配置只出现占位符，未写入真实 token、入口或凭据。
- wiki 可发现且与已批准规格一致。

### Task 2：固定 schema、脱敏和内存 recorder

文件：

- src/lib/diagnostics/schema.ts
- src/lib/diagnostics/sanitizer.ts
- src/lib/diagnostics/recorder.ts
- tests/unit/diagnostics-schema.test.ts
- tests/unit/diagnostics-sanitizer.test.ts
- tests/unit/diagnostics-recorder.test.ts

步骤：

1. 写 Zod schema、脱敏和 recorder 的 RED 测试，覆盖 unknown rejection、固定错误枚举、URL 文件名净化、60 秒/100 事件上限、导航 superseded/stalled/settled/route_error 和快照冻结。
2. 实现纯函数与浏览器内存 recorder，注释使用英文，禁止保留原始 message、stack、query、body、金额、备注、DOM、IP、硬件或指纹。
3. 运行 npm run test:unit -- tests/unit/diagnostics-schema.test.ts tests/unit/diagnostics-sanitizer.test.ts tests/unit/diagnostics-recorder.test.ts，预期通过；记录 checkpoint。

验收：

- 任何报告都能由 strict schema 校验，越界/未知字段/错误索引/非法路径被拒绝。
- snapshot 只保留最近 60 秒、最多 100 个事件和 20 个错误，且不会修改之后产生的内存现场。
- 导航和异常事件可由 agent 直接按固定字段理解。

### Task 3：用户提交 action、限流、幂等和清理

文件：

- src/lib/diagnostics/reports.ts
- src/app/(app)/diagnostics/actions.ts
- tests/integration/client-diagnostic-reports.test.ts
- tests/integration/server-action-exports.test.ts

步骤：

1. 为 session 家庭/成员隔离、重复 clientReportId、跨成员冲突、Asia/Shanghai 自然日 5 次限流、30 天清理和稳定错误码补充 RED 测试。
2. 实现 server action：先确认 AppSession，再校验 strict report；以 serializable transaction 完成清理、幂等判断、配额判断和写入；不返回或记录原始诊断文本。
3. 运行 npm run test:integration -- tests/integration/client-diagnostic-reports.test.ts tests/integration/server-action-exports.test.ts，预期通过；记录 checkpoint。

验收：

- 客户端传入的 householdId/memberId 无效或不存在，服务端不会信任。
- 同一成员同一 clientReportId 重试只得到同一报告结果，不重复计数；不同家庭或成员冲突不泄露结果。
- 每位成员按 Asia/Shanghai 自然日最多 5 个新报告，30 天以上报告自动清理。

### Task 4：Agent API 与读取服务

文件：

- src/lib/diagnostics/agent-api.ts
- src/app/api/internal/diagnostic-reports/route.ts
- src/app/api/internal/diagnostic-reports/[reportId]/route.ts
- src/app/api/internal/diagnostic-reports/[reportId]/resolve/route.ts
- tests/integration/diagnostic-agent-api.test.ts

步骤：

1. 写 route handler 和 token 校验 RED 测试，覆盖缺 token/错 token、固定 schema、OPEN 列表排序、详情边界、过期清理、resolve 幂等和 no-store。
2. 实现 timing-safe bearer token 校验、固定错误 envelope、列表/详情/resolve；agent 只能访问诊断报告，不能通过这些接口访问账户或账本。
3. 运行 npm run test:integration -- tests/integration/diagnostic-agent-api.test.ts，预期通过；记录 checkpoint。

验收：

- GET 列表无分页、仅 OPEN、稳定按 createdAt/id 排序；详情仅 OPEN。
- POST resolve 对已 RESOLVED 报告返回原有 resolvedAt；缺失、过期或 schema 错误返回固定状态和错误码。
- token 缺失 fail-closed，比较使用 timing-safe 方式，响应 Cache-Control 为 no-store，日志不含 token 或报告内容。

### Task 5：App Shell 现场采集、导航状态和错误边界

文件：

- src/components/app-filters-provider.tsx
- src/components/diagnostic-feedback-provider.tsx
- src/app/(app)/error.tsx
- src/components/app-shell.tsx
- tests/unit/navigation-version-marker.test.tsx
- tests/unit/diagnostic-feedback-provider.test.tsx

步骤：

1. 为导航唯一 ID、状态转移、低干扰 global listeners、错误边界记录和取消不提交写 RED 测试。
2. 在现有导航 provider 中接入 recorder：每次 intent 生成 navigationId，旧导航 superseded，只有活动目标 pathname settled，路由错误边界写 route_error，等待超时写 stalled；监听 error/unhandledrejection/online/offline/visibilitychange，不上传。
3. 实现快照 context：打开时冻结 snapshot，失败可重试同一 snapshot，取消清除 UI 但不调用 action；实现 app route error boundary 的重试文案和 route_error 记录。
4. 运行 npm run test:unit -- tests/unit/navigation-version-marker.test.tsx tests/unit/diagnostic-feedback-provider.test.tsx，预期通过；记录 checkpoint。

验收：

- 现有 prefetch 仍可工作，但取消反馈不会产生诊断 action/API 请求。
- 导航交错时报告可区分 superseded、stalled、settled 和 route_error，不把网络/服务端等待猜成 route_error。
- 不使用 localStorage、sessionStorage、截图、DOM 快照或第三方 telemetry。

### Task 6：反馈入口、弹窗、国际化和端到端流程

文件：

- src/components/desktop-nav.tsx
- src/components/bottom-nav.tsx
- src/components/diagnostic-feedback-panel.tsx
- src/lib/i18n.ts
- tests/e2e/diagnostic-reports.spec.ts

步骤：

1. 写/调整组件测试和 e2e 测试，覆盖桌面与移动入口、打开快照、取消无请求、成功提交、失败重试和多语言关键文案。
2. 在版本附近加入低干扰反馈入口；弹窗明确列出上报字段与禁止填写的业务数据，userNote 最大 200 字，提交中防重复提交，成功展示报告编号，失败保留当前内存快照。
3. 运行 npm run test:unit -- tests/unit/navigation-version-marker.test.tsx、npm run test:e2e -- tests/e2e/diagnostic-reports.spec.ts，预期通过；记录 checkpoint。

验收：

- 桌面和移动端都能在当前页打开反馈；取消只关闭，不提交。
- 仅成功提交显示成功状态；失败后重试不重新采集旧现场，也不丢失当前快照。
- 所有新增 UI 文案在 src/lib/i18n.ts 中有中英文版本。

### Task 7：OPS 诊断列表、详情和生命周期展示

文件：

- src/lib/diagnostics/ops.ts
- src/lib/ops/dashboard.ts
- src/app/ops/page.tsx
- src/lib/i18n.ts
- tests/integration/ops-dashboard.test.ts
- tests/integration/ops-page-and-actions.test.ts

步骤：

1. 写 OPS 查询和页面 fixture 的 RED 测试，覆盖只展示受控诊断字段、OPEN/RESOLVED、30 天清理和不含账户/账本管理入口。
2. 实现 dashboard 查询和页面结构化展示：报告编号、时间、状态、版本、路径、导航摘要、事件类型/耗时、固定错误 code/frames 和用户补充说明；不展示敏感业务字段。
3. 运行 npm run test:integration -- tests/integration/ops-dashboard.test.ts tests/integration/ops-page-and-actions.test.ts，预期通过；记录 checkpoint。

验收：

- OPS 访问不会扩大到家庭账本交易或账户创建/删除/OPS 口令管理。
- 结构化诊断内容便于 AI/agent 读取，OPEN 报告可定位，RESOLVED 保留审计时间。

### Task 8：完整验证、版本和 Git 收尾

文件：

- package.json
- package-lock.json（如包含根版本字段）
- 本次实现涉及的文件

步骤：

1. 运行 npm run lint、npm run test:unit、npm run test:integration、npm run test:e2e、npm run build。
2. 运行仓库安全审查 skill，检查敏感字段、日志、token、真实入口、数据库/接口权限、文档和 compose env。
3. 检查 git diff 与 origin/master、确认只有本功能改动，更新版本到 1.32.0，按 Git 偏好创建 v1.32.0 feature 提交。
4. 在 master 完成 rebase/merge、推送并按仓库入口重启正式服务；执行健康检查或登录 smoke check；若任一步不满足仓库收尾条件，停止并报告原因。

验收：

- 全部必要验证通过，build 成功。
- 安全审查结果包含 Findings、Verification、Residual Risk。
- 分支、提交、推送、合并、清理和重启结果均有记录。
