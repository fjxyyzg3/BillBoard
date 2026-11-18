> 由 scope skill 于 2026-10-10 生成
> 状态：已批准 2026-10-10

# 招商银行 ZIP 账单导入

## 目标

让招商银行提供的带密码 ZIP 账单可以直接从 `/records/import` 进入现有招商银行导入流程，用户只需在上传时填写 ZIP 解压密码，不再手工解压 PDF。

## 决策基线

### 需求边界

- 招商银行来源继续支持现有官方借记卡 `.pdf`，新增带密码 `.zip`；其他账单来源的文件类型和行为保持不变。
- ZIP 上传时向用户索取解压密码。密码只用于本次上传请求，不能进入 URL、日志、事件 metadata、草稿、交易、浏览器持久化存储或错误信息。
- ZIP 必须能用用户提供的密码解压出且仅出一个 PDF；缺少密码、密码错误、ZIP 损坏、包含多个文件或不包含 PDF 时整体失败，不创建导入草稿。
- 解压后的 PDF 继续使用现有招商银行版式校验和解析、成员映射、分类映射、默认跳过、重复处理及批量确认流程。
- 直接上传 PDF 的现有兼容行为继续保留；招商银行导入草稿文件名继续使用固定的 `cmb.pdf`，不保存原始 ZIP 或 PDF 文件名。
- 上传失败只返回来源化、双语的错误提示，不显示 ZIP 内文件内容、账号、余额或解析异常细节。
- 不支持把 ZIP 内容自动识别为其他来源，不支持多 PDF 批量导入、扫描件、OCR、其他银行或信用卡账单。

### 技术决策

- 上传 action 按来源和扩展名显式分流：招商银行允许 `.pdf` 或 `.zip`，其他来源保持原校验；文件大小校验仍在读取内容前完成，并沿用 20MB 上限。
- 新增直接依赖 `@zip.js/zip.js`，使用其 Node.js API 在内存中读取带密码 ZIP，覆盖附件实际使用的 ZipCrypto 算法；不调用系统解压命令、不落盘、不访问网络。
- ZIP 适配器只负责密码解压、单 PDF 内容和解压结果大小边界校验，然后把 PDF `Buffer` 交给现有 `parseCmbPdf`。不改变 CMB 行解析、指纹或草稿状态机的数据契约。
- 解压过程使用有界输出，解压结果不能超过现有单文件限制；ZIP reader 在成功和失败路径都关闭。解压出的 PDF 只在当前请求内存中存在。
- 页面新增招商银行 ZIP 密码输入控件和格式说明；服务端再次校验密码是否提供，不依赖客户端控件作为安全边界。页面不把密码回填到重定向参数。
- 新增 ZIP 错误码映射和中英文文案；错误码只用于页面提示，不记录到事件 metadata。无需 Prisma schema 或 migration。
- 版本按 feature 规则从 `1.39.1` 升至 `1.40.0`，同步 `package.json` 和 `package-lock.json` 根项目版本字段。

## 设计视图

### 功能设计

用户进入 `/records/import` 并选择“招商银行”后，可以选择现有 PDF 或新的 ZIP 文件。上传区域说明招商银行 ZIP 需要密码，并提供密码输入框；直接上传 PDF 时密码可留空。提交后服务端根据文件扩展名选择解析路径：PDF 直接进入现有解析器，ZIP 使用本次填写的密码解压单个 PDF 后进入同一解析器。

正确密码和有效招商银行 PDF 会生成与现有 PDF 导入完全相同的草稿，后续继续进行成员映射、分类映射、复核和批量确认。缺少密码、错误密码或 ZIP 内容不符合单 PDF 约束时，页面回到上传入口并显示可重试的双语错误，不生成半成品草稿。

### 技术设计

#### 整体方案

`/records/import` 页面负责展示 `.pdf/.zip` 支持范围和密码输入；`uploadImportDraft` 负责来源、扩展名、大小、密码存在性和 session 校验；CMB ZIP adapter 负责内存解压和内容边界；`parseCmbPdf` 继续负责招商银行版式识别与行转换；现有 `createCmbImportDraft` 及后续 draft workflow 保持不变。

ZIP reader 只读取一个符合 `.pdf` 扩展名的文件，使用有界 writer 收集 PDF bytes；目录、多个文件、非 PDF 文件、解压超限或解压失败均以统一来源错误收敛。adapter 成功后只传递 PDF bytes，不传递 ZIP 密码或 ZIP 文件名。事件仍只记录已有的来源级上传事件 metadata `{ source }`。

#### 关键结构

- CMB 创建草稿输入增加仅服务端使用的可选 ZIP password；直接 PDF 路径不需要该字段。
- CMB ZIP adapter 暴露“解压并解析单 PDF”的服务端函数，错误使用内部 sentinel 区分密码/ZIP 失败与已有 PDF 格式失败，页面只看到固定 i18n 文案。
- 上传页面的 `accept` 扩展为 `.xlsx,.csv,.pdf,.zip`，但服务端仍按所选来源严格限制；招商银行以外上传 ZIP 继续被拒绝。
- 原有 `source: cmb`、`sourceFingerprint`、`amountFen`、成员归属和分类映射结构不变。

#### 实现流程

1. action 读取来源和文件扩展名，先拒绝不支持的组合或超过 20MB 的文件；招商银行 ZIP 缺少非空密码时直接返回密码缺失错误，不读取文件内容。
2. action 在有效 `AppSession` 下读取文件 bytes，将密码仅传入 CMB ZIP adapter；记录上传事件时只保留来源。
3. ZIP adapter 初始化 `@zip.js/zip.js` reader，使用用户密码读取目录，确认只有一个 PDF entry，并用有界输出解压；无论成功或失败都关闭 reader。
4. adapter 将内存中的 PDF bytes交给 `parseCmbPdf`。解析失败沿用现有失败关闭行为；成功结果交给 `createCmbImportDraft`，继续使用家庭范围内的成员/分类映射和重复查询。
5. 页面根据 redirect error 显示固定的中英文提示。成功路径、现有 PDF 路径和其他三种来源不改变。

### 预估改动面

- 上传与文案：`src/app/(app)/records/import/actions.ts`、`src/app/(app)/records/import/page.tsx`、`src/lib/i18n.ts`。
- CMB 适配：`src/lib/imports/sources/cmb.ts` 或同职责的 ZIP adapter、`src/lib/imports/drafts.ts` 的创建入口；不改数据库模型。
- 依赖与版本：`package.json`、`package-lock.json`，版本更新到 `1.40.0`。
- 测试：CMB ZIP 解压/密码/边界单元测试，上传 action、页面和 i18n 集成测试，现有 CMB E2E 增加 ZIP 路径或新增脱敏 ZIP 流程测试，并运行全套应用验证。
- Wiki 目标：新建 `docs/wiki/import-cmb.md`，并在 `docs/wiki/wiki.md` 增加索引；记录稳定的入口、格式、密码和隐私边界，不记录一次性测试密码或用户账单数据。

## 验收

- 招商银行 `.pdf` 仍可上传并生成草稿；验证现有 CMB parser、action 和 E2E 回归通过。
- 使用脱敏 PDF 运行时生成的 ZipCrypto 单 PDF ZIP，并输入正确密码，可生成与直接 PDF 相同的草稿行；验证 ZIP adapter 单元测试和浏览器流程通过。
- 招商银行 ZIP 缺少密码、输入错误密码、损坏 ZIP、多个 entry、非 PDF entry 或解压超限时，页面显示固定错误且数据库中不生成 `ImportDraft`；验证 action/parser 错误测试和数据库断言通过。
- 招商银行以外的 ZIP、招商银行不支持的扩展名和超过 20MB 的文件仍在解析前被拒绝；验证上传 action 测试和静态检查通过。
- ZIP 密码、原始 ZIP/PDF 文件名、账号、余额和原始账单内容不进入 URL、事件 metadata、日志、草稿或交易；验证隐私测试、安全扫描和变更审查通过。
- ZIP 成功路径继续满足 `source = cmb`、整数分金额、`Asia/Shanghai` 日期、家庭 session 隔离、分类类型校验、同源去重和批量确认约束；验证完整 unit/integration/e2e/build 检查通过。
- `package.json`、`package-lock.json` 根版本均为 `1.40.0`；提交前安全审查包含 `Findings`、`Verification`、`Residual Risk`，并满足仓库提交、推送和生产 smoke 门禁。
