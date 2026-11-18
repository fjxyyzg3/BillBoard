# Android APK 构建与家庭分发

Android 客户端使用 WebView 连接现有 HTTPS 家庭服务，通过公开 `/help` 页面提供正式签名 APK 和中英文使用教程。主要验收设备为 OPPO Find X10 Pro Max／ColorOS 17；`minSdk 29` 是安装下限，不代表所有 Android 10 及以上设备均已真机验证。Android 工程位于 `android/`，不改变生产数据库与公网转发链路。

## 构建环境

安装 Node.js（沿用项目环境）、JDK 17 和 Android SDK。工程固定使用 Gradle 8.13、Android Gradle Plugin 8.13.2、Android SDK Platform 36 与 Build Tools 36.0.0。Gradle Wrapper 已带官方发行包 SHA-256，首次运行需要下载依赖。AndroidX 等依赖来自 Google Maven 和 Maven Central。

Windows 本机工具可放在 `%LOCALAPPDATA%/BillBoard/AndroidToolchain/`；路径由私有配置指定，不需要修改系统 PATH。安装 SDK 时使用官方 `sdkmanager`：

```powershell
& "C:/path/to/android-sdk/cmdline-tools/latest/bin/sdkmanager.bat" --install "platform-tools" "platforms;android-36" "build-tools;36.0.0"
```

需要模拟器验证时另外安装 `emulator` 和 `system-images;android-36;google_apis;x86_64`。SDK 许可按官方安装流程处理。下载 JDK、Gradle 和命令行工具时核对官方校验和，不使用不明镜像或关闭 TLS 验证。

Windows 测试模拟器没有可用主机音频设备时，可在启动模拟器的进程中设置 `QEMU_AUDIO_DRV=none`，使用提供静音样本的虚拟音频后端；不要开启主机麦克风透传。静音流可以验证录音权限和停止时序，但不能证明 OPPO 真机的录音质量。模拟器出现 SystemUI 无响应时应先恢复环境，再执行交互测试。

## 私有配置与签名

将 `.env.android.example` 复制为 `.env.android.local`，填写 `JAVA_HOME`、`ANDROID_HOME`、`BILLBOARD_ANDROID_ORIGIN` 和仓库外的 `BILLBOARD_ANDROID_KEYSTORE` 路径。可选 `GRADLE_USER_HOME` 指定本机 Gradle 缓存。服务地址必须是 HTTPS 根 origin，不携带账号、路径、查询或片段；使用现有生产 HTTPS 入口，不使用 OPS 端口。

首次创建正式签名：

```powershell
npm run android:signing:init
```

该命令创建 RSA 3072 位 PKCS12 密钥库和随机密码，密码写入 `.env.android.local`，不会打印。Windows 限制密钥库和配置文件的 ACL；其他平台使用用户私有文件权限。已有密钥库时命令拒绝覆盖；后续构建必须复用原签名材料。

在另一处可信的私有存储备份密钥库及 `.env.android.local`。同一磁盘上的副本不能替代灾难恢复备份。丢失正式签名私钥后不能用新签名直接覆盖原应用；卸载重装会丢失本机登录和草稿。正式 APK 包含服务地址，仅已发布的正式包通过现有 HTTPS 服务公开下载，不新增公共仓库 Release 或第三方制品托管。密码、私钥、真实入口、APK 和构建目录均不得进入 Git 或 Docker 构建上下文；私有配置、签名材料和未发布产物不公开。

## 验证与构建

```powershell
npm run android:check
npm run android:test:device
npm run android:build
```

`android:check` 执行 Android lint、JVM 策略测试，并构建 debug 与 instrumentation APK。`android:test:device` 使用隔离模拟器，默认 `emulator-5554`，可用 `BILLBOARD_TEST_SERIAL` 指定其他模拟器序列号；它使用合成 origin 和测试内容，不能向生产账本写入测试记录。Debug 应用使用独立包名 `com.billboard.app.debug`，与正式应用并存。脚本在目标进程未运行时切换安装来源权限，再分别验证已授权和未授权路径，避免现代 Android 因权限变更杀进程而中断测试。

使用 `npm run android:test:device -- --confirm-upgrade` 可额外执行模拟器内真实同签名覆盖升级。该测试由系统安装器替换正在测试的 debug 应用，宿主需独立读取升级后版本并复查 Cookie；不能用 instrumentation 进程退出本身当作成功证据，也不能对生产用户设备运行这项合成升级测试。

`android:build` 要求完整私有签名配置，执行 release lint、JVM 测试和 APK 构建；随后验证 APK v2 签名及证书与私有密钥库一致，再复制到 `tmp/releases/android/BillBoard-<version>.apk`。同目录生成 `.sha256` 校验文件与 `.json` 产物记录，包含包名、版本、证书摘要、Git SHA、工作树是否有修改和构建时间，不包含服务地址或密码。

版本名读取根 `package.json`，版本码按 `X * 1000000 + Y * 1000 + Z` 生成；`Y`、`Z` 必须不超过 999，版本码不能超过 Android 上限。分发使用已完成仓库全量测试与安全审查、已提交推送的版本，并确认产物记录的 `sourceDirty` 为 `false`、`sourceCommit` 与推送 SHA 相符。正式包固定 `com.billboard.app`，禁用 WebView 调试和系统备份；真实服务地址变更需要重新构建 APK。

## 手机安装与验收

使用手机浏览器打开现有 HTTPS 服务的 `/help`，无需登录即可下载当前正式 APK，按 ColorOS 系统提示允许该来源安装。首次安装及 `1.46.1` 旧客户端引导升级使用此方式；原生壳限制普通安装包下载，安装带更新器的版本后，后续 APK 使用应用内“应用更新”。更新时在已安装版本上覆盖安装，保持包名和签名一致，不先卸载。网页和帮助内容随服务器发布更新，不要求重建 APK；容器、权限或内置地址改变时重新发布 APK。

在实际 OPPO 设备上分别核验：首次安装和覆盖升级、登录与重启后登录保持、中英文切换、返回手势与键盘、手工和自然语言记账、`.xlsx`／`.csv`／`.pdf`／`.zip` 文件选择导入，以及语音授权、拒绝、取消和切后台停止录音。断网／服务失败应显示可理解的提示，重试不能自动重复提交账务；外链交给浏览器，TLS 错误不能跳过。

仓库的 `npm run lint`、`npm run test:unit`、`npm run test:integration` 和 `npm run test:e2e` 仍须通过，e2e 只能连接开发／测试库。Android 自动化使用合成数据；实际生产登录 smoke check 只检查可达性与会话，不为了测试创建真实账目。模拟器通过不代表 OPPO 真机已通过，验收记录必须分别列出结果与未验证项。

架构边界见 [Android 家庭客户端](../wiki/android-app.md)。

## 发布安装包与应用内更新

先完成仓库要求的完整验证、安全审查、版本递增和 `master` 提交推送，再从干净的已推送提交运行 `npm run android:build`。确保服务端已部署包含公开下载和更新接口的版本，且 `compose.yml` 将 `tmp/releases/android/published` 只读挂载到 `/var/lib/billboard/android-updates`。该目录及 APK 继续排除在 Git 与镜像构建输入之外，不添加公网端口、静态目录暴露或签名材料挂载。

```powershell
npm run android:publish -- --metadata tmp/releases/android/BillBoard-1.47.0.apk.json --notes-zh "支持应用内检查、下载和安装更新。" --notes-en "Check, download and install app updates."
```

后续发布将命令中的版本和中英文说明替换为实际内容。发布脚本校验产物元数据、干净且已推送的 master、APK 内实际包名与版本、v2 签名及私有密钥库证书。校验通过后先写入不可变 `<sha256>.apk`，最后原子替换 `latest.json`；失败保留先前清单，禁止发布降级版本。已发布产物不改写，最新清单切换后，之前已经开始的下载仍使用原摘要路径。

`GET /api/downloads` 无需登录即可读取公开下载所需的各平台版本、大小等信息，`GET /api/downloads/android` 无需登录即可流式下载当前已发布 APK。两者读取同一发布清单，页面不以网页版本替代 APK 版本；安装包不可用时显示明确状态，教程和 Windows 下载保持独立。公开下载受并发和超时限制，不接受任意路径或外部 URL。

原生更新的 `GET /api/android/update` 返回最新清单，`GET /api/android/update/<sha256>` 返回不可变 APK；两者仍校验有效 AppSession，未登录返回 401，无可用发布返回 404，不重定向到登录页。响应 `no-store`；服务启动时目录为空不会妨碍记账。原生限制清单为 32 KiB、APK 为 100 MiB，下载仅走固定同源 HTTPS，禁止重定向。单纯升级网页版本不会改变发布清单，也不会制造 APK 更新红点。

发布后分别验证匿名帮助页、下载信息和当前 APK 可用，以及原生更新两条接口未登录仍返回 401；使用已登录会话检查原生清单版本，并核对公开和原生下载 APK 的大小、摘要。不能把 Cookie、真实域名或带凭据 URL 输出到日志。应用启动或回前台每 15 分钟内最多自动检查一次，手动“检查更新”立即重试。出现红点后打开“应用更新”，先保存未提交内容，再选择“下载并安装”。首次需要在系统中允许 BillBoard 安装应用；返回后点击“安装更新”，在系统安装器确认，完成后重新打开应用。

在 OPPO 真机补验来源授权拒绝／返回、安装确认／取消、下载失败重试、后台完成不自动弹安装，以及成功升级后红点消失和登录保持。录音、待确认记账、保存及导入进行中必须阻止安装。自动化证据分别覆盖网页交互、分发认证与文件校验、原生桥及安装器；不能把浏览器桥模拟或 ADB 覆盖安装单独当作完整的应用内升级验收。
