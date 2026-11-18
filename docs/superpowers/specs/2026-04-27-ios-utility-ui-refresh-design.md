# BillBoard iOS Utility UI Refresh Design

日期：2026-04-27

## 1. 背景与目标

本设计定义一次面向现有网页 UI 的视觉与排版迭代。目标不是新增记账能力，而是让 `BillBoard` 更接近苹果 `iOS Utility` 风格：清爽、移动优先、信息层级明确、表单录入阻力低，并修复当前页面中明显的排版和溢出问题。

本次改动必须继续服务两个核心场景：

- 快速记录家庭收入和支出。
- 按家庭成员视角和时间范围查看、复盘记录。

已确认范围：

- 覆盖 `Login`、`Home`、`Add`、`Records`、编辑抽屉、底部导航、桌面导航。
- 保持现有功能、数据流、查询参数、server actions、权限校验、日期范围逻辑不变。
- 新增轻量图标依赖 `lucide-react`，用于导航和必要动作图标。

## 2. 假设

- “苹果 UI 风格”指 `iOS Utility` 式的系统工具清晰度，而不是玻璃拟态、营销化落地页或装饰性视觉。
- 本次是视觉与布局统一，不重做信息架构，也不加入预算、账户、分类管理、附件等新功能。
- 英文 UI 文案继续保留。
- 现有移动优先形态继续保留，桌面端通过更好的宽度、导航和卡片排布增强可读性。
- 金额可能比示例更长，因此所有金额容器必须显式防止文本溢出。

## 3. 已比较方案

### 3.1 Surface Polish Only

只在现有组件中替换 Tailwind class，改灰色背景、白色卡片、蓝色按钮、图标导航和局部间距。

优点：

- 改动最小。
- 回归风险最低。
- 实现最快。

缺点：

- 页面之间的不一致容易保留。
- 更像换皮，不能系统性解决排版问题。

### 3.2 Shared iOS Utility System

建立一套很小的本地视觉规则：系统灰背景、白色 grouped panels、分段控件、输入框、列表行、Tab 导航、主按钮、金额排版规则。组件仍然保持现有职责和数据流。

优点：

- 能统一所有目标页面。
- 能通过共享间距、圆角、宽度和金额规则修复排版问题。
- 行为保持稳定，风险可控。

缺点：

- 触碰文件数适中。
- 需要移动端和桌面端视觉验证。

结论：选择此方案。

### 3.3 Dashboard-Led Redesign

更激进地重做 `Home` 和 `Records` 的信息结构，例如新图表布局、桌面 dashboard、更多 summary-first 设计。

优点：

- 视觉提升空间最大。
- 可以处理更深层页面组合问题。

缺点：

- 回归面最大。
- 更容易偏离“简单家庭记账工具”的目标。
- 需要更多设计评审。

## 4. 视觉系统

### 4.1 基础风格

- App 背景使用接近 `#f5f5f7` 的 iOS 系统灰。
- 页面内容使用白色 grouped panels，配合低对比度边框和轻量阴影。
- 字体使用系统字体栈，例如 `-apple-system`、`BlinkMacSystemFont`、`system-ui`，不引入自定义字体。
- 字距保持默认，不使用负字距。
- 圆角采用 iOS 风格，但避免所有元素都变成过大的泡泡形状。

### 4.2 色彩

- 主操作、激活导航、焦点状态使用 iOS 蓝。
- 收入金额保留绿色。
- 删除、错误、危险操作保留红色。
- 次级文字使用系统灰阶，减少强对比灰黑堆叠。

### 4.3 金额与容器规则

金额是核心信息，必须可读且不能溢出。

实现规则：

- Summary 卡片使用 `minmax(0, 1fr)` 栅格。
- 移动端 summary 优先两列，桌面端再展开到四列。
- 金额使用 tabular numerals。
- 金额字体使用响应式尺寸约束，不随 viewport 无限制放大。
- 金额容器设置 `min-width: 0` 和必要的 wrapping/overflow 保护。
- 按钮、Tab、卡片标题不能因文本长度挤压相邻内容。

## 5. 页面结构设计

### 5.1 App Shell 与导航

移动端：

- 保留底部三项导航：`Home`、`Add`、`Records`。
- 为每项加入图标和文字。
- 激活项使用 iOS 蓝，并保持足够触控区域。
- 版本号保留，但降低视觉权重，避免干扰主要导航。

桌面端：

- 保留左侧导航。
- 改成更轻的 iOS sidebar：品牌、简短说明、三项导航、版本号。
- 当前页使用蓝色或浅蓝底强调，而不是厚重黑底。

### 5.2 Login

- 登录页使用居中 iOS card。
- 背景与主 app 一致，避免白底裸露。
- 输入框采用 grouped form 视觉。
- 主按钮使用 iOS 蓝。
- 错误信息保留清晰红色。

### 5.3 Home

`Home` 继续回答：本视角下收入、支出、净额、交易数量、趋势、分类和近期记录。

结构：

- 页面头部显示当前范围和视角的上下文。
- `Add transaction` 作为主操作按钮。
- Summary 区域优先展示核心金额，移动端两列，桌面端四列。
- `PerspectiveToggle` 和 `TimeRangeSelector` 统一成 iOS 控件风格。
- `TrendChart`、`CategoryBreakdown`、`RecentTransactions` 使用同一 grouped panel 风格。
- 保留所有 drill-down 链接。

### 5.4 Add

`Add` 是最重要页面，必须保留快速录入。

结构：

- 类型选择使用 iOS segmented control。
- 金额输入更突出，继续 `autoFocus`。
- 分类按钮保持大触控目标，但视觉更像 iOS choice chips。
- `Who`、`When`、`Note` 组成 grouped form 区域。
- 保存按钮固定为清晰主操作，不新增复杂配置。
- 保存成功区保留 `Add another` 和 `Return home`，改为更统一的成功提示样式。

### 5.5 Records

`Records` 是历史、筛选和修正页面。

结构：

- 顶部保留范围、视角、类型、分类筛选。
- 记录列表改为 grouped list。
- 每条记录左侧显示分类和元信息，右侧显示金额。
- 金额右对齐，收入绿色，支出默认深色或中性色。
- `Actor` 和 `Created by` 保留，但降低层级，避免抢金额和分类。
- 空状态保留简短提示，不新增引导页面。

### 5.6 编辑抽屉

- 保留从记录行打开编辑抽屉的行为。
- 视觉改为 iOS sheet/panel：浅色遮罩、白色面板、清晰标题、右上关闭按钮。
- 表单控件与 `Add` 一致。
- `Save changes` 是主操作。
- `Delete record` 保持危险操作样式，并继续使用确认。

## 6. 可访问性与交互约束

- 保留所有表单 label。
- 图标不替代必要文字，除非控件有明确 `aria-label`。
- 控件触控区域适合移动端。
- 焦点状态清楚可见。
- 不引入纯装饰的大背景、营销 hero、渐变球或复杂动效。
- 不改变 URL 参数语义，避免破坏现有筛选和 drill-down。

## 7. 实现边界

计划修改范围：

- `src/app/globals.css`
- `src/app/layout.tsx`
- `src/app/(auth)/login/page.tsx`
- `src/components/app-shell.tsx`
- `src/components/bottom-nav.tsx`
- `src/components/desktop-nav.tsx`
- `src/components/perspective-toggle.tsx`
- `src/components/time-range-selector.tsx`
- `src/components/records-filter-bar.tsx`
- `src/components/category-picker.tsx`
- `src/components/transaction-form.tsx`
- `src/components/transaction-editor-drawer.tsx`
- `src/components/summary-card.tsx`
- `src/components/trend-chart.tsx`
- `src/components/category-breakdown.tsx`
- `src/components/recent-transactions.tsx`
- `src/app/(app)/home/page.tsx`
- `src/app/(app)/add/page.tsx`
- `src/app/(app)/records/page.tsx`
- `package.json`
- `package-lock.json`

计划不修改：

- Prisma schema 和 migrations。
- 交易创建、更新、删除 server actions。
- 认证、权限、session 逻辑。
- 报表聚合、记录查询、时间范围计算逻辑。
- PWA manifest、Docker、部署脚本。

## 8. 验证计划

最小充分验证：

1. 运行 `npm run lint`。
2. 运行相关 unit/integration 测试，优先覆盖导航版本标记、金额格式、报表聚合、记录查询。
3. 如果 PostgreSQL 与 seed 数据可用，运行 `npm run test:e2e`，因为本次触及登录、导航、表单和记录编辑入口。
4. 启动本地服务后使用浏览器检查移动端和桌面端截图，确认：
   - 金额不超框。
   - Tab 文本和图标不重叠。
   - Summary 卡片在移动端和桌面端布局稳定。
   - Add 表单可快速录入。
   - Records 行内容不互相挤压。
   - 编辑抽屉在桌面和移动端都可用。

如果完整 e2e 因数据库或 seed 环境不可用而无法运行，必须在验证记录中明确说明原因，并完成可运行的最强验证组合。

## 9. 风险与应对

- 风险：金额长度导致卡片溢出。
  应对：金额容器和栅格显式使用响应式约束，并做截图验证。
- 风险：新增图标导致导航可访问性下降。
  应对：图标和文字共同出现，必要时加 `aria-hidden` 或 `aria-label`。
- 风险：视觉改动误触业务逻辑。
  应对：实现只改展示组件和样式，避免动 server actions、查询和权限逻辑。
- 风险：页面过度装饰，影响记账效率。
  应对：使用 iOS Utility 风格，而不是玻璃拟态或营销化视觉。

## 10. 设计结论

本次 UI 迭代采用 `Shared iOS Utility System`。它用小而一致的视觉规则统一 `BillBoard` 的主要页面，修复排版问题，并保持快速记账、家庭视角查看、时间范围复盘这三个核心目标不变。实现时应优先保证移动端可用性、金额可读性、导航清晰度和表单录入效率。
