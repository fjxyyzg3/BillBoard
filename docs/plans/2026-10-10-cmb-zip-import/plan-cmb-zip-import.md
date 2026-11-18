# 招商银行 ZIP 账单导入 Implementation Plan

> **For agentic workers:** REQUIRED SKILL: Use implement to execute this plan task-by-task. Respect the handed-off git_state: inherit prepared, otherwise prepare; use git-workflow for checkpoint/finalize. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让招商银行带密码 ZIP 账单在 `/records/import` 中直接解压并复用现有 PDF 导入流程。

**Scope Source:** `docs/scope/2026-10-10-cmb-zip-import.md`

**Architecture:** 上传 action 按来源和扩展名校验文件，招商银行 ZIP 使用 `@zip.js/zip.js` 在内存中解压唯一 PDF，再交给现有 `parseCmbPdf`。草稿、成员映射、分类映射、重复检查和确认事务继续复用当前 CMB 流程；ZIP 密码只作为当前 server action 的临时参数。

**Tech Stack:** Next.js server actions, TypeScript, `@zip.js/zip.js` ZipCrypto reader, existing `pdfjs-dist` CMB parser, Vitest, Playwright, Prisma-backed integration tests.

**Verification:** Focused ZIP unit/action tests, `npm run lint`, `npm run test:unit`, `npm run test:integration`, `npm run test:e2e`, `npm run build`, `npm audit --json`, security review, version/diff checks, and production smoke after Git finalize.

---

### Task 1: 添加 ZIP 依赖、共享上传限制和版本基线

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/lib/imports/limits.ts`
- Verify: `tests/unit/import-schema.test.ts` and the package root version fields

**Acceptance:** 项目直接依赖 `@zip.js/zip.js`，根版本与 lockfile 根版本均为 `1.40.0`，共享的导入文件大小常量仍为 20 MiB，其他依赖和脚本不变。

- [x] **Step 1: 安装确定的生产依赖并同步版本**

运行 `npm install @zip.js/zip.js@^2.23.0`，然后将 `package.json` 和 `package-lock.json` 根项目版本字段更新为 `1.40.0`。不手写依赖树，不引入系统解压工具或 OCR 依赖。

- [x] **Step 2: 建立共享限制常量并确认基线**

在 `src/lib/imports/limits.ts` 导出 `MAX_IMPORT_FILE_BYTES = 20 * 1024 * 1024`，让上传 action 和 ZIP adapter 使用同一限制。运行 `node -e` 检查 `package.json`、`package-lock.json` 和 `package-lock.json.packages['']` 的版本均为 `1.40.0`，并确认 `npm ls @zip.js/zip.js --depth=0` 只解析一个直接版本。

- [x] **Step 3: 检查依赖审计基线**

运行 `npm audit --json`，记录现有及新增 dependency findings。新增 high/critical finding 必须在后续实现前处理或在最终结果中明确阻塞；不得通过隐藏审计结果完成任务。

- [x] **Step 4: Git checkpoint**

验证通过后执行 `git-workflow` 的 `checkpoint`，只处理本任务新增的依赖、限制和版本文件。根据仓库偏好不创建独立 checkpoint 提交，保留文件归入最终 feature commit。

### Task 2: 以实际 ZipCrypto 数据实现 CMB ZIP adapter

**Files:**

- Create: `src/lib/imports/sources/cmb-zip.ts`
- Create: `tests/unit/cmb-zip-import.test.ts`
- Modify: `src/lib/imports/sources/cmb.ts` only if a shared parser error/limit export is required by the adapter
- Test/Verify: `tests/fixtures/imports/cmb/statement-single-page.pdf`

**Acceptance:** 正确密码可以从唯一的 ZipCrypto PDF entry 得到与直接 PDF 相同的 `ParsedImportWorkbook`；错误密码、损坏 ZIP、entry 数量不符、非 PDF entry 和解压输出超过 20 MiB 都失败关闭且不向草稿层返回部分结果。

- [x] **Step 1: 写失败的 ZIP 行为测试**

在 `tests/unit/cmb-zip-import.test.ts` 使用现有脱敏 `statement-single-page.pdf` 和 `@zip.js/zip.js` 的 `ZipWriter` 在测试内存中生成带固定测试密码的 ZipCrypto archive，不写入新的真实样本或密码文件。测试断言：

1. 正确密码的 ZIP 解析结果与 `parseCmbPdf` 的户名、行数、金额、mapping key 和备注一致。
2. 空密码和错误密码抛出固定的 CMB ZIP 错误，错误内容不包含密码或 entry 名称。
3. 两个 entry、目录/非 PDF entry、无 entry 和损坏 ZIP 均抛出固定的 CMB ZIP 错误。
4. 创建一个声明的未压缩内容超过 `MAX_IMPORT_FILE_BYTES` 的测试 entry，读取前抛出 `Import file is too large`，不产生完整输出。

- [x] **Step 2: 运行 RED 基线**

先确保依赖安装完成，再运行 `npm run test:unit -- tests/unit/cmb-zip-import.test.ts`。预期测试因 `parseCmbZip` 尚未存在或未满足上述行为而失败；如果失败原因是 TypeScript、fixture 或依赖安装错误，先修正测试基线，不进入生产实现。

- [x] **Step 3: 实现内存、有界、可关闭的 ZIP adapter**

在 `src/lib/imports/sources/cmb-zip.ts` 实现 `parseCmbZip(buffer, password)`，并导出内部 action 使用的 `CMB_ZIP_PASSWORD_REQUIRED_MESSAGE` 与 `CMB_ZIP_UNREADABLE_MESSAGE` sentinel：

1. 非空密码由 adapter 再次校验，直接调用方不能绕过密码边界。
2. 直接使用生产依赖 `@zip.js/zip.js`，用 `Uint8ArrayReader` 和 `ZipReader` 读取 `Buffer`，关闭 web workers；reader 选项传入密码，不调用 URL、文件系统或网络。
3. 只接受一个 `.pdf` entry，拒绝目录、多个 entry、非 PDF 扩展名和空 archive；先检查可用的 `uncompressedSize`，再通过 `WritableStream` 收集 chunks，累计超过 `MAX_IMPORT_FILE_BYTES` 时立即终止。
4. 成功收集后验证 `%PDF-` 文件头，再调用现有 `parseCmbPdf`；只捕获 ZIP 读取阶段的异常并转换为固定内部错误，不能把 PDF 版式错误吞成 ZIP 错误。
5. 在 `finally` 中关闭 reader；成功、密码错误、格式错误和 writer 超限都不得保留临时文件或密码。

- [x] **Step 4: 运行 GREEN 和资源回归**

重跑同一个 focused unit 命令，确认所有 ZIP 测试通过；重复解析同一 buffer 多次，确认结果稳定、错误稳定且 reader 可关闭。随后运行 `npm run test:unit -- tests/unit/cmb-import.test.ts tests/unit/import-privacy.test.ts`，确认直接 PDF parser、备注白名单和既有隐私约束无回归。

- [x] **Step 5: Git checkpoint**

验证通过后执行 `git-workflow` 的 `checkpoint`，只处理 ZIP adapter、共享限制和对应单元测试；不单独提交，记录实际 focused test 结果。

### Task 3: 接入草稿工厂、上传 action、页面和双语文案

**Files:**

- Modify: `src/lib/imports/drafts.ts`
- Modify: `src/app/(app)/records/import/actions.ts`
- Modify: `src/app/(app)/records/import/page.tsx`
- Modify: `src/lib/i18n.ts`
- Modify: `tests/integration/import-page-and-actions.test.ts`
- Modify: `tests/unit/i18n.test.ts`

**Acceptance:** 招商银行 PDF/ZIP 分流严格按服务端扩展名执行；ZIP 缺密码、ZIP 失败和 CMB PDF 失败各自返回固定来源错误；密码不进入 draft、event metadata、URL 或日志；页面能显示 ZIP 密码输入和双语说明。

- [x] **Step 1: 写 action/page/i18n 失败测试**

在 `tests/integration/import-page-and-actions.test.ts` 增加断言：

1. CMB `.zip` 携带 `zipPassword` 时调用 `createCmbImportDraft`，传入 `buffer`、原始文件名、session 和密码；CMB `.pdf` 调用保持没有密码字段。
2. CMB ZIP 缺少密码时在 `requireAppSession` 和 `file.arrayBuffer()` 前 redirect 到 `missing-cmb-zip-password`。
3. CMB `.xlsx`、其他来源 `.zip` 和超过 20 MiB 的文件仍分别走现有 unsupported/size redirect，且不创建草稿。
4. ZIP adapter sentinel 只映射到 `unreadable-cmb-zip-file`；现有 `无法识别招商银行流水格式` 仍映射到 `unrecognized-cmb-file`。
5. 上传页面的 accept 包含 `.zip`，显示双语/中文招商银行 ZIP 说明、密码字段和四个来源选项；密码字段使用 `type=password`、`autoComplete=off`，不在 PDF 路径强制填写。

在 `tests/unit/i18n.test.ts` 断言中英文新增错误和密码说明同时存在，且 existing source messages 仍完整。

- [x] **Step 2: 运行 RED 基线**

运行 `npm run test:integration -- tests/integration/import-page-and-actions.test.ts` 和 `npm run test:unit -- tests/unit/i18n.test.ts`。预期新增断言因当前只接受 `.pdf`、页面没有密码字段和文案缺失而失败；若出现与新断言无关的环境或 mock 失败，先修正基线。

- [x] **Step 3: 扩展草稿工厂并保留现有状态机**

让 `createCmbImportDraft` 接受服务端可选 `password`，根据 `fileName` 的 `.zip` 后缀选择 `parseCmbZip`，否则继续选择 `parseCmbPdf`。保持 `storedImportFileName(CMB_SOURCE)` 为 `cmb.pdf`，不把密码写入任何 Prisma data；不改成员、分类、指纹、重复和确认逻辑。

- [x] **Step 4: 扩展上传 action 的服务端校验与错误映射**

在 `actions.ts` 使用共享 `MAX_IMPORT_FILE_BYTES`；招商银行只允许 `.pdf`/`.zip`，ZIP 缺少非空密码时在鉴权和读文件前 redirect。读取后只将密码传给 CMB draft factory；`recordAppEvent` 的 metadata 继续严格为 `{ source }`。新增固定 redirect keys `missing-cmb-zip-password` 和 `unreadable-cmb-zip-file`，错误页面只渲染 i18n 文案，不渲染底层 error message。

- [x] **Step 5: 扩展移动优先上传表单和 i18n**

更新上传说明、文件 accept、ZIP 密码 label/description、缺密码/解压失败错误和 CMB 文件类型错误的中英文文案。密码控件不使用 query string、客户端持久化或事件属性；其他来源的文件说明和分流保持现状。

- [x] **Step 6: 运行 GREEN 和相关回归**

重跑 Task 3 的 focused integration/unit 命令，再运行 `npm run lint`，确认 server action 类型、React server page 和 i18n 类型均通过。

- [x] **Step 7: Git checkpoint**

验证通过后执行 `git-workflow` 的 `checkpoint`，只处理草稿工厂、action、页面、i18n 和对应测试；不单独提交。

### Task 4: 完成隐私回归、脱敏浏览器流程和 Wiki 同步

**Files:**

- Modify: `tests/unit/import-privacy.test.ts`
- Modify: `tests/unit/sensitive-fixtures.test.ts`
- Modify: `tests/e2e/import-cmb.spec.ts`
- Verify/Update only within confirmed target: `docs/wiki/import-cmb.md`, `docs/wiki/wiki.md`

**Acceptance:** 浏览器可以上传运行时生成的 ZipCrypto CMB ZIP、填写密码并完成现有成员/分类/复核流程；跟踪文件和 PDF text layer 不包含真实账单内容；Wiki 只记录确认的长期约定。

- [x] **Step 1: 同步确认的 Wiki 目标**

先读取并使用 `wiki` skill，只更新 `docs/wiki/import-cmb.md` 和 `docs/wiki/wiki.md`。如果实现新增了已确认范围内的稳定事实，只补充上传、内存解压、密码不持久化和失败关闭约定；不记录测试密码、附件文件名、真实账单或一次性步骤。

- [x] **Step 2: 扩展敏感样本检查**

把 `src/lib/imports/sources/cmb-zip.ts`、`tests/unit/cmb-zip-import.test.ts` 和本次新增的 spec/plan 纳入 `tests/unit/sensitive-fixtures.test.ts` 的 tracked-file 扫描；在 `tests/unit/import-privacy.test.ts` 增加使用测试密码 ZIP 的解析断言，确认输出备注只含批准的招商银行摘要和对手信息、绝不包含密码。保留现有 PDF text layer 扫描，确认没有真实户名、账号尾号、订单号、商户或密码进入跟踪文件。

- [x] **Step 3: 增加脱敏 CMB ZIP E2E**

在 `tests/e2e/import-cmb.spec.ts` 使用 `setInputFiles({ name, mimeType, buffer })`，由测试进程从脱敏 PDF fixture 在内存生成 ZipCrypto ZIP，不落盘。登录后选择招商银行、上传 ZIP、填写固定测试密码，确认 URL 进入草稿页、摘要文件名为 `cmb.pdf`、成员映射和 4 条复核明细可见；既有招商银行 PDF E2E 继续覆盖成员、分类、默认跳过、确认和账本结果。

- [x] **Step 4: 运行 focused privacy/E2E 回归**

运行 `npm run test:unit -- tests/unit/cmb-zip-import.test.ts tests/unit/import-privacy.test.ts tests/unit/sensitive-fixtures.test.ts`；运行 `npm run test:integration -- tests/integration/import-page-and-actions.test.ts tests/integration/import-drafts.test.ts`；运行 `npm run test:e2e -- tests/e2e/import-cmb.spec.ts`。所有失败先区分实现、fixture、数据库或环境原因，不能削弱断言消除失败。

- [x] **Step 5: Git checkpoint**

验证通过后执行 `git-workflow` 的 `checkpoint`，只处理 Wiki、隐私扫描和 CMB E2E 相关文件；不单独提交。

### Task 5: 完整验证、安全审查和发布收尾

**Files:**

- Review: all changed files and `skills/billboard-security-review/SKILL.md`
- Verify: `package.json`, `package-lock.json`, `Containerfile`, `next.config.ts`, production start entry

**Acceptance:** 所有仓库强制验证通过，安全审查没有阻塞 finding，版本和 Git 内容一致，最终从 `master` 推送并按现有入口重启后完成登录页 smoke；任何失败都保留证据并停止依赖该门禁的动作。

- [x] **Step 1: 运行完整应用验证**

依次运行 `npm run lint`、`npm run test:unit`、`npm run test:integration`、`npm run test:e2e` 和 `npm run build`。再运行 `npm audit --json`，确认没有未处理的新增 high/critical dependency finding。必要时使用现有开发数据库和 Playwright 启动约定，不连接生产库。

- [x] **Step 2: 执行 BillBoard 安全审查**

按 `skills/billboard-security-review/SKILL.md` 先界定变更面，再检查认证 session、家庭隔离、文件类型/大小、ZIP 输出边界、密码和原始账单隐私、依赖审计、URL/event/log 暴露及无真实凭据/生产入口。输出必须包含 `Findings`、`Verification`、`Residual Risk`；任何阻塞 finding 先修复并重跑受影响验证。

- [x] **Step 3: 做最终静态和版本检查**

运行 `git diff --check`、`git status -sb`、变更文件清单、版本断言和相关 `rg` 安全扫描；确认 spec/plan checkbox 与实际结果一致，`package.json`、`package-lock.json` 根版本均为 `1.40.0`，提交说明总长度不超过 256 字符，且不包含无关文件。

- [ ] **Step 4: Git finalize、push、生产重启和 smoke**

调用 `git-workflow` 的 `finalize`，只 stage 本任务文件，生成单一 feature commit `v1.40.0 支持招商银行 ZIP 账单导入`，刷新并确认 `origin/master` 后按偏好合回 `master`、push 并核对远端 SHA。应用变更 push 成功后从 `master` 运行 `./ops/windows/start-production.ps1`，使用其健康检查或登录页 smoke；不暴露真实入口、凭据或 ZIP 密码。若 push、重启或 smoke 失败，报告实际状态，不宣称上线完成。
