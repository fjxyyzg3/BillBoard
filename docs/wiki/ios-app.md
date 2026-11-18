> 摘要：iPhone 客户端复用 HTTPS 账本，使用 GitHub Actions 签名，经 Windows 取包后由指定家庭在 Safari 从帮助页领取。

# iPhone 家庭客户端

App 以 `WKWebView` 打开固定的 HTTPS 根入口，使用独立持久的 WebKit 数据存储。账本权限由服务器 `AppSession` 自当前成员派生。麦克风仅向可信主框架按需申请。导入通过系统文件选择器，Excel 保存沿用同源导出的成功结果和系统文档选择器。原生暂存限制为一个 32 MiB 内的副本，保存操作有效 10 分钟，冷启动清理遗留副本。

正式构建由 `master` 上的手动 GitHub 工作流签名为 Ad Hoc IPA。Windows 校验构建来源和本机的提交验证回执，解密验包后切换当前发布清单。构件的真实源站和 Apple 描述文件随密文交付。Help 只向指定家庭的有效成员签发安装凭据，由 iOS 系统读取绑定原会话和不可变摘要的文件。

新设备在 Apple 端登记并更新描述文件后可重新签名。iPhone 端通过同一个 Safari 入口更新，Bundle ID 和团队标识保持稳定。实际签名、生产回源和设备验收见发布运行手册。[发布运行手册](../runbooks/ios-ad-hoc.md) · [设计与验收](../scope/2026-11-18-ios-ad-hoc-release.md)
