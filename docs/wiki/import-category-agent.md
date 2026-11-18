> 摘要：导入分类推荐由独立容器调用 WheelMaker Hub（Codex）的 Responses API；仅预填建议，由用户保存家庭共享映射。

# 导入分类 Agent

分类推荐服务于四种账单来源的现有映射组。页面点击“智能推荐”后，Agent 可建议已启用且收支类型匹配的分类，或明确建议“忽略”；无法判断时保持空白。已有规则和用户选择优先，建议只保存在当前表单，保存和最终确认入账仍为现有独立操作。

## 数据与职责

BillBoard 服务端从有效 AppSession 派生家庭／成员，校验草稿和分组，再提供来源、收支类型、原分类／交易对方、至多少量商品描述及候选分类。使用任务内匿名 ID，不发送原始文件、原始备注、金额、日期、成员、账号、订单号、指纹或历史账本。

最小化输入经 WheelMaker Hub（Codex）的 Responses API 处理，不自动重试或切换后备供应商。商品描述和原分类属于账单数据，必须作为不可信数据处理；不能赋予其工具指令权限。Agent 不访问账本数据库，推荐结果在回填前重新经过服务端校验。

## 运行边界

智能推荐的新批次要求当前账号本人已选择 AI 处理，并通过数据库共享的全局／家庭／成员额度。关闭选择后，服务端已受理的原批次可在原时限内完成，尚未提交的后续批次按新任务拒绝；客户端旧状态不授予准入。推荐返回前复核原身份、草稿目标与租约，迟到结果不能越过失效权限。拒绝或繁忙保留已有选择，手工映射和原导入草稿继续可用。

`import-agent` 是独立容器，通过内部受认证接口接收任务，统一调用 WheelMaker Hub 的 `POST /v1/responses`。BillBoard 不启动 Codex CLI，不挂载宿主机用户目录、项目或 Docker socket，不接收应用或数据库凭据，不增加公网端口。

每批最多 25 个分组、每组最多 3 条商品文本、每个文本最多 200 字符。HTTP 输入上限 256 KiB，建议 JSON 上限 64 KiB。每批总预算 45 秒，应用等待最多 55 秒；迟到结果丢弃，实际公网转发超时须独立核验。单容器同时处理一个任务，忙碌时返回可重试错误。页面按批串行调用，失败保留此前已填结果。

每次任务新建独立请求，设置 `ephemeral: true`、`store: false`，不发送或复用 `X-WheelMaker-Session-Id`。Hub 的受限 Chat 运行策略负责原生 Agent 权限与会话清理；临时模式不表示上游服务零留存。容器根目录只读，临时目录使用 tmpfs，非 root 进程有内存与进程数量限制。升级不再挂载专用 Codex 认证卷，也不删除已有 Docker 卷的数据。

`agent-backend` 是 web 与 Agent 的内部网络，`agent-egress` 用于请求 WheelMaker API，Agent 不加入数据库网络。web 仅配置内部 `IMPORT_AGENT_URL` 与 `IMPORT_AGENT_TOKEN`；内部 token 不传给模型供应商。`WHEELMAKER_BASE_URL` 和 `WHEELMAKER_API_KEY` 仅注入 Agent，不传给 web、OPS、浏览器或镜像构建参数；真实地址和 Key 只放在未跟踪的私有 env。

分类与自然语言记账共用服务端配置：`WHEELMAKER_BASE_URL` 是私有 HTTPS `/v1` Base URL，例如 `https://chat-api.example.com/v1`；`WHEELMAKER_API_KEY` 是 Hub 签发的调用密钥。`IMPORT_AGENT_MODEL` 默认 `gpt-6-luna`，`IMPORT_AGENT_REASONING_EFFORT` 默认 `high`，均不接受页面传值。Key 的 Agent 绑定、上游登录及权限由 Hub 管理；BillBoard 无需设备登录，也不再使用旧供应商选择和 DeepSeek 回退配置。

[AI 对账](ai-bill-analysis.md) 复用此容器与传输，但使用独立 `BILL_ANALYSIS_AGENT_*` 模型配置和长任务预算，不改变本页分类推荐的数据范围和时限。三类任务共享数据库 AI 并发与窗口；对账持有执行占用时，新分类/自然语言请求可能提示繁忙，手工输入和映射仍可使用。

Responses 的完成状态、助手文本与任务 JSON 都须在应用侧校验，拒绝未完成结果、工具或图片输出、畸形 JSON、越界分类与超限正文。Hub 接受的输出 token 参数不构成实际长度保证，应用有界读取及现有业务协议校验仍是结果边界。

取消、超时、断开或服务关闭时，BillBoard 将取消传到 HTTP 请求，并等待本地请求与清理结束再释放自己的执行占用；Hub 收到取消后负责停止或隔离原生运行器，并等待其清理后释放 Hub 占用。现有 API 不提供调用方可查询的远端清理完成确认，不能保证 BillBoard 数据库占用的释放严格晚于 Hub 清理完成；本次接入按已确认的 HTTP 服务边界处理，不增加跨仓库确认接口或永久占用状态。

## 运维与验证

构建、启动和私有 API 配置见 [README](../../README.md#导入分类智能推荐)，运行边界见 [部署检查表](../runbooks/home-network-checklist.md)。`/health` 只检查服务进程，不代表 Key 有效、Hub 在线或模型调用成功。服务失败或预算用尽时返回固定错误，页面提示继续手工映射；修复配置后可主动重试剩余空白组，不暴露供应商原始响应或凭据。

业务集成测试连接开发数据库并用真实本地 HTTP fixture 替代模型边界，验证推荐不写入映射或账本。Responses 适配测试覆盖两类任务、请求格式、认证错误、异常输出、长度限制、取消传播、超时和迟到结果；浏览器测试使用测试专用 HTTP Agent。真实链路 smoke 只使用合成分类与自然语言输入，不发送真实账本，不以 `/health` 代替模型调用。

设计依据：[已确认 spec](../scope/2026-10-10-agent-import-category-mapping.md)。
