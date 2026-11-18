# 招商银行 PDF 流水导入设计

日期：2026-07-13

Planning Mode: Full

## 1. 背景与目标

BillBoard 已在 `/records/import` 支持随手记 `.xlsx`、微信支付 `.xlsx` 和支付宝 `.csv`，并具备导入草稿、家庭成员映射、分类映射、同源去重、疑似重复复核、逐行跳过和批量确认能力。本功能把招商银行官方借记卡交易流水 PDF 接入同一条导入流程，减少家庭成员手工补录银行账户收支的成本。

样本只用于本地确认版式特征：文件带可选择的文本层，表格包含记账日期、货币、带符号交易金额、联机余额、交易摘要和对手信息。文档、测试和 fixture 不记录样本文件名、户名、账号、验证码、余额或真实交易内容。

## 2. 已确认范围

- 首期来源标识为 `cmb`，中文名称为“招商银行”。
- 仅支持与已验证样本同版式的招商银行官方借记卡交易流水 PDF，支持相同版式的多页文件。
- 不支持信用卡账单、扫描件、OCR、其他招商银行 PDF 版式或其他银行。
- 所有流水进入草稿；疑似转账、理财、证券、还款等资金移动默认不导入，但用户可以恢复导入。
- 分类映射按 `source|transactionType|交易摘要|对手信息` 在同一家庭内记忆复用。
- 户名映射已有记录时自动复用；首次出现或无法匹配时必须选择家庭成员，确认前不得静默采用当前登录成员。
- 仅 `CNY` 可导入；其他币种计入不可导入行，不做汇率换算。
- 导入交易备注只保留交易摘要和对手信息；不保存账号、余额、验证码或完整原始行。
- 原始 PDF 仅在上传请求内以内存 `Buffer` 解析，不落盘、不写日志、不进入事件 metadata。

## 3. Requirements

### FR-001 来源与上传入口

`/records/import` 增加 `cmb` 来源和 `.pdf` 文件校验，继续沿用 20 MB 上传限制。页面和服务端都必须保留显式来源选择；不得根据文件内容自动切换来源。

### FR-002 格式识别与失败关闭

解析器必须验证官方标题、A4 页面尺寸容差、中文表头、列锚点和分页结构。加密 PDF、无文本层、表头缺失、页间版式不一致、核心列错位或部分页面无法可靠重建时，整体上传失败且不生成草稿。不得降级到 OCR 或猜测性导入。

### FR-003 坐标解析与字段转换

解析器从本地 `Uint8Array` 读取每页文字项及其 `transform`/`width` 坐标，按表头锚点划分列、按纵坐标聚合行，并把对手信息的续行合并到上一笔交易。PDF.js 官方 `TextItem` 提供 `str`、`transform`、`width` 和 `height`，满足此布局重建需求：

- https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib.html
- https://github.com/mozilla/pdf.js/wiki/Setup-pdf.js-in-a-website

字段转换规则：

- 规范化 ASCII `-`、Unicode minus、千分位和空白后解析交易金额。
- 金额为负映射 `EXPENSE`，金额为正映射 `INCOME`；持久化值取绝对值并精确转换为整数分 `amountFen`；零金额不可导入。
- 日期只含年月日，按当日 `00:00:00 Asia/Shanghai` 构造 `occurredAt`，同时保存 `occurredAtDate`。
- 仅 `CNY` 生成可导入行；其他币种生成 `INVALID` 行。
- `primaryCategory` 保存规范化交易摘要，`secondaryCategory` 保存规范化对手信息。
- 最多解析 500 页和 20,000 个候选交易行，任一上限超出时整体拒绝。

### FR-004 疑似资金移动默认跳过

当交易摘要命中保守关键词集合（包含转账、汇款、银证、证券、理财、基金、还款、存管、保证金、结汇、购汇），或规范化对手信息与 PDF 户名一致时，解析器输出 `defaultSkipReason`。草稿初始化为 `USER_SKIPPED/SKIP`，但保留完整分类、成员、重复候选和指纹信息。用户选择导入后，行必须回到现有 `NEEDS_MAPPING`、`POSSIBLE_DUPLICATE` 或 `READY` 状态，不得绕过分类、成员映射或重复复核。

### FR-005 分类映射

招商银行分类映射键固定为：

```text
cmb|EXPENSE|交易摘要|对手信息
```

映射只允许选择当前启用且类型匹配的现有分类，不创建分类，并继续按当前 session 的 `householdId` 隔离。默认跳过行不阻塞确认；恢复导入且没有映射时才进入 `NEEDS_MAPPING`。

### FR-006 账单归属成员

解析器把 PDF 户名写入可导入行的 `rawMember` 和 `rawCreatedBy`，复用现有 `ImportMemberMapping` 和成员映射表单。已有 `cmb` 映射自动复用；未命中时行带 `fallbackApplied=true`，页面要求用户保存家庭成员映射，确认逻辑继续阻止未解决映射。服务端只接受当前 session 家庭内的成员 ID。

### FR-007 备注与隐私

可导入交易的备注格式为：

```text
招商银行：<交易摘要>；对手信息：<对手信息>
```

空片段不写入。账号尾号、联机余额、验证码、申请时间、完整原始行和上传文件名不得进入 `Transaction.note`、`ImportDraft.fileName`、事件 metadata、日志、URL 或客户端持久化。`ImportDraft.fileName` 使用固定值 `cmb.pdf`。原始 PDF 在解析完成或失败后均不得保留。

### FR-008 来源指纹与重复处理

`sourceFingerprint` 对来源、收支类型、原始日期、规范化带符号金额、户名、交易摘要、对手信息、币种、联机余额和脱敏账号做 SHA-256。账号和余额只参与内存中的哈希输入，不以明文写入草稿或交易。同一家庭的 `cmb + sourceFingerprint` 精确去重包含软删除交易；跨来源或手工记录继续按同日同金额进入现有疑似重复流程并默认不导入。

### FR-009 权限、完整性与确认

上传、草稿读取、成员映射、分类映射、逐行决策和确认全部从有效 `AppSession` 派生 `householdId` 与 `memberId`。不得信任客户端传入的家庭归属。确认继续使用现有批量查询、分块写入、幂等冲突处理和 120 秒 transaction timeout；不新增逐行数据库事务。

### FR-010 页面、错误与 i18n

上传页、来源标签、文件说明、默认跳过说明和错误提示必须同步中文与英文。至少区分：

- `unsupported-cmb-file`：招商银行仅支持 `.pdf`。
- `unrecognized-cmb-file`：无法识别招商银行流水格式。
- 现有 `file-too-large` 和通用上传失败。

页面明确提示疑似资金移动默认不导入且可恢复。其他来源的文案、文件类型和行为保持不变。

### FR-011 依赖、fixture 与回归验证

使用 Mozilla 维护的 `pdfjs-dist` 作为服务端文本坐标解析依赖。生产 `Containerfile` 使用 Node 22；实现必须验证 PDF.js Node 运行、Next standalone bundling 和离线本地 `Buffer` 解析，不允许通过 URL 获取 PDF 或字体资源。依赖变更必须审查 `npm audit --json`。

测试 PDF 必须从零生成并只包含占位户名、脱敏账号和示例交易，禁止从用户样本遮盖后复用，因为遮盖不保证移除隐藏文本。测试覆盖单页、多页、续行、正负金额、Unicode minus、非 CNY、格式失败、加密/无文本层错误、默认跳过与恢复、成员映射、分类记忆、软删除去重、权限隔离和完整 E2E。

### FR-012 发布与验收

本功能是 feature，项目版本从 `1.25.1` 升到 `1.26.0`，`package.json` 与 `package-lock.json` 根版本同步。实现完成后必须运行 lint、unit、integration、e2e、build、依赖审计和 `skills/billboard-security-review/SKILL.md`，再按仓库门禁在 `master` 上提交、推送、重启正式服务并执行登录页 smoke check。

## 4. 架构与数据流

```text
Upload .pdf
  -> server action validates source/extension/size/session
  -> parseCmbPdf(Buffer)
       -> PDF text items with coordinates
       -> page/header/layout validation
       -> row reconstruction and normalization
       -> ParsedImportWorkbook
  -> createImportDraft
       -> household-scoped mappings and duplicates
       -> default USER_SKIPPED decisions
       -> ImportDraft / ImportDraftRow
  -> existing preview, mapping, decision and confirm flow
  -> Transaction(source=cmb, sourceFingerprint, sourceImportedAt)
```

只新增招商银行 source adapter 和承载默认跳过所需的最小通用字段，不建立插件注册系统，不新增 Prisma 模型或 migration。

## 5. Non-goals

- 不自动识别或导入其他招商银行 PDF。
- 不支持密码解密、扫描件或 OCR。
- 不保存银行余额，不做余额对账。
- 不新增 transfer 类型、账户模型、多币种模型或汇率服务。
- 不自动创建或 AI 猜测分类。
- 不上传 PDF 到第三方服务，不引入遥测或远程日志。
- 不修改现有三种来源的分类粒度、成员归属或重复语义。

## 6. Assumptions

- 同版式文件的中文表头和列顺序稳定，分页页眉重复，文字层能够返回可靠坐标。
- 招商银行流水没有稳定交易 ID；组合指纹是当前可用的最强同源标识。
- 日期精度只有天，使用上海时区零点不会改变日期范围统计。
- `pdfjs-dist` 的 Node 22 支持必须以仓库实际 build 和 standalone smoke 为准，而不是仅依赖文档声明。

## 7. Residual Risks

- 银行在不改标题的情况下调整字体编码、坐标或分页细节，可能导致格式识别失败；失败关闭可防止错误入账，但需要新样本后再扩展。
- 同日、同金额、同摘要、同对手和同余额的极端重复交易可能产生相同指纹；草稿预览和源重复计数仍是人工复核缝隙。
- 对手信息作为备注会持久化一项敏感财务上下文；安全测试必须证明账号、余额、验证码和完整原始行未随之保存。
- PDF.js 可能增加 standalone 体积或需要额外构建配置；实现阶段必须以 Node 22 容器 smoke 和生产重启结果验收。

## 8. Planning Quality Status

Planning Quality Status: Pass
