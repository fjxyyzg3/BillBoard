# 手动搜索过滤实现计划

> **执行约束：** 使用 implement 技能按任务推进；沿用已准备的 git-workflow 上下文，并用复选框记录状态。

**目标：** 在 `/records` 中增加手动提交的服务端关键词筛选，支持备注、启用分类展示名和记账成员名称。

**范围来源：** `docs/scope/2026-09-02-manual-record-search.md`

**架构：** 记录页继续作为 URL 驱动的服务端渲染筛选拥有者。扩展 `listRecords`，让列表分页和详情校验共享家庭安全的关键词、启用分类 ID 和选中记录约束。筛选栏保存输入草稿，并在 URL 导航后从服务端解密的值同步；原始关键词通过同源 POST 传递，URL 只保存绑定当前家庭的加密不透明令牌。

**验证：** 先执行相关 Vitest 和 Playwright 定向测试，再执行 `npm run lint`、`npm run test:unit`、`npm run test:integration`、`npm run test:e2e`；提交前执行安全审查。

---

### 任务 1：增加服务端关键词查询

**文件：**
- 修改：`tests/integration/records-query.test.ts`
- 修改：`src/lib/records/list-records.ts`
- 验证：`npm exec vitest -- run tests/integration/records-query.test.ts`

**验收：** `listRecords` 在完整服务端结果集上按备注、记账成员名称或传入的启用分类 ID 执行 OR 匹配，同时保持家庭、视角、范围、类型、分类、软删除、排序和分页约束。

- [x] **步骤 1：先写失败的集成测试**
- [x] **步骤 2：运行定向测试确认 RED**
  - 新增搜索测试失败，原有测试通过，失败原因是 `listRecords` 尚未应用搜索条件。
- [x] **步骤 3：实现最小查询逻辑**
  - 新增可选 `search`、`searchCategoryIds`、`recordId`；关键词 `trim()`，备注和记账成员使用不区分大小写的 `contains`，分类 ID 加入同一 OR 条件。
- [x] **步骤 4：运行定向测试确认 GREEN**
  - `records-query.test.ts`：10 个测试通过。
- [x] **步骤 5：运行定向 lint 并检查 diff**
  - `npm run lint -- --quiet` 通过。
- [x] **步骤 6：Git checkpoint**
  - 按仓库偏好不创建阶段提交；完整功能验证前保留本任务修改，原因已记录在实现上下文中。

### 任务 2：接入记录页参数和详情校验

**文件：**
- 修改：`tests/integration/records-page-and-actions.test.ts`
- 修改：`src/app/(app)/records/page.tsx`
- 新增：`src/lib/records/search-token.ts`
- 验证：`npm exec vitest -- run tests/integration/records-page-and-actions.test.ts`

**验收：** 页面把去除首尾空格后的关键词和当前 locale 的启用分类候选传入查询；分页、行链接和详情链接保留搜索；选中详情使用同一完整谓词校验。

- [x] **步骤 1：先写页面测试**
  - 覆盖中文/英文分类候选、分页/行链接、匹配详情和不匹配详情。
- [x] **步骤 2：运行定向测试确认 RED**
  - 页面在接入前未传 `search` 和 `searchCategoryIds`，新增断言失败。
- [x] **步骤 3：实现页面查询接入**
  - 统一构造列表和详情查询输入；详情使用 `recordId`，不再绕过列表安全谓词直接读取交易。
- [x] **步骤 4：运行定向测试确认 GREEN**
  - `records-page-and-actions.test.ts`：17 个测试通过。
- [x] **步骤 5：运行查询和页面回归**
  - 查询、页面及相关组件定向回归：4 个文件、39 个测试通过。
- [x] **步骤 6：Git checkpoint**
  - 按仓库偏好不创建阶段提交；保留到最终功能提交。

### 任务 3：增加 URL 驱动搜索栏和中英文文案

**文件：**
- 修改：`tests/unit/records-filter-bar.test.tsx`
- 修改：`tests/unit/i18n.test.ts`
- 修改：`src/components/records-filter-bar.tsx`
- 修改：`src/lib/i18n.ts`
- 新增：`src/app/(app)/records/search/route.ts`
- 验证：`npm exec vitest -- run tests/unit/records-filter-bar.test.tsx tests/unit/i18n.test.ts`

**验收：** 输入框只在回车或搜索按钮提交；清空只删除 `search`；URL 是输入框的持续来源但不保存原始关键词；中文和英文均有完整标签、占位、提交和清空文案。

- [x] **步骤 1：先写失败的单元测试**
- [x] **步骤 2：运行定向测试确认 RED**
  - 新增令牌、同源 POST、URL 和文案断言在实现前失败。
- [x] **步骤 3：实现最小 UI 和 URL 逻辑**
  - `RecordsFilterBar` 通过同源 POST 提交原始关键词；服务端生成加密不透明令牌，筛选栏保留其他参数、清除页码，并在 URL 改变时从服务端解密值同步输入草稿。
- [x] **步骤 4：运行定向测试确认 GREEN**
  - `records-filter-bar.test.tsx` 和 `i18n.test.ts`：12 个测试通过。
- [x] **步骤 5：运行组件和页面回归**
  - 相关组件、页面和查询回归通过。
- [x] **步骤 6：Git checkpoint**
  - 按仓库偏好不创建阶段提交；保留到最终功能提交。

### 任务 4：端到端验收、版本和发布前检查

**文件：**
- 新增：`tests/e2e/records-search.spec.ts`
- 修改：`package.json`
- 修改：`package-lock.json`
- 验证：`npm exec playwright -- test tests/e2e/records-search.spec.ts`

**验收：** 登录用户可以创建已知记录，在中文/英文界面提交、清空、恢复搜索并查看筛选结果；版本为 `1.31.0`。

- [x] **步骤 1：编写端到端测试**
  - 覆盖提交前 URL 不变、原始关键词不进入 URL、无结果保留关键词、清空、URL 前进后退同步及英文分类名搜索。
- [x] **步骤 2：运行定向 e2e**
  - 首次启动受 worktree 依赖布局影响；安装锁定依赖并生成 Prisma Client 后，定向流程通过。
- [x] **步骤 3：再次运行定向 e2e 确认 GREEN**
  - `records-search.spec.ts`：1 个测试通过。
- [x] **步骤 4：更新 feature 版本**
  - `package.json` 和 `package-lock.json` 根项目字段更新为 `1.31.0`。
- [x] **步骤 5：运行完整必需验证**
  - `npm run lint`、`npm run test:unit`、`npm run test:integration`、`npm run test:e2e` 和 `npm run build` 均通过。
- [x] **步骤 6：执行 BillBoard 安全审查**
  - Findings：未发现 P0/P1 阻塞项；家庭/成员/软删除查询边界、AES-GCM 家庭绑定、同源回跳校验均符合要求。
  - Verification：定向令牌/route 测试、完整 lint/unit/integration/e2e/build、`git diff --check` 和敏感暴露扫描均通过；原始关键词未写入 URL、客户端持久化存储或应用日志，变更文件未发现真实凭据或生产入口标识。
  - Residual Risk：URL 仍会保留不透明 token，具备同一 AUTH_SECRET 与家庭会话下的搜索条件回放能力；token 不含明文，轮换 AUTH_SECRET 可使其失效。
- [ ] **步骤 7：最终 diff 和 Git workflow**
  - 待全量验证、最终 diff、版本/分支/远端条件复核完成后执行 finalize。
