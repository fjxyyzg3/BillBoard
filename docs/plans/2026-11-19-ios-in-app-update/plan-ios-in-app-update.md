# iPhone 客户端内更新实施计划

> **For agentic workers:** REQUIRED SKILL: Use implement to execute this plan task-by-task. Respect the handed-off git_state: inherit prepared, otherwise prepare; use git-workflow for checkpoint/finalize. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让已登录的 iPhone 客户端用户查看本机构建并发起系统覆盖安装。
**Scope Source:** [已批准设计](../../scope/2026-11-19-ios-in-app-update.md)
**Architecture:** 账本菜单复用现有底部面板。服务端更新路由复用家庭领取和短时票据，原生接口提供已安装版本并校验交接。
**Tech Stack:** Next.js、Swift、WebKit、Playwright、GitHub Actions
**Verification:** 更新 API 集成、更新面板测试、Xcode 模拟器、全量验证、两个递增构建真机验收。

---

- [ ] 检查与领取。复用 IPA 读取和票据签发，核对当前会话、家庭和目标构建。以集成测试覆盖匿名、撤销、版本竞争和旧入口。
- [ ] 菜单与原生交接。连接更新面板、安装和 Safari 备用动作。以模拟器验证严格 URL 和版本边界，以浏览器测试验证两个动作拦截待处理工作及异步竞态。
- [ ] 同步 Wiki 与运行手册。核对中英文文案、实际 HTTPS 接口与安全审查。全量验证通过后按 Git 偏好提交并发布。
- [ ] 通过既有发布链路生成首个构建及更高构建。验证 Windows 取包和生产挂载，再请已登记设备完成覆盖安装及登录复用测试。
