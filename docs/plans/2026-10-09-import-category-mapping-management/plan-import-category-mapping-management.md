# 分类映射管理实施计划

> **For agentic workers:** REQUIRED SKILL: Use implement to execute this plan task-by-task. Respect the handed-off git_state: inherit prepared, otherwise prepare; use git-workflow for checkpoint/finalize. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 无需上传即可重新编辑家庭分类规则，只影响后续新草稿并可靠处理并发与失败。

**Scope Source:** `docs/scope/2026-10-09-import-category-mapping-management.md`，2026-10-09 已批准。

**Architecture:** 独立管理读取/保存服务只更新共享规则，草稿行继续读取快照。管理与草稿写入复用严格递增版本机制；客户端保留初值和版本，仅保存净变更，区分确定失败、冲突和通信结果未知。

**Tech Stack:** Next.js App Router、React、Prisma/PostgreSQL 17、Vitest、Playwright。

**Verification:** `npm run lint`、`npm run test:unit`、`npm run test:integration`、`npm run test:e2e`、`npm run build`、文档/版本扫描、安全审查与生产健康检查。

---

## Git 与文件所有权

- 继承 `git_state: prepared`，分支 `feature/import-category-mapping-management`，工作区 `.worktrees/import-category-mapping-management`；prepare 时主工作区干净。同期其他任务已独立提交，本任务安全 rebase 到该提交，当前基线为 `1.37.1`，不改写其他任务历史。
- 主 agent 负责 spec/plan、依赖环境、整合验证、安全、版本与 Git/发布。数据 agent 负责共享版本写入 helper、管理服务、草稿写入适配及真实数据库测试；UI agent 负责入口/管理页/action/表单/纯逻辑/i18n 和页面/action/单元测试；e2e agent 只负责新的管理端到端测试。
- Wiki 为 none；spec、plan 与实现同一 feature 提交，不创建独立文档 checkpoint。所有数据库测试只连接核实的 loopback 开发/测试库，数据库集成和 e2e 不并发。

## 共享接口

- `ManagedImportCategoryMapping`：`id`、`source`、`transactionType`、`primaryCategory`、`secondaryCategory`、`categoryId: string | null`、`categoryName: string | null`、`categoryIsActive: boolean | null`、`updatedAt: string`（ISO 初始版本）。类型从管理服务以 type-only 形式导入。
- `ManagedImportCategoryMappingChange = { id: string; categoryId: string | null; expectedUpdatedAt: string }`。
- `getImportCategoryMappingManagement(sessionUser)` 返回 `{ mappings, categories }`；categories 为 `{ id, name, type }` 的现有启用分类。
- `saveManagedImportCategoryMappings(changes, sessionUser)` 在事务内返回 `{ id, categoryId, updatedAt }[]`，成功响应使用实际提交版本；导出 `ImportCategoryMappingConflictError` 区分冲突。
- 新管理 action `saveManagedImportMappings(changes)` 返回 `{ status: "saved", mappings }` 或 `{ status: "failed" | "conflict" }`。客户端 thrown/通信异常显示结果未知提示，不自动重发；已确认成功使用返回版本前移基线，再刷新页面。
- 忽略 UI 继续使用 `IGNORE_IMPORT_MAPPING_VALUE`；空值省略、原值不提交。新 UI 纯逻辑模块不加载数据库运行依赖。

### Task 1: 实现可编辑管理流程和共同版本机制

**Files:**
- Create: `src/lib/imports/category-mapping-management.ts`、`src/lib/imports/category-mapping-rules.ts`、`src/lib/imports/managed-mapping-form.ts`
- Modify: `src/lib/imports/drafts.ts`、`src/app/(app)/records/import/page.tsx`、`src/lib/i18n.ts`
- Create: `src/app/(app)/records/import/mappings/page.tsx`、`src/app/(app)/records/import/mappings/actions.ts`、`src/components/import-category-mapping-manager.tsx`
- Test: `tests/integration/import-category-mapping-management.test.ts`、`tests/integration/import-mapping-management-page-and-actions.test.ts`、`tests/unit/managed-mapping-form.test.ts`、`tests/e2e/import-category-mapping-management.spec.ts`

**Acceptance:** 独立读取/编辑已有四来源规则，家庭隔离、净变更、严格版本和整批原子性成立；未来草稿复用、已有财务快照不变；失败/冲突/未知结果有可操作反馈。

- [x] 数据 RED：先在真实开发库搭建已保存规则及草稿 fixture；通过既有草稿服务连续写入同一规则，将持久版本设为未来值并断言下一次写入严格更大。运行 `npx vitest run tests/integration/import-category-mapping-management.test.ts -t "advances"`：1 failed；旧 writer 将未来版本 `4070908800000` 回退到当前时间，真实严格递增断言失败。
- [x] UI RED：`npx vitest run tests/integration/import-mapping-management-page-and-actions.test.ts`，既有导入页实际 SSR 对未上传/PENDING/COMPLETED 三状态断言管理入口，3 failed，均因缺少 `/records/import/mappings` 链接；不是缺模块错误。新净变更逻辑测试继续覆盖未修改/改回初值/空选择不提交，并保留真实初始版本。
- [x] 数据 GREEN：实现管理查询和批次保存，校验可信成员、家庭、来源、重复 ID、版本及有效分类；使用事务 timeout、固定规则锁序和严格递增版本。既有草稿明确保存规则时复用机制，保留草稿锁、行更新与原子性。原 RED 同命令重跑 1 passed。
- [x] UI GREEN：所有导入状态显示入口；管理列表展示来源/收支/主子分类/当前结果；停用目标可识别但不能新选；空状态与中文/英文同步。表单保留基线，只发送净变更，成功接收实际版本并刷新；确定失败重试，冲突/未知反馈提供刷新入口。
- [x] 服务回归：四来源及家庭隔离，真实分类/忽略互改，新草稿复用，所有现有草稿和交易不变；停用/错误类型/未知 ID/伪造版本拒绝；批次数据库失败及冲突使目标和版本共同回滚；管理与管理/管理与草稿并发、相同时钟/时钟回退、不同规则批次一致锁序。新文件 37 passed；原草稿 94 与新服务最初 35 合跑 129 passed，之后仅追加 2 项测试且生产代码未变。
- [x] 页面/action 与单元回归：启用分类选择、停用展示、无规则、拒绝越权/异常输入、固定错误结果、初始版本与净变更；测试真实输出并仅 mock session/服务等实际边界。新单元 6 + 新页面/action 24，连同原回归共 98 passed，UI owned eslint 通过。
- [x] e2e：未上传、待确认及已完成入口，独立真实分类/忽略编辑并重开，双页面相同规则冲突/无关组不覆盖、改回初值、确定失败重试、已提交响应丢失后刷新核实，移动端/英文及已有草稿隔离。开发库空闲且 2500 无服务时以 `CI=1` 运行 `npx playwright test tests/e2e/import-category-mapping-management.spec.ts --workers=1`：9 passed，26.5 秒；仅修复测试中的移动菜单入口和显式 reload load 同步，断言未减、无固定 sleep。
- [x] Git checkpoint：已记录 RED/GREEN 和聚焦结果；按偏好跳过独立提交。

### Task 2: 完整验证与安全审查

**Files:** Task 1 全部文件及本 spec/plan；审查 skill 为 `skills/billboard-security-review/SKILL.md`。

**Acceptance:** Spec 的 12 组验收均有实际证据，完整检查通过，未扩大数据或运行边界。

- [x] 逐条对照 spec 与实际 diff，核验共同规则 writer、停用目标、未知响应、未来/现存草稿边界以及认证/成员归属。服务 37、UI 98 聚焦及浏览器 9 项验证覆盖 Spec 的可观察要求；实际安全静态审查无阻塞项。
- [x] 运行完整 lint、unit；顺序运行完整 integration 和 e2e，失败先调查环境或实现，不削弱验收；再执行生产构建验证。最终 lint、51 files / 310 unit、27 files / 384 integration、62 e2e passed / 1 existing skipped 和 1.38.0 生产构建全部通过。
- [x] 完成实际变更安全审查，记录 Findings、Verification、Residual Risk；扫描新增内容的敏感入口/凭据、文档路径/命令、版本和任务外变更。
- [x] Git checkpoint：完整验证已通过，进入单 feature 提交收尾，复用仍有效的验证证据。

### Task 3: 版本、Git 与发布

**Files:** `package.json`、`package-lock.json`、本次实现/测试/文档；运行 `ops/windows/start-production.ps1`。

**Acceptance:** master 与远端 SHA 一致，运行镜像对应已验证已推送提交，迁移/健康检查成功且任务工作区清理。

- [ ] 刷新远端并按最终基线递增 feature 版本；当前预计 `1.38.0`，同步全部根版本字段。只 stage 本任务文件，中文提交与版本一致，详细描述不超过 256 字符。
- [ ] 安全 rebase 最新 `origin/master`，合回干净 master，只 push master 并核对实际远端 SHA；保留无关修改，失败不启动发布。
- [ ] 在已推送干净 master 运行正式脚本，不 seed，核对镜像 revision、web 健康、登录页/脚本资源及 OPS smoke check。
- [ ] finalize：核对最终主工作区和远端状态，成功后只清理本任务干净 worktree/分支，保留其他工作区与用户修改。

本计划随实现提交，提交后 Git/发布/清理的最终执行结果与 SHA 由交付记录呈现，不为回填状态额外创建文档提交。

## 验证记录

- Spec 已获用户批准，专用 reviewer 未发现实质问题（P0/P1/P2 为 0/0/0）。
- prepare 上下文已继承，任务工作区安全同步到其他任务已发布的版本；开发数据库健康且仅绑定 loopback，主工作区干净。独立工作区 `npm ci`、Prisma client 生成、仅开发库迁移检查和开发 seed 完成，无待执行迁移。
- 完整 lint 通过。完整 unit 首轮与其他检查并行时，既有敏感样本哈希扫描超过 5 秒，309 passed / 1 timeout；该测试扫描内容未被本任务修改。单文件独占验证 2 passed，随后 `npm run test:unit -- --maxWorkers=4` 保持原断言/超时且运行全部 51 files / 310 tests passed。
- 实际代码安全静态审查：Findings 无阻塞项；Verification 可信 session/家庭、服务端分类与版本输入、共同 writer 锁序、参数化 SQL、严格版本、整批回滚、草稿快照、净变更和固定结果/敏感信息检查通过；Residual Risk 为完整运行与 Git/发布核验待完成。
- 完整 integration 首轮 383 passed / 1 failed：既有 `cmb-refunds.test.ts` 临时创建全局启用分类，与 `seed-categories.test.ts` 的全局列表断言发生跨文件竞争；本任务新增服务和页面测试全部通过。统一加载已核实示例开发环境后，`npm run test:integration -- --maxWorkers=1 --no-file-parallelism` 保持全部原断言，27 files / 384 tests passed；新服务测试中的真实并发仍按原场景运行。
- 完整 `npm run test:e2e`：启动前核对 2500 空闲，使用 `CI=1` 防止复用其他工作区服务，62 passed / 1 skipped，约 1.1 分钟；跳过为既有弱网络基准默认条件，新管理 9 项全部通过，开发库清理及自有 dev server 关闭完成。
- 最终刷新远端仍为 `v1.37.1`，feature 根版本字段全部同步到 `1.38.0`；源码与验证范围保持一致，正在运行该版本生产构建。
- 1.38.0 生产构建通过：编译、Next TypeScript、13 个页面生成与 `/records/import/mappings` 动态路由完成；仅恢复本次构建自动改写的 `next-env.d.ts` 类型路径，排除生成副作用。最终 full lint 再次通过。
- 安全验收：Findings 无阻塞项；Verification 为实际代码静态审查加已通过的全部运行检查，权限/家庭、版本与锁序、目标和版本共同回滚、未来/现存数据边界、双语和敏感数据约束均有证据。Residual Risk 仅剩提交范围、推送 SHA 和生产运行核验，随收尾完成。
