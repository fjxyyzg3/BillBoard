# 核心三页质感升级实现计划

- Feature slug: `core-pages-visual-polish`
- Planning Mode: Fast
- 风险依据：纯表现层改动（CSS token + 组件 className + 客户端动效），不改 public API、schema、migration、权限、安全或数据生命周期；单 repo 单 subsystem；设计方向与全部微决策已在 brainstorming 阶段确认；acceptance 与 verification seam 明确。
- 来源：本会话 brainstorming 产出的 `PlanningHandoffPacket v1`（已获用户逐节确认）。

## 目标

在保留暖奶油底色（`#fbf2e6`）+ 珊瑚橙强调色（`#f47567`）基调的前提下，为 `/home`、`/add`、`/records` 三页建立可复用的"质感标准"：统一 design token、精修基础组件、引入克制基调 + 两个惊喜时刻的动效体系。

## Non-goals

- 不改 `/records/import`、`/reports`、`/login` 的结构与交互（仅被动接受 token 层变化）。
- 不做暗色模式；不改文案与 i18n message key；不改信息架构与插画素材。
- 不引入 UI 组件库；除 `motion` 外不新增依赖。
- 不改金额、日期、时区（`Asia/Shanghai`）、`formatFen` 等既有逻辑。

## Global Constraints

- 遵循现有 pattern：Tailwind v4 + `@layer components` 手写 CSS；RSC + 局部 `"use client"`。
- 保留全部既有 `data-testid`（如 `summary-card`、`summary-grid`、`records-filters`、`slow-saving-notice`）与 aria 角色；e2e 依赖 `.ios-panel` 类名，必须保留。
- `SuccessToast` 的文案、`role="status"`、`aria-live="polite"` 与 2.5s 展示时长不变（`weak-network-add.spec.ts` 依赖）。
- UI locale 中英切换不受影响。
- 全部动效必须经 `prefers-reduced-motion` 降级为直接显示终态。

## Requirements

- **FR-001**：在 `globals.css` 建立 token 层——色板（`--bb-ink`、`--bb-faint`、`--bb-income`、`--bb-income-soft`、`--bb-danger`，归并 `#5b3219`、`#fff7ef`、`#f6efe7`、`#ffdacf`、`#eef2e8` 等一次性色值与三页内的 `stone-*`/`emerald-*`）、elevation 三级（`--bb-shadow-sm/md/lg`）、动效 token（`--bb-dur-fast: 120ms`、`--bb-dur: 250ms`、`--bb-ease-out: cubic-bezier(0.22, 1, 0.36, 1)`）、大标题负字距。
- **FR-002**：`.ios-panel` 去除 `backdrop-filter: blur(18px)`；blur 仅保留在 `BottomNav`、toast、抽屉等真浮层。
- **FR-003**：金额颜色语义统一——支出 = `--bb-ink`，收入 = `--bb-income`，红（`--bb-danger`）仅用于警告/删除/负净值；`SummaryCard` 支出红改为 ink。
- **FR-004**：基础组件精修——主按钮与可点卡片/列表行按压态（`scale 0.97–0.98`, 100ms）；`ios-field`/`ios-select`/`ios-datetime` 描边统一 token 并补 hover 态；类型切换器底色改暖色 token；note 输入框正名为通用带图标 field；records 空状态加图标 + 引导样式。
- **FR-005**：`SuccessToast` 重设计——打钩图标、顶部弹簧滑入（y: -16→0）、打钩 SVG path 描绘动画 ~300ms、2.5s 后淡出上移退出。
- **FR-006**：滑动 pill——`/add` 类型切换器与 `BottomNav` 激活态用 `motion` `layoutId` 弹簧滑动（stiffness 400, damping 30）。
- **FR-007**：入场编排——三页首屏区块 fade-up（y: 8→0, 250ms, ease-out, stagger 50ms）；records 行仅前 8 行 stagger；首页 `SummaryCard` 金额首次加载 count-up 400ms（切月/切视角不重复）。
- **FR-008**：全部动效支持 `prefers-reduced-motion` 降级。
- **FR-009**：`(app)/loading.tsx` 骨架屏 `stone-200` 替换为暖色 token。

## Tasks

### T1 — 引入 `motion` 依赖

- Files: `package.json` (Modify), `package-lock.json` (Modify)
- Consumes: None
- Produces: 可 `import ... from "motion/react"` 的依赖（motion v12+，React 19 兼容）
- Covers: FR-005, FR-006, FR-007 的前置
- Acceptance Criteria: `npm ls motion` 显示已安装；`npm run build` 通过。
- Verification: `npm install motion && npm run build`

### T2 — `globals.css` token 层与基础 class 重构

- Files: `src/app/globals.css` (Modify)
- Consumes: None
- Produces: CSS 自定义属性 `--bb-ink`、`--bb-faint`、`--bb-income`、`--bb-income-soft`、`--bb-danger`、`--bb-shadow-sm`、`--bb-shadow-md`、`--bb-shadow-lg`、`--bb-dur-fast`、`--bb-dur`、`--bb-ease-out`；更新后的 `.ios-panel`（无 blur、`--bb-shadow-md`）、`.ios-field`/`.ios-select`/`.ios-datetime`（token 描边 + hover 态）、`.bb-section-title`（`letter-spacing: -0.02em`）；新增通用带图标输入 class（供 note 字段使用）与暖色骨架色 token。
- Covers: FR-001, FR-002
- Acceptance Criteria: 三页及 import/reports/login 渲染无样式回退（无未定义 var）；`.ios-panel` 类名保留且无 `backdrop-filter`；`BottomNav`/toast/抽屉仍保留 blur。
- Verification: `npm run lint && npm run build`；manual seam：`npm run dev` 后六页肉眼回归截图。

### T3 — 动效原语 client 组件

- Files: `src/components/motion-primitives.tsx` (Create)
- Consumes: T1 的 `motion/react` 依赖
- Produces: 导出 `Reveal`（fade-up 单元素）、`RevealGroup`（stagger 容器，支持 `cap` 限制 stagger 子项数量）、`CountUp`（数字 400ms count-up，接受 `fen` 或整数、`format` 回调）；三者均内置 `useReducedMotion` 降级（直接渲染终态）。组件为薄 client wrapper，children 可接收 RSC 传入内容。
- Covers: FR-007（原语部分）, FR-008（原语部分）
- Acceptance Criteria: 导出签名稳定供 T4–T6 消费；reduced-motion 时无动画直接显示；TypeScript 编译通过。
- Verification: `npm run lint && npm run build`

### T4 — `/add` 表单精修与保存成功惊喜动效

- Files: `src/components/transaction-form.tsx` (Modify)
- Consumes: T2 的 token 与通用带图标输入 class；T3 的 `Reveal`/reduced-motion 能力
- Produces: 类型切换器暖色底 + `layoutId` 滑动 pill；主按钮 `active:scale-[0.97]`；note 字段改用通用带图标输入 class（`name="note"` 等表单行为不变）；重设计 `SuccessToast`（打钩图标 + 弹簧滑入 + path 描绘 + 淡出退出，文案/role/aria-live/2.5s 时长不变）；页面区块 fade-up 入场。
- Covers: FR-004（表单部分）, FR-005, FR-006（类型切换器部分）, FR-007（`/add` 部分）
- Acceptance Criteria: `create-expense.spec.ts`、`create-income.spec.ts`、`weak-network-add.spec.ts` 全绿；弱网流程（draft/重试/unknown 态）行为不变；toast 动画结束后仍自动消失。
- Verification: `npm run test:e2e -- create-expense create-income weak-network-add`；manual seam：DevTools 模拟 `prefers-reduced-motion` 后 toast 直接出现/消失。

### T5 — 共享组件与 `/records` 精修

- Files: `src/components/summary-card.tsx` (Modify), `src/components/bottom-nav.tsx` (Modify), `src/components/category-picker.tsx` (Modify), `src/components/perspective-toggle.tsx` (Modify), `src/app/(app)/records/page.tsx` (Modify), `src/app/(app)/loading.tsx` (Modify)
- Consumes: T2 的 token；T3 的 `Reveal`
- Produces: `SummaryCard` 支出 tone 改 ink + `active:scale-[0.98]`（`data-testid="summary-card"` 保留）；`BottomNav` 激活 pill `layoutId` 滑动（保留 blur 与 pending pulse）；`CategoryPicker` chip 按压态；`PerspectiveToggle` 的 `stone-*` 归并 token；records 行按压/hover 用 token、金额语义按 FR-003、空状态图标 + 引导样式、分页按钮 token 化；骨架屏暖色 token。
- Covers: FR-003, FR-004（共享组件与 records 部分）, FR-006（BottomNav 部分）, FR-009
- Acceptance Criteria: `ui-layout.spec.ts`、`filter-navigation.spec.ts`、`home-drilldown.spec.ts`、`app-smoke.spec.ts` 全绿；`.ios-panel` 与全部 `data-testid` 保留。
- Verification: `npm run test:e2e -- ui-layout filter-navigation home-drilldown app-smoke`；manual seam：三页截图对比改动前后。

### T6 — 页面入场编排与首页金额 count-up

- Files: `src/app/(app)/home/page.tsx` (Modify), `src/app/(app)/add/page.tsx` (Modify), `src/app/(app)/records/page.tsx` (Modify), `src/components/summary-card.tsx` (Modify)
- Consumes: T3 的 `Reveal`/`RevealGroup`/`CountUp`；T5 的 `SummaryCard`
- Produces: 三页首屏区块以 `RevealGroup` fade-up stagger 50ms；records 列表仅前 8 行 stagger（RSC 行作为 children 传入 client wrapper，不改 `prefetch={false}` 与 URL 状态逻辑）；`SummaryCard` 新增可选 count-up 能力（稳定签名：可选 prop 传入数值 fen/整数与格式类型，reduced-motion 或无该 prop 时渲染既有字符串），首页四卡首次加载 count-up 400ms，切月/切视角不重复（以组件 mount 为首次）。
- Covers: FR-007（home/records 部分）, FR-008（应用层）
- Acceptance Criteria: `home-drilldown.spec.ts`、`app-smoke.spec.ts` 全绿；首页 SSR HTML 中金额为最终值（count-up 不影响服务端渲染结果与 e2e 文本断言）。
- Verification: `npm run test:e2e -- home-drilldown app-smoke`；manual seam：Chrome 低端机节流档下三页入场与 records 滚动无掉帧。

### T7 — 全量验证

- Files: 无新增（仅修复前序任务暴露的问题）
- Consumes: T1–T6 全部产出
- Produces: 最终 observable outcome：lint + unit + integration + e2e 全绿；六页（三核心页 + import/reports/login 回归）截图确认；reduced-motion 与低端机节流两处 manual seam 确认。
- Covers: FR-001 ~ FR-009（验收汇总）
- Acceptance Criteria: 所有命令退出码 0；manual seam 记录结果。
- Verification: `npm run lint && npm run test:unit && npm run test:integration && npm run test:e2e`；manual seam：六页截图、DevTools `prefers-reduced-motion` 模拟、CPU 4x 节流滚动检查。

## Coverage Self-Check

| FR | Tasks | Verification |
| --- | --- | --- |
| FR-001 | T2 | lint + build + 六页截图 |
| FR-002 | T2 | build + 六页截图（浮层 blur 保留确认） |
| FR-003 | T5 | e2e（ui-layout 等）+ 截图 |
| FR-004 | T4, T5 | e2e 分批 + 截图 |
| FR-005 | T4 | e2e（weak-network-add 等）+ reduced-motion seam |
| FR-006 | T4, T5 | e2e（app-smoke/ui-layout）+ 截图 |
| FR-007 | T3, T4, T6 | e2e（home-drilldown/app-smoke）+ 节流 seam |
| FR-008 | T3, T4, T6 | reduced-motion manual seam |
| FR-009 | T5 | 截图 + app-smoke |

## Assumptions

- `motion`（v12+）与 React 19 / Next 16 兼容；用户已在 brainstorming 阶段批准新增该依赖。
- e2e 不断言具体颜色类名（已 grep 确认仅依赖 `.ios-panel`）；若个别断言依赖被替换的 `stone-*` 类名，实现阶段同步更新断言属正常修复。
- `SummaryCard` count-up 通过新增可选 prop 实现，不破坏既有调用方（reports 页若复用该组件则不传该 prop，行为不变）。

## Residual Risks

- `.ios-panel` 去 blur 与 `stone-*` 归并会轻微改变 import/reports/login 外观（预期内变好），需 T2/T7 截图回归确认。
- records 行包 client `Reveal` 会增加少量 client JS；需保持 wrapper 薄、仅在 mount 时动画一次，避免影响长列表滚动。
- `layoutId` 滑动在 `BottomNav` 快速连续点 tab 时可能出现 pill 回弹，实现阶段以 damping 30 为起点微调。
- Playwright 动画时序敏感：toast/入场动画可能使 e2e 断言过早执行，必要时在 e2e 中用既有 waitFor 策略而非新增硬等待。

## Planning Quality Status: Pass
