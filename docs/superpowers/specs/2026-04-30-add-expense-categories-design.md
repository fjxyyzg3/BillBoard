# 新增育儿和孝心支出分类设计

日期：2026-04-30

## 背景与目标

`BillBoard` 当前通过 seed 数据提供固定的收入和支出分类，页面展示时再按当前语言映射内置分类名。新增“育儿”和“孝心”两个支出分类，可以让两人家庭更快记录孩子相关支出和父母关怀支出，继续服务快速记账和按时间范围复盘的核心体验。

目标：

- 在默认支出分类中新增“育儿”和“孝心”。
- 保持英文 UI 的分类名自然可读。
- 保持中文 UI 看到用户指定的“育儿”和“孝心”。
- 不新增分类管理页面，不修改交易模型，不改变查询逻辑。

## 假设

- 这两个分类都属于支出，不属于收入。
- 数据库继续保存英文内置分类名。
- 英文 UI 显示 `Childcare` 和 `Parent Care`。
- 中文 UI 显示“育儿”和“孝心”。
- 已有数据库可通过重新运行 `npm run prisma:seed` 获得新增分类。

## 已比较方案

### 1. 只更新 seed 和中文显示映射

在 `prisma/seed.ts` 的支出分类数组中新增 `Childcare` 和 `Parent Care`，并在 `src/lib/i18n.ts` 的中文分类映射中加入对应显示名。

优点：

- 匹配现有内置分类机制。
- 改动最小，风险最低。
- 不影响已有交易、报表、记录筛选和编辑流程。

缺点：

- 已部署数据库需要重新运行 seed 才会出现新分类。

结论：选择此方案。

### 2. 增加数据库迁移补充分类

通过迁移或一次性脚本直接向数据库插入新增分类。

优点：

- 已部署数据库应用迁移后即可获得新增分类。

缺点：

- 当前项目默认分类来源是 seed，引入迁移写静态数据会让分类维护方式分散。
- 为两个静态分类增加机制复杂度，不符合简单优先。

### 3. 增加分类管理 UI

让用户自己维护分类。

优点：

- 后续新增分类不需要改代码。

缺点：

- 明显超出本次需求。
- 会新增页面、权限、校验和更多测试面，增加记账应用复杂度。

## 设计

默认支出分类新增两个英文底层名称：

- `Childcare`
- `Parent Care`

中文分类显示映射新增：

- `Childcare` -> `育儿`
- `Parent Care` -> `孝心`

分类顺序放在 `Medical` 后、`Entertainment` 前。这样能保留餐饮、买菜、交通等高频入口靠前，同时让家庭照护类支出在娱乐、社交、旅行之前出现。

数据流不变：

1. `prisma/seed.ts` upsert 分类，按 `type_name` 保持幂等。
2. 新增记录页和记录筛选页继续查询 `isActive: true` 分类。
3. 表单提交和记录筛选继续使用 `categoryId`。
4. 页面展示时继续调用 `getCategoryDisplayName` 做内置分类中文映射。

## 代码影响

- `prisma/seed.ts`：在 `expenseCategories` 中加入 `Childcare` 和 `Parent Care`。
- `src/lib/i18n.ts`：为 `zh-CN` 新增两个分类显示名。
- `tests/unit/i18n.test.ts`：覆盖新增分类显示映射，确保中文显示正确、英文继续回退到底层英文名。

不修改：

- Prisma schema。
- transaction create/update/delete 逻辑。
- report aggregation 和 records query。
- 页面结构和导航。

## 验证目标

1. `getCategoryDisplayName("Childcare", "zh-CN")` 返回“育儿”。
2. `getCategoryDisplayName("Parent Care", "zh-CN")` 返回“孝心”。
3. `getCategoryDisplayName("Childcare", "en-US")` 仍返回 `Childcare`。
4. `npm run prisma:seed` 后，支出分类中包含 `Childcare` 和 `Parent Care`。
5. 最小实现验证先运行相关 unit test 和 lint；提交前按仓库规则运行完整验证。
