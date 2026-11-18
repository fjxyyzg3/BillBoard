# 导入成员映射持久化设计

日期：2026-05-09

## 1. 背景和目标

BillBoard 现有外部账单导入会在 `src/lib/imports/member-mapping.ts` 中写死 `老公`、`老婆` 到家庭成员名的匹配。这个规则只能覆盖默认示例名，遇到真实外部账号昵称、支付宝姓名、微信昵称或随手记自定义成员名时，会回退到当前登录成员，容易把导入记录归到错误的人。

本次目标是把外部账号用户名到 BillBoard 家庭成员的映射交给用户指定，并在同一家庭、同一导入来源内保存复用。这里的“角色”按产品语义指家庭成员显示名，例如 `老公`、`老婆`，底层保存为当前家庭内的 `HouseholdMember.id`，不使用 Prisma 的 `HouseholdRole` 权限角色。

## 2. 已确认假设

- 导入入口继续固定为 `/records/import`。
- 支持来源仍为随手记 `.xlsx`、微信支付 `.xlsx`、支付宝 `.csv`。
- 成员映射按家庭和来源保存，避免不同来源同名外部账号误复用。
- 映射目标只能选择当前 session 所属家庭的现有成员。
- 外部用户名只保存规范化后的显示名或昵称；不保存账号号段、完整原始账单行、备注或上传文件内容。
- 没有外部用户名的行无法建立持久映射，仍回退到当前登录成员或支付账单的一次性归属选择。
- 有可识别外部用户名但未保存映射的行，确认导入前必须补全成员映射。
- 金额、日期、分类映射、同源去重、疑似重复、批量确认写入逻辑保持现有语义。

## 3. 方案选择

采用方案：新增持久化 `ImportMemberMapping` 表，按 `householdId + source + externalName` 唯一保存外部用户名到家庭成员的映射。

选择理由：

- 和现有 `ImportCategoryMapping` 的“第一次手动选择，后续自动复用”体验一致。
- 避免继续在代码中写死真实家庭成员名或示例名。
- 来源隔离能降低微信昵称、支付宝姓名、随手记成员名撞名导致的误归属。
- 服务端可以继续用 session 的 `householdId` 收敛所有读写，防止跨家庭映射生效。

不采用方案：

- 只保存在草稿中：实现较小，但不能复用，不符合目标。
- 不区分来源的全局用户名映射：交互更少，但不同来源用户名语义不同，误映射风险更高。
- 直接复用 `HouseholdRole`：`OWNER/MEMBER` 是权限角色，不等于产品上的 `老公/老婆` 记账视角。

## 4. 数据模型

### 4.1 新增 `ImportMemberMapping`

新增 Prisma 模型：

```prisma
model ImportMemberMapping {
  id           String          @id @default(cuid())
  householdId  String          @map("household_id")
  source       String
  externalName String          @map("external_name")
  memberId     String          @map("member_id")
  createdAt    DateTime        @default(now()) @map("created_at")
  updatedAt    DateTime        @updatedAt @map("updated_at")
  household    Household       @relation(fields: [householdId], references: [id], onDelete: Cascade)
  member       HouseholdMember @relation(fields: [memberId], references: [id], onDelete: Cascade)

  @@unique([householdId, source, externalName], name: "household_source_external_name")
  @@index([memberId])
}
```

同时在 `Household` 和 `HouseholdMember` 上补充反向 relation。写入或更新映射前，服务端必须验证目标 `memberId` 属于当前 session 的 `householdId`。

### 4.2 草稿行外部用户名字段

为 `ImportDraftRow` 增加两个仅用于成员映射的规范化字段：

- `actorExternalName`
- `creatorExternalName`

随手记：

- `成员` 写入 `actorExternalName`，用于解析 `actorMemberId`。
- `记账人` 写入 `creatorExternalName`，用于解析 `createdByMemberId`。
- `成员` 为空时，`actorExternalName` 可以回退使用 `记账人`，保持现有 `actorMemberId` 回退行为。

微信支付和支付宝：

- 文件头昵称或姓名同时写入 `actorExternalName` 和 `creatorExternalName`。
- 明细行没有独立成员，所以两者映射到同一个家庭成员。

现有 `rawMember`、`rawCreatedBy`、`rawAmount`、`rawDate` 等原始字段继续保持空值，不恢复保存完整原始账单数据。

## 5. 服务端流程

### 5.1 草稿创建

解析器继续输出 `rawMember`、`rawCreatedBy` 或 `ownerName` 给草稿创建流程使用。草稿创建时：

1. 从所有有效行中收集规范化外部用户名。
2. 批量读取当前家庭、当前来源的 `ImportMemberMapping`。
3. 对每行分别解析 `actorMemberId` 和 `createdByMemberId`。
4. 命中映射时写入映射目标成员，并将 fallback 标记为 `false`。
5. 未命中但外部用户名非空时临时写入当前登录成员，并将对应 fallback 标记为 `true`。
6. 外部用户名为空时继续回退当前登录成员，但不要求用户补映射。

`src/lib/imports/member-mapping.ts` 移除硬编码别名，只保留规范化、批量映射读取和解析函数。

### 5.2 保存成员映射

新增 server action，例如 `saveImportMemberMappings(formData)`，接收当前草稿 id 和若干 `externalName -> memberId` 选择。

服务端处理规则：

- 先 `requireAppSession()`。
- 按 `draftId + householdId` 查找 PENDING 草稿。
- 以草稿的 `source` 作为映射来源，不信任客户端传入来源。
- 验证每个 `memberId` 都属于当前家庭。
- 过滤空外部用户名。
- 使用 `upsert` 写入 `ImportMemberMapping`。
- 在同一个事务内批量更新当前草稿中匹配 `actorExternalName` 或 `creatorExternalName` 的行。
- 更新范围排除 `INVALID` 和 `SOURCE_DUPLICATE` 行。
- 更新后将对应 fallback 标记为 `false`。
- 已完成草稿拒绝修改。

### 5.3 确认导入保护

确认导入前，服务端检查所有将被导入的行：

- 如果 `actorExternalName` 非空且 `actorFallbackApplied = true`，拒绝确认。
- 如果 `creatorExternalName` 非空且 `creatorFallbackApplied = true`，拒绝确认。
- 外部用户名为空导致的一次性回退不阻止确认。

这样即使用户绕过页面直接提交确认 action，也不能把有外部用户名但未确认映射的记录导入到错误成员。

## 6. 页面和交互

### 6.1 成员映射区

导入草稿预览页新增“成员映射”区域。它显示当前草稿中出现的去重外部用户名：

```text
外部账号：微信昵称示例
BillBoard 成员：老公 / 老婆
```

每个外部用户名显示一个成员下拉框。默认值：

- 已保存映射：默认选保存的家庭成员。
- 未保存映射：默认选当前临时回退成员，但表单仍提示需要保存。

保存后当前草稿立即更新，后续同家庭、同来源、同外部用户名上传时自动复用。

### 6.2 支付账单归属成员

微信支付和支付宝原有“账单归属成员”下拉框并入成员映射区：

- 文件头有昵称或姓名时，显示为一个外部账号映射项，并可保存复用。
- 文件头没有昵称或姓名时，保留一次性的“账单归属成员”下拉框，不写入持久映射。

### 6.3 确认导入

当存在未保存的外部用户名成员映射时，确认按钮禁用，并显示需要先保存成员映射。分类映射未完成时沿用现有禁用规则。

## 7. i18n 文案

新增或调整中英文文案，放在 `src/lib/i18n.ts`：

- 成员映射标题。
- 成员映射说明。
- 外部账号标签。
- 保存成员映射按钮。
- 未完成成员映射时的确认禁用提示。
- 支付账单无外部用户名时的一次性归属说明。

中文默认面向两人家庭记账，不引入团队或营销语境。英文文案保持等价。

## 8. 错误处理

- 未登录：重定向登录页。
- 当前用户没有家庭成员身份：拒绝访问。
- 草稿不存在或不属于当前家庭：拒绝访问。
- 草稿已完成：拒绝保存成员映射。
- 目标成员不属于当前家庭：拒绝保存。
- 外部用户名为空：不写入持久映射。
- 成员映射未完成：拒绝确认导入。
- 数据库唯一约束冲突：通过 `upsert` 保持幂等。

## 9. 测试策略

### 9.1 单元测试

覆盖：

- 外部用户名规范化。
- 移除硬编码 `老公`、`老婆` 别名后，未提供映射时会标记 fallback。
- 提供映射时解析到目标成员。
- 空外部用户名不要求持久映射。

### 9.2 集成测试

覆盖：

- 创建随手记草稿时，已保存成员映射会自动复用。
- 未保存随手记成员映射会阻止确认导入。
- 保存成员映射后批量更新当前草稿行的 `actorMemberId` 和 `createdByMemberId`。
- 微信支付和支付宝文件头姓名或昵称会写入成员映射候选，并保存复用。
- 文件头缺失时仍可使用一次性账单归属成员。
- 不允许跨家庭成员 id 写入映射。
- 已完成草稿不能修改成员映射。
- 确认导入不会接受仍有 fallback 的可导入外部用户名行。

### 9.3 E2E 测试

覆盖至少一个随手记导入路径：

1. 登录。
2. 进入 `/records/import`。
3. 上传包含外部用户名的随手记测试文件。
4. 在成员映射区选择 `老公` 或 `老婆`。
5. 保存成员映射。
6. 保存分类映射。
7. 确认导入。
8. 返回记录页验证记录归属成员正确。

支付来源如已有 e2e 覆盖，可调整断言，确认文件头昵称或姓名对应的成员映射区出现并可保存。

## 10. 一期不做

- 不新增成员管理页面。
- 不支持多于现有家庭成员的泛化团队角色。
- 不支持跨来源共享成员映射。
- 不导入或展示支付账号号段、对方账号、完整原始账单行。
- 不自动创建家庭成员。
- 不改变分类映射粒度。
- 不改变金额、日期、去重和批量确认规则。

## 11. 验证要求

实现完成后按影响范围执行：

```text
npm run lint
npm run test:unit
npm run test:integration
npm run test:e2e
```

本变更涉及 Prisma 模型、导入 server actions、草稿确认保护和端到端导入流程；代码提交前必须完成完整验证。

## 12. 安全自检

- 成员映射读写必须由当前 session 的 `householdId` 收敛，不能信任客户端传入家庭信息。
- 目标成员必须从当前家庭成员列表校验。
- 持久化内容只包含来源、规范化外部用户名和家庭成员 id。
- 不保存完整账单行、账号号段、备注或上传文件内容。
- 确认导入必须在服务端阻止未完成成员映射的行。
- 同源去重继续包含软删除交易。
- 有效记录查询继续包含 `deletedAt: null`。

## 13. 设计自检

- 设计聚焦外部用户名到家庭成员的映射持久化，没有引入无关页面。
- `老公/老婆` 作为产品成员视角处理，不混同 `HouseholdRole`。
- 新表按家庭和来源隔离，符合复用目标。
- 草稿行只新增映射所需的规范化外部用户名，不恢复敏感原始字段保存。
- 分类映射、重复处理和确认写入保持既有行为。
- 测试覆盖了解析、权限、复用、保存、确认保护和页面主流程。
