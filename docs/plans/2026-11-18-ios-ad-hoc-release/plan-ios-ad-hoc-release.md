# BillBoard iOS Ad Hoc Implementation Plan

> **For agentic workers:** REQUIRED SKILL: Use implement to execute this plan task-by-task. Respect the handed-off git_state: inherit prepared, otherwise prepare; use git-workflow for checkpoint/finalize. Steps use checkbox syntax for tracking.

**目标** 经 GitHub Actions 签名发布家庭 iPhone 客户端，经生产机自动取包后从 Safari 的 `/help` 安装与更新。

**范围来源** [已批准 spec](../../scope/2026-11-18-ios-ad-hoc-release.md)。

**架构** macOS runner 生成加密且带构建来源证明的 IPA。Windows 按验证回执核对源码后切换只读发布目录。独立 iOS 领取接口复核原 `AppSession`，原生壳只接入可信网页和受限 Excel 保存。

**工具链** Next.js、Node.js、Windows 计划任务、GitHub Actions、Xcode、Swift 和 WebKit。

**验证** 聚焦用例后执行 `npm run verify:full`。真机和生产链路按 spec 分别记录证据。

## 1. 家庭领取与安装入口

- [x] 在 `tests/integration/ios-install.test.ts` 验证指定家庭、匿名、跨家庭、撤销、过期、用途分离、范围读取和旧摘要。E2E 基线因缺少安装区失败，接入后集成测试通过。
- [x] 在 `src/lib/ios-install.ts`、`src/app/api/ios/install/` 实现会话复核、加密凭据及不可变版本交付。复用 `src/lib/release-files.ts` 将有界读取扩展到 IPA 和单个字节范围。
- [x] 接入 `src/components/ios-install.tsx`、`/help` 与登录固定回跳，同步 `src/lib/i18n.ts`。登录回跳、公开帮助页和下载回归通过。

## 2. iPhone 容器与 Excel

- [x] 在 `ios/` 建立 Xcode 工程及无签名模拟器测试。测试覆盖 origin 判定、暂存边界和冷启动清理。
- [x] 在 `src/lib/ios-export.ts` 和 `src/components/record-export.tsx` 把本次成功响应分块交给系统文件选择器。补充传输及取消验证，沿用网页下载。
- [ ] 在 GitHub macOS runner 比较编译／模拟器证据。登记设备上实测首装、更新、录音、文件导入与 Excel，记录设备和系统。

## 3. CI、验收回执与自动发布

- [x] 在 `tests/unit/ios-release.test.ts` 验证缺失／不匹配回执、完整或补跑证据、乱序发布、相同构建异摘要和旧文件保留。初次缺少发布模块，实现后聚焦用例通过。
- [x] 在 `ops/ios/` 添加受验树、正式验收回执、加密归档、校验和原子发布。将 Windows 自动取包接入 `ops/windows/`，将产物只读挂载到 web 容器。
- [ ] 在 `.github/workflows/ios-release.yml` 配置受信 `master` 手动构建。验证无签名作业、公开附件只含密文、GitHub 来源、离线补拉及失败保留当前版。

## 4. 交付

- [ ] 更新 README、网络与 iOS 发布运行手册以及 wiki。运行安全审查和全量验证，复用仍有效的证据。
- [ ] 按仓库规则核对版本、提交、合入、推送与实际生产入口。记录签名材料、回源保护、注册设备等外部验收结果。

Spec 与计划的 checkpoint 依据 Git 偏好随同一功能提交记录。
