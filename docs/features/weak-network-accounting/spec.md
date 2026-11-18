# 弱网记账体验优化规格

状态：Confirmed
日期：2026-07-17
Planning Mode：Full

## 1. 背景与问题

BillBoard 的核心路径是 `/home -> /add -> 保存交易`。当前实现会在弱网下叠加三类等待：

- `/home` 使用的五张运行时装饰 PNG 合计约 7.16 MB（十进制），`/add` 标题 PNG 约 1.16 MB；这些图片使用原始 `<img>`，首页卡片图片未声明 lazy loading，标题图片还使用 `fetchPriority="high"`。
- 应用路由没有 `loading.tsx`；底部导航拦截 Link 点击后直接调用 `router.push`，服务端数据未返回时缺少稳定的 pending 反馈。
- `/add` 保存成功后通过 `redirect("/add?..." )` 再次执行 session 校验、页面事件记录和三组数据查询。响应不确定时也没有可证明不会重复记账的重试键。

本规格只解决“有网络但高延迟、低带宽、偶发传输中断”场景，不扩展为离线账本。

## 2. 已确认目标

- 让登录后的 `/home -> /add` 路径在弱网下尽快出现可理解、可操作的界面。
- 点击保存后立即反馈状态，不通过整页重定向确认成功。
- 刷新或临时网络故障不丢失当前标签页草稿。
- 对结果不明确的保存使用同一请求标识安全重试，确保最多创建一条交易。
- 保持现有家庭隔离、金额、时间、分类类型、软删除和手工/导入来源规则。

## 3. Scope

### 3.1 In scope

- `/home` 与 `/add` 的六张运行时装饰图片及其加载优先级。
- 应用内导航 pending 状态与 `(app)` 路由 loading boundary。
- `/home`、`/add` 在 session 校验后的可并行页面工作。
- `/add` 表单的 `sessionStorage` 草稿、保存状态机和成功重置。
- 手工交易创建的 `clientRequestId`、Prisma migration、幂等冲突处理。
- Server Action 成功结果、页面数据失效与 AppEvent 去重。
- 中英文弱网文案、unit、integration、e2e、构建、性能和安全验证。

### 3.2 Non-goals

- 不增加 Service Worker、离线打开、后台自动同步或待同步队列。
- 不把历史记录、报表、session token、凭据或导入原始内容存入浏览器持久化存储。
- 不重构导入、交易编辑、交易删除、登录协议或整个应用为 client-first API/SPA。
- 不增加外部遥测、远程日志、第三方性能 SDK 或新依赖。
- 不在缺少测量证据时重写首页报表查询。
- 不修改生产公网入口、真实域名、frp/nginx 拓扑或凭据配置。

## 4. Functional requirements

### FR-001 装饰资源预算与优先级

- 首页标题和四张汇总卡插画、记账页标题插画必须使用与实际显示尺寸匹配的预压缩 WebP 静态资源。
- 六张资源通过 static import 进入带 content hash 的 `/_next/static/media`；不依赖首次请求时的运行期图片转码。
- 首页五张运行时装饰资源总大小不得超过 250 KiB；`/add` 标题资源不得超过 50 KiB。
- 这些图片均为纯装饰，必须保留空 `alt`/`aria-hidden`，使用低优先级 lazy loading，不得保留 `fetchPriority="high"`。

### FR-002 导航即时反馈与 loading boundary

- 用户点击应用导航后，100 ms 内必须看到目标导航项 pending 反馈，不等待网络响应。
- 新增 `(app)` loading boundary，在 RSC 页面等待期间显示保持布局稳定的轻量 skeleton。
- `/home`、`/add`、`/records` 之间继续保留现有共享筛选参数；不得为 pending 状态引入额外页面或 query 参数。
- pending 状态必须能通过 `aria-busy` 或等价语义被辅助技术识别。

### FR-003 页面服务端等待收敛

- `/home` 和 `/add` 仍须先完成 `requireAppSession()`；认证成功后，页面事件记录不得串行阻塞能够并行开始的数据读取。
- 页面事件仍保持 best-effort 和现有脱敏规则；优化不能降低 session、`householdId` 或 `memberId` 边界。
- 在 400 Kbps 下行/上行、800 ms RTT、正常本地服务端条件的实验环境中，从应用内点击 `/add` 到表单可操作的目标为 3 秒内。

### FR-004 当前标签页草稿

- 草稿存储使用版本化、按当前 `memberId` 隔离的 `sessionStorage` key。
- 草稿仅包含类型、金额、分类、成员、上海时间输入、备注、`clientRequestId`、提交确认状态和保存时间。
- 页面刷新、语言切换或 session 过期跳转不得主动删除草稿；保存成功必须立即删除草稿，关闭标签页后由浏览器清除。
- 恢复草稿时必须用当前服务端返回的成员和启用分类选项重新校验引用；无效引用回退到安全默认值。
- `sessionStorage` 不可用、内容损坏或版本未知时，表单必须继续以内存状态工作，不能阻止记账。

### FR-005 无重定向保存与本地成功重置

- `submitTransaction` 成功后直接返回结构化结果，不得再重定向 `/add` 或把金额、类型、成功标记写入 URL。
- 客户端点击保存后立即显示“保存中”；3 秒仍未完成时显示“网络较慢，仍在保存”。全部新增可见文案必须同步中英文。
- 成功结果至少包含 `transactionId`、`clientRequestId`、`amountFen` 和交易类型。
- 成功后保留当前 URL 的共享筛选参数，并在客户端按现有行为重置为：支出、当前成员、当前上海时间、默认支出分类、空金额、空备注和折叠分类区。
- 成功 Toast 继续显示本次交易类型和金额，且不增加后续操作链接。

### FR-006 手工交易创建幂等

- `Transaction` 新增可空 `clientRequestId`，数据库列名为 `client_request_id`。
- `(createdByMemberId, clientRequestId)` 必须有数据库唯一约束；PostgreSQL 中历史记录和导入记录的 `null` 值无需回填且可重复存在。
- 手工提交的 `clientRequestId` 必须是客户端生成并由服务端 schema 校验的 UUID；`createdByMemberId`、`householdId` 仍只从 session 派生。
- 相同创建人、相同 `clientRequestId` 和相同规范化 payload 的串行或并发重试必须返回同一交易，并区分本次是否实际创建。
- 相同创建人和 `clientRequestId` 携带不同 payload 时必须返回幂等冲突，不能静默返回不匹配交易，也不能创建第二条交易。
- 只有首次实际创建允许尝试写入一个 `TRANSACTION_CREATED` AppEvent；幂等命中不得重复写事件。
- 手工交易的 `source`、`sourceFingerprint`、`sourceImportedAt` 继续保持 `null`；导入流程不要求提供 `clientRequestId`。

### FR-007 结果不明确状态

- 提交前必须生成并持久化不可变提交快照；提交期间表单字段保持可见但不可修改。
- 服务端明确返回校验或保存失败时，解除冻结并保留草稿；用户修改后必须清除旧 `clientRequestId`，下次提交生成新 ID。
- Server Action 调用发生传输拒绝，或页面在待确认状态刷新时，客户端进入“保存结果尚未确认”状态并继续冻结原快照。
- 未确认状态只允许使用相同 payload 和相同 `clientRequestId` 重新确认，或由用户进入记录页核对；不得自动提交或静默生成新 ID。
- `navigator.onLine` 只能用于辅助提示，不能作为是否允许提交或是否成功的依据。

### FR-008 安全与财务完整性

- 交易创建继续调用 `requireAppSession()`，并用 session 的 `householdId`、`memberId` 校验创建人、归属成员和交易写入范围。
- 客户端不得传入或覆盖 `householdId`、`createdByMemberId`、用户 ID、角色或来源元数据。
- 持久化金额继续只使用整数 `amountFen`，日期继续按 `Asia/Shanghai` 解析，分类类型必须匹配交易类型。
- `clientRequestId` 不得进入 URL、AppEvent metadata、客户端日志、记录列表、报表或外部分析系统。
- 浏览器存储不得新增历史财务明细、session token、凭据、导入数据或 `sourceFingerprint`。

### FR-009 保存后的数据新鲜度

- 创建成功后必须使 `/home` 和 `/records` 的客户端/服务端页面数据失效，避免下一次导航命中创建前的预取结果。
- 失效操作不得触发当前 `/add` 页面整页刷新；记录页和首页下次进入时必须读取到新交易。

### FR-010 验证、兼容与发布

- 自动化测试必须覆盖资源预算、草稿解析/隔离/损坏降级、Action 结果、幂等串行与并发命中、payload 冲突、AppEvent 至多一次、保存成功不重定向、慢网络状态和结果不明确重试。
- 弱网实验条件为 400 Kbps 下行/上行、800 ms RTT；导航和保存状态反馈目标为 100 ms 内，慢网络说明在约 3 秒出现，正常服务端条件下保存确认目标为 4 秒内。
- 绝对时延目标使用可重复的 Chromium/Playwright 或浏览器实验记录验证；CI 使用资源字节预算和确定性延迟验证状态机，避免依赖宿主性能的脆弱 wall-clock 断言。
- migration 必须先于新应用部署；字段可空、无历史回填，旧应用回滚后仍可继续写 `null`。
- 本功能属于 feature，提交前项目版本从 `1.26.1` 更新为 `1.27.0`，并通过仓库规定的完整验证和安全审查。

## 5. 稳定契约

### 5.1 `TransactionDraftV1`

客户端草稿契约包含：

- `version: 1`
- `memberId: string`
- `payload`: `type`、`amount`、`categoryId`、`actorMemberId`、`occurredAt`、`note`
- `clientRequestId: string | null`
- `confirmationStatus: "draft" | "awaiting-confirmation"`
- `savedAt: string`

存储 key 需要版本号和当前成员 ID。恢复时只接受版本、成员、字段类型和当前选项全部有效的值。

### 5.2 `IdempotentTransactionCreateResult v1`

`createTransaction` 返回：

- 交易的 `id`、`amountFen`、`type`、`clientRequestId`
- `wasCreated: boolean`

唯一冲突命中后必须读取当前 session 创建人的既有交易并比较规范化 payload；完全一致返回 `wasCreated: false`，不一致返回稳定的幂等冲突错误。

### 5.3 `CreateTransactionActionResult v1`

服务端 Action 结果为：

- `idle`
- `success`: `transactionId`、`clientRequestId`、`amountFen`、`type`
- `error`: 本地化 `message` 与可区分校验/保存失败的稳定错误类别

`unknown`、`submitting` 和 `slow` 属于客户端 UI 状态，不由服务端伪造返回。session 无效继续重定向 `/login`。

## 6. UX 状态机

```text
idle/dirty
  -> submitting（持久化 awaiting-confirmation 快照，冻结字段）
  -> slow（3 秒，仅改变提示）
  -> success（清草稿、重置表单、Toast、失效 home/records）
  -> explicit-error（保留草稿、解除冻结、允许修改）
  -> unknown（保留并冻结快照、同 ID 重试或去 records 核对）
```

如果组件在请求返回前卸载或页面刷新，`awaiting-confirmation` 快照在下一次进入 `/add` 时恢复为 `unknown`，但不会自动发送。

## 7. Rollout 与回滚

1. 在开发/测试数据库应用 migration 并生成 Prisma Client。
2. 完成 targeted tests、完整 test suite、构建、弱网实验和安全审查。
3. 提交前更新版本为 `1.27.0`，确认工作区只有本功能文件。
4. 生产环境先通过现有 bootstrap/migration 入口执行 `prisma migrate deploy`，再部署/重启 web。
5. 通过现有 nginx 根路径入口或 Windows loopback fallback 做登录页与记账 smoke；不得新增真实 host 到跟踪文件。

回滚旧应用时保留可空列和唯一索引；旧应用继续写入 `null`。如果需要删除列，必须另行设计且不属于本功能。

## 8. Assumptions 与 residual risks

- 目标浏览器支持 `sessionStorage` 和 `crypto.randomUUID()`；不可用时降级为当前标签页内存状态并提示普通保存失败，不增加 polyfill 依赖。
- 用户已明确接受金额和备注草稿在当前标签页的 `sessionStorage` 中暂存；同源脚本、浏览器扩展或可操作该设备的人仍可能读取它，这是已知残余风险。
- WebP 允许有损压缩，但必须通过移动端视觉 smoke 确认插画没有明显伪影。
- 严格的 3 秒/4 秒绝对目标可能受生产网络和服务端负载影响；实现阶段应记录基线和三次实验结果，不能通过放宽状态反馈要求掩盖失败。
- AppEvent 是 best-effort；要求是幂等重试不产生重复事件尝试，不把事件成功写入作为交易成功条件。
