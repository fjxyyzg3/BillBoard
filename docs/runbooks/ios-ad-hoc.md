# iPhone Ad Hoc 构建和家庭分发

家人在已登记的 iPhone 上用 Safari 打开 BillBoard 的 `/help`。登录后会回到 iOS 安装区。点「领取安装链接」，再点「安装 iOS 版」。链接过期时可在该区重新领取。覆盖更新也从这里开始。首次打开 App 时用原账本账号登录。

## 首次配置

1. 在 Apple Developer 中创建与 BillBoard Bundle ID 匹配的 App ID，登记要使用的 iPhone。准备含私钥的 Apple Distribution 证书（`.p12`）及其密码，为同一 App ID 和已登记设备生成 Ad Hoc 描述文件。记录真机型号和 iOS 版本。[Apple 注册设备分发](https://developer.apple.com/documentation/xcode/distributing-your-app-to-registered-devices/)
2. Windows 生产用户安装 GitHub CLI、Node.js 和 age 1.3.2。将 Windows amd64 发布归档的 SHA-256 与 `f48d8f8f9ebe903ab5027ed067652f2cc1db94bc206976430133b905dcd8e8c7` 核对后，解压 `age.exe` 与 `age-keygen.exe` 至 `%LOCALAPPDATA%\BillBoard\ios-tools`。该用户的 GitHub CLI 身份只需读仓库 Actions、构件和来源证明。[age 发行文件](https://github.com/FiloSottile/age/releases/tag/v1.3.2)
3. 在生产 checkout 的 `tmp\releases\ios\private` 创建解密身份并限制该目录的 Windows ACL。使用 `age-keygen.exe -o tmp\releases\ios\private\identity.txt` 生成身份文件，使用 `age-keygen.exe -y tmp\releases\ios\private\identity.txt` 读取公钥。把私钥备份到私有存储。生产用户还须限制 `tmp\releases\ios` 和 `tmp\verification\releases` 的写权限。容器只读挂载发布子目录。
4. 在 GitHub 配置 `ios-release` environment，部署分支规则选 `master`。设置 variables `IOS_BUNDLE_ID`、`IOS_TEAM_ID`、`IOS_AGE_RECIPIENT`，其中最后一项是生产机公钥。设置 secrets `IOS_PUBLIC_ORIGIN`、`IOS_P12_BASE64`、`IOS_P12_PASSWORD`、`IOS_PROFILE_BASE64`。用 Base64 编码二进制文件，服务地址填生产 HTTPS 根 origin。签名材料、真实服务地址和设备标识保存在私有配置。更新描述文件后可以用同一份已经验收的代码重新发布。
5. 在生产私有 env 为 `IOS_INSTALL_HOUSEHOLD_ID` 指定可领取的家庭，复用 `APP_PUBLIC_ORIGIN` 确定安装链接的 HTTPS origin。按现有入口启动 web。发布目录为 `tmp/releases/ios/published`。检查实际回源保护和日志，见 [网络检查清单](home-network-checklist.md#ios-ota-回源与日志)。
6. 以运行 Docker Desktop 的用户执行 `.\ops\windows\register-ios-release.ps1`。计划任务在该用户登录时启动，每 5 分钟检查一次。可手动执行 `.\ops\windows\pull-ios-release.ps1` 查看一次取包结果。末次日志为 `tmp/logs/ios-publication.log`。

## 从已验证的 master 发布

1. 完成仓库正式验证和安全审查。从生产的干净 `master` 核实远端 SHA 后，把对应的脱敏报告交给 `start-production.ps1 -IosVerificationReports`，参数接受一组 `summary.json` 路径。仅更新同一已部署提交的回执时，运行 `node ops/ios/record-verification.mjs <报告路径>`。回执记录受验 Git tree、各套件覆盖和原始结果。
2. Full suite 修复补跑时，把原始报告和有效补跑一起传入。如果某个旧树的套件证据经第 6 节核验可沿用，可用 `--retain=<suite>=<受验树 SHA>` 记录该套件。缺失、局部覆盖不足或错提交的回执会让取包保留上一发布版本。
3. 在 GitHub Actions 的 **Build BillBoard for iOS** 中选 `master` 并运行。要先验证无签名版本时，勾选 `simulator_only`。正式签名作业使用 macOS 26 与 Xcode 26.5，公开附件只有 `release.age`。GitHub 保留密文 7 天。
4. 在生产机核对该构建已切换到 `latest.json`，并用指定家庭的正常 Safari 会话从 `/help` 领取。Windows 可能在下一轮才拿到包或回执。补拉超过保留期时，从已验证的 `master` 再发一次。

## 首发核验

- 检查实际 HTTPS 回源及日志证据。用合成标记检查正常、失败和范围重试。报告只记录结果和状态，参见网络检查清单。
- 登记设备上从未登录的 Safari 完成首装与 App 登录。过期后重新领取，再覆盖升级到更高构建号，确认 App 已持久化的登录以及服务器会话状态。记录实际系统准备要求。
- 在测试账本验证手工记账和查询、本人同意后的语音记账、从「文件」导入、保存及打开 Excel。模拟器结果与真机结果分别记载。
