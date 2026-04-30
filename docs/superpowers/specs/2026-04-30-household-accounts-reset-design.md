# Household Accounts Reset Design

## 背景

本次变更把默认两人家庭账号固定为 `lehary@home.com` 和 `noma@home.com`，统一密码为 `10212286`，并把中文个人视角文案从通用的“我/伴侣”调整为“老公/老婆”。同时清理当前数据库中的所有记账记录，让应用回到空账本状态。

## 范围

- 更新 seed 默认成员名：`老公`、`老婆`。
- 更新 `.env.example` 默认账号、密码、成员名。
- 更新中文视角切换文案：`家庭 / 老公 / 老婆`。
- 更新 README 默认登录信息。
- 硬删除当前数据库 `Transaction` 表里的所有记录。

## 非目标

- 不修改 Prisma schema。
- 不新增账号管理页面或配置入口。
- 不改英文 UI 文案。
- 不删除用户、家庭成员、分类或登录节流数据。

## 验证

- 先用 unit test 固化中文视角文案。
- 运行 `npm run test:unit`。
- 运行 `npm run lint`。
- 运行 `npm run prisma:seed` 验证新 seed 配置可用。
- 清理 `Transaction` 后查询记录数，确认结果为 `0`。
