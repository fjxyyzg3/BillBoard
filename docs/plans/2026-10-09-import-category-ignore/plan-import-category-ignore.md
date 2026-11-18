# 导入分类忽略实施计划

> **For agentic workers:** REQUIRED SKILL: Use implement to execute this plan task-by-task. Respect the handed-off git_state: inherit prepared, otherwise prepare; use git-workflow for checkpoint/finalize. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 分类映射可长期忽略与撤销，并且旧草稿未改动的选项不覆盖家庭规则。

**Scope Source:** `docs/scope/2026-10-09-import-category-ignore.md`，2026-10-09 已批准，包含 F1 修订。

**Architecture:** 映射记录以可空分类表示忽略，通用草稿服务按家庭校验并在草稿锁内批量更新。映射表单以页面初值产生变更集，server action 仅保存明确提交的分组；草稿行的独立忽略原因支持恢复和汇总，不回写其他草稿。

**Tech Stack:** Next.js App Router、React、Prisma/PostgreSQL 17、Vitest、Playwright。

**Verification:** `npm run lint`、`npm run test:unit`、`npm run test:integration`、`npm run test:e2e`；迁移校验、文档扫描、仓库安全审查和发布健康检查。

---

## Git 与文件所有权

- 继承已准备上下文：`feature/import-category-ignore`，工作区 `.worktrees/import-category-ignore`，基线 `v1.36.0`，初始无任务外修改。
- 仅本任务新 spec、plan、下列代码/测试和根版本字段归本任务。Wiki 不更新；批准 spec 与实现归入同一个 feature 提交，不单独提交文档 checkpoint。
- 主 agent 负责 plan、整合、安全审查、版本、完整验证和 Git/发布。数据层 agent 负责 schema/migration、通用草稿服务、共享原因代码及服务测试；UI agent 负责页面/action、映射表单与表单纯逻辑、i18n、页面/action 和表单单元测试；e2e agent 只负责新增端到端测试。禁止交叉修改其他 agent 文件。
- 所有数据库测试仅使用已核实的开发或测试库；e2e 清理不得连接生产库。生产发布从主工作区 `master` 执行，已有生产数据库不执行 seed。

## 共享接口

- `ImportDraftMappingInput = { categoryId: string | null; mappingKey: string }`；`null` 为明确忽略，不存在的分组不作修改。
- `ImportDraftSummary` 保留 `missingMappings`，增加相同分组形状的 `ignoredMappings`；后者只从当前草稿原因 `CATEGORY_MAPPING_IGNORED` 的行聚合。`missingMappings` 优先形成空初值。
- `CATEGORY_MAPPING_IGNORED` 放在 `src/lib/imports/types.ts`；实际分类校验维持现有规则。
- 新客户端映射表单通过返回结构化结果的 action 保存变更集，失败保留选择与初值，成功刷新草稿并重建基线。现有 `saveImportMappings(FormData)` 入口兼容现有调用，但不能被新表单用来全量重新发布默认忽略组。

### Task 1: 实现规则、草稿状态和可编辑映射表单

**Files:**
- Modify: `prisma/schema.prisma`、`src/lib/imports/drafts.ts`、`src/lib/imports/types.ts`
- Create: `prisma/migrations/20261009000000_import_category_ignore/migration.sql`
- Modify: `src/app/(app)/records/import/page.tsx`、`src/app/(app)/records/import/actions.ts`、`src/lib/i18n.ts`
- Create: `src/components/import-category-mapping-form.tsx`、`src/lib/imports/mapping-form.ts`
- Test: `tests/integration/import-drafts.test.ts`、`tests/integration/import-page-and-actions.test.ts`、`tests/unit/import-mapping-form.test.ts`、`tests/e2e/import-category-ignore.spec.ts`

**Acceptance:** 四来源共用忽略规则；忽略退出分类和成员阻塞且可零交易完成；撤销只恢复分类忽略行；未修改的旧分组不覆盖家庭规则。

- [x] 数据服务 RED：先扩展真实开发库服务测试，传入 `categoryId: null`，断言同组多行变为 `USER_SKIPPED/SKIP` 且确认不入账、后续草稿自动复用。运行 `npx vitest run tests/integration/import-drafts.test.ts -t "category.*ignor|ignor.*category"`，实际 1 failed / 73 skipped；现有服务拒绝 null 分类，测试因明确忽略行为缺失而失败。
- [x] 表单 RED：在既有 action 边界测试传入忽略专用值，运行 `npx vitest run tests/integration/import-page-and-actions.test.ts -t "converts the category ignore option"`，实际断言预期 `categoryId: null`、得到 `"__ignore__"`。新增纯逻辑测试覆盖净变更、改回初值和混合组空初值，随 GREEN 一起验证。
- [x] 数据 GREEN：字段及关联可空，明确 `Restrict/Cascade`，migration 仅解除非空限制；生成 Prisma client 并只对开发库 `migrate deploy`。映射加载显式区分缺失和 null；退款、同源重复及银行默认跳过先于分类忽略。
- [x] 保存与恢复 GREEN：草稿锁和 `PENDING` 校验、当前家庭及实际分组校验、分类校验、事务整体回滚；仅更新提交组，批量读取与分块更新。撤销恢复明确忽略原因的行，疑似重复默认跳过，手动跳过与特殊原因不恢复。
- [x] UI GREEN：缺失与忽略组去重；新增忽略选项与原因的中英文文案；只有忽略行初值为忽略，有待映射行初值为空。客户端保存净变更集，失败留在原表单且保留选择，成功后刷新并重建基线，无变更不写入。
- [x] 扩展服务回归：四来源规则复用、家庭/分类键隔离、已完成草稿/伪造来源/不存在组/无效分类拒绝、零交易确认、软删除防重与退款保护、保存失败回滚、与确认/行决定并发、大组不逐行更新。
- [x] 重跑服务与表单聚焦命令及相关页面/action 测试；新增逻辑 GREEN 后再整理本次引入的重复和未使用符号。服务测试 94 passed；表单单元及页面/action 测试 68 passed。
- [x] e2e：覆盖双草稿 X/Y，A 撤销 X 后 B 只保存 Y，分别保留旧页面与重新打开页面，断言家庭 X 仍为实际分类且 B 行仍跳过；同时覆盖批量忽略、恢复/撤销、英文选项、未修改保存、改回初值和失败重试。`npx playwright test tests/e2e/import-category-ignore.spec.ts --workers=1`：7 passed，28.3 秒；未与集成测试并发。
- [x] Git checkpoint：汇总 RED/GREEN 证据；按偏好不单独提交，保留在同一 feature 工作单元。

### Task 2: 完整验收与安全审查

**Files:** Task 1 全部文件，以及 `skills/billboard-security-review/SKILL.md` 对应实际变更面。

**Acceptance:** Spec 每条验收有证据，四套完整检查通过，新增迁移与家庭数据隔离无阻塞风险。

- [x] 对照 spec 逐条核验正常、失败、恢复、跨草稿和特殊状态；核对 nullable 外键动作及已有非空映射兼容。真实开发库元数据确认分类可空且外键保持 `ON DELETE RESTRICT / ON UPDATE CASCADE`。
- [x] 运行 `npm run lint`、`npm run test:unit`；之后顺序运行 `npm run test:integration`、`npm run test:e2e`，调查和修复实际失败，不削弱测试。完整端到端测试 52 passed / 1 skipped；跳过项为既有弱网络基准的默认条件，新增 7 项全部通过。
- [x] 使用 `billboard-security-review` 审查家庭权限、导入完整性、失败原子性、敏感信息、依赖及网络配置；记录 Findings、Verification、Residual Risk。
- [x] 扫描 spec/plan 的路径、命令和敏感入口/凭据，核验无无关文件或格式化。
- [x] Git checkpoint：完整验证后按最终版本与单提交策略进入收尾，不创建独立 checkpoint 提交。

### Task 3: 版本、提交、推送与正式服务验证

**Files:** `package.json`、`package-lock.json`、本次实现与文档；运行现有 `ops/windows/start-production.ps1`。

**Acceptance:** feature 版本、提交与远端 `master` 一致，生产镜像来自已验证提交，健康检查通过。

- [x] 提交前刷新 `origin/master` 并安全同步；远端仍为基线 `v1.36.0`，版本从 `1.36.0` 递增 feature 为 `1.37.0`，同步全部根版本字段。
- [ ] 再核对实际 diff、有效验证与安全证据，只 stage 本任务文件，创建目标一致的中文 feature 提交，详细描述不超过 256 字符。
- [ ] 按偏好合回 `master`，仅推送 `master` 并核对实际远端 SHA；失败不重启。
- [ ] 从干净且已推送的主工作区运行正式启动脚本，不 seed；核对镜像/构建输入与提交一致，执行 loopback 健康检查及必要登录页 smoke check，回复不暴露真实入口和凭据。
- [ ] `git-workflow finalize`：成功后清理干净任务 worktree/分支，记录提交、推送、合并、cleanup 和健康证据；失败保留工作与证据并继续可独立处理的恢复。

本计划与实现归入同一次提交，以上 Git 和发布操作在提交之后执行；其完成结果、最终 SHA 与健康证据由最终交付记录，不为回填执行状态额外创建文档提交。

## 验证记录

- 初始数据库与开发 seed：安全核验目标为 loopback `billboard_dev`；初始 Prisma client 生成和开发 seed 通过。生产库未执行 seed。
- 完整 `npm run lint`：通过；`npm run test:unit`：50 files / 304 tests passed。
- 完整集成首轮因部分既有测试不自行加载示例环境而缺少 `DATABASE_URL`；向测试进程统一加载已核实的开发环境后，`npm run test:integration`：25 files / 323 tests passed。
- 完整 `npm run test:e2e`：52 passed / 1 skipped，53 项总计，约 1.1 分钟；既有弱网络基准按默认条件跳过，新增 7 个分类忽略场景全部通过，开发库清理成功。
- 生产构建：以开发环境提供的进程 env 执行 `npm run build`，编译、Next TypeScript 检查和静态页面生成全部通过。直接使用 Node `--env-file` 启动 Next 会触发 worker 参数限制，已改为进程环境传递，无代码变更。
- 安全审查：Findings 无阻塞项；Verification 实际变更、家庭权限、三态与外键、草稿锁与事务、导入保护、F1、固定错误、敏感信息扫描和完整测试通过；Residual Risk 为发布运行验证尚待完成，届时由正式启动脚本执行迁移与健康检查。既有 ASCII `|` 分类键边界未扩展修复。
- 独立 `tsc` 检查存在仓库既有配置弃用与其他测试类型问题；本次文件未报告类型错误，实际 Next 生产构建已通过。
- 提交前最终检查：远端基线未变化；根版本字段全部为 `1.37.0`；最终 `npm run lint`、`git diff --check`、17 个本任务文件的新增内容敏感信息扫描、引用路径和批准状态核验通过，无任务外文件。
