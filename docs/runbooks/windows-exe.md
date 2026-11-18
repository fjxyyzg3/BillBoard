# Windows 联网客户端构建、下载与应用内更新

BillBoard Windows 客户端是连接既有 HTTPS 根路径服务的 Electron 安装版，首版交付 Windows x64，通过公开 `/help` 页面提供正式 EXE 和中英文使用教程。账目仍由服务端保存，不安装本机数据库；Windows 11 是主要验收环境，其他系统版本只按实机证据记录。

## 私有配置与持久签名

维护者使用 Node.js 22.12 以上的 22 LTS，以及独立的 `desktop/package-lock.json`。在仓库根目录复制 `.env.desktop.example` 为未跟踪的 `.env.desktop.local`，填入：

```dotenv
BILLBOARD_DESKTOP_ORIGIN="https://billboard.example"
BILLBOARD_DESKTOP_UPDATE_PRIVATE_KEY_FILE="C:/Private/BillBoard/windows-update-ed25519.pem"
```

示例地址必须替换为既有 HTTPS 根 origin，不带路径、账号、查询参数或 fragment。真实入口不得写入 Git 跟踪文件或历史，仅从私有配置注入正式安装包；私钥和本机配置不得提交、公开或加入 web 镜像，密钥路径必须位于主仓库及所有 worktree 之外。公开范围限于现有 HTTPS 服务提供的已发布正式安装包，未发布产物不公开，不新增第三方托管。

```powershell
npm --prefix desktop ci --ignore-scripts --no-fund --no-audit
node desktop/node_modules/electron/install.js
npm run desktop:signing:init
```

Electron 45 的 npm 包在需要时单独下载内核；上面的显式安装从该锁定版本的官方发行内容准备本机内核。签名初始化只建立 Ed25519 更新密钥并限制 Windows ACL，已存在文件会拒绝覆盖。先私下备份私钥与配置，并核对输出的公钥 SHA-256 指纹，再首次分发；此后始终复用该密钥。服务端、网页和安装包都不保存私钥。

这把密钥用于验证更新清单，不是 Windows 发布者证书。首次安装可能显示发布者未知或 SmartScreen 提示，使用可信应用 HTTPS 服务的帮助页获取安装包与内置公钥，不要求用户关闭系统防护。私钥丢失或泄露后必须按事故范围处置并重新通过可信渠道建立安装信任，不能关闭更新校验继续发布。

## 检查、正式构建与发布

先完成仓库要求的 lint、unit、integration、e2e 和安全审查。桌面检查不读取真实入口或私钥：

```powershell
npm run desktop:check
npm --prefix desktop audit --json
```

`desktop:check` 核对根版本、独立锁及已安装依赖，生成唯一共享协议副本，检查原生源码语法并运行原生行为测试。真实 Electron、系统文件保存、音频设备及 NSIS 安装／双版本升级的证据另由 Windows 验证流程取得；单元测试不能替代这些证据。

在开发库没有其他测试运行、端口 `2500` 空闲时，执行真实 Windows 验证：

```powershell
npm run desktop:test:windows
npm run desktop:test:web
```

前者使用隔离 HTTPS fixture、独立产品资料和两版真实 NSIS，核验原生桥、签名／会话、导航取消、安装覆盖及卸载后资料保留。`--bridge-only` 只跑桥与更新验证，不提供安装验收证据。后者在合成家庭与开发库中验证真实 Next.js 页面和 Electron，包括记账、导入导出、加密备份回读及原 UUID 重启恢复；`--check` 只做静态准备检查。二者证据写入未跟踪的 `tmp/windows-*-validation-*/evidence.json` 或 `tmp/windows-validation-*/evidence.json`。

验证证书仅通过子进程的 `NODE_EXTRA_CA_CERTS` 和合成 SPKI 使用，不修改系统信任库；正式产品拒绝调试及跳过 TLS 的启动参数。自动化在原生文件选择／保存边界选定固定测试文件，真实文件写入及回读另行核验，不能据此宣称人工操作了系统对话框。真实麦克风和摄像头按设备盘点与实际录音分别记录；没有硬件时保留未验证项。

正式构建和首次分发均要求工作区干净、当前分支为 `master`、本地 SHA 与实际 `origin/master` 相同，并且构建记录仍与当前提交一致。先按仓库规则完成完整验证和安全审查、提交并推送，再在该干净提交执行：

```powershell
npm run desktop:build
```

输出目录为未跟踪的 `tmp/releases/windows/`：

- `BillBoard-X.Y.Z-x64.exe`：完整的当前用户 NSIS 安装包。
- 同名 `.exe.sha256`：安装包摘要。
- 同名 `.exe.json`：版本、固定产品与架构、大小、摘要、公钥指纹、源 SHA 和干净状态；不含入口或秘密。

安装包中的 `runtime-config.json` 固定包含服务 origin、公钥、协议 `productId`、安装版本和 Windows `appId`。正式产品的两种 ID 均为 `com.billboard.desktop`，不接受网页指定地址或其他公钥。构建工具回读安装器内的实际 ASAR 元数据，核对版本和内置公钥；已有同版本输出不会被覆盖。

服务端接口按普通应用发布流程部署并健康核验；正式更新发布仍从同一已推送的干净 `master` 执行。说明为纯文本，中英文各不超过 4,000 字符，不要写入真实入口、账号或账目：

```powershell
npm run desktop:publish -- --metadata tmp/releases/windows/BillBoard-X.Y.Z-x64.exe.json --notes-zh "更新说明" --notes-en "Release notes"
```

此命令只在本机发布目录 `tmp/releases/windows/published/` 写入不可变 `<sha256>.exe`，再原子替换签名 `latest.json`，不会上传到外部托管服务。`compose.yml` 将该目录只读挂载为 `/var/lib/billboard/windows-updates`，构建和发布产物继续排除在 Git 与 web 镜像外，服务端不持有私钥。

`GET /api/downloads` 无需登录即可读取公开下载所需的各平台版本、大小等信息，`GET /api/downloads/windows` 无需登录即可流式下载当前已发布 x64 EXE。两者复用 Windows 发布清单，不以网页版本替代 EXE 版本；安装包不可用时明确提示，教程和 Android 下载保持独立。公开下载受并发和超时限制，不接受任意路径或外部 URL。原生更新的 `GET /api/windows/update` 及 `GET /api/windows/update/<sha256>` 继续校验有效原 `AppSession`，未登录返回 401。

发布会再次检查包大小、摘要、安装器内实际版本／产品／内置公钥、签名密钥与源提交。降级、同版本更换内容或说明、切换签名密钥均被拒绝。已有摘要文件只允许复核后复用，不能原地覆盖；旧摘要产物须保留，不能在下载仍可能进行时删除。发布中断保留旧 `latest.json`，可以先核验旧清单和包，再重试同一产物；若有 `.publish.lock`，先确认没有发布进程及临时工作仍在使用，不能盲目删除锁。

发布后分别验证匿名帮助页、下载信息和当前 EXE 可用，以及原生更新两条接口未登录仍返回 401；使用已登录会话检查原生清单版本，并核对公开和原生下载 EXE 的大小、摘要。日志不得输出 Cookie、真实入口或带凭据 URL。

## 安装、升级与恢复边界

首次安装使用系统浏览器打开现有 HTTPS 服务的 `/help`，无需登录即可下载当前正式 EXE。原生壳限制普通安装包下载，已安装客户端使用既有“客户端更新”。公开下载不授予账号或家庭权限；帮助页随服务器部署更新，不要求重建 EXE。

安装为当前 Windows 用户创建桌面、开始菜单及系统卸载入口，不注册开机自启或本机后台服务。固定 `appId` 和用户资料目录在覆盖升级时保留 Cookie、Web Crypto 保护材料及已持久化草稿；普通卸载保留资料，不延长或恢复失效会话。首次登录、显式退出、身份失效及重新登录仍按服务端和原有本机清理规则处理。

客户端下载、验签及摘要校验后仍须由用户明确点击“重启并安装”。页面会先阻止新提交，复核录音、待确认结果、表单保存、导入导出和加密操作，未知或忙碌状态会拒绝安装；关闭面板、后台、普通退出或下载完成均不自动安装。

NSIS 安装和卸载均先只读检测进程，最多等待 15 秒正常退出；仍运行或无法确认时提示保存退出并取消本次操作，不发送关闭或强杀命令。手动运行安装器也遵循该保护。安装开始前取消时旧版保持可用；安装已经开始后若遇到磁盘或安全软件中断，重新运行同一可信安装包并核验实际安装版本，不宣称自动回滚。

应用更新缓存与业务资料分开，清理下载缓存不操作账目或家庭码。排障日志不得包含 Cookie、真实入口、查询参数、家庭码或账单内容。不要用删除整个用户资料目录解决下载失败。

隔离验证可以通过 `ops/desktop/build-exe.mjs` 导出的 staging／builder 函数生成合成包，使用独立密钥、合成 HTTPS origin 和 `com.billboard.desktop.validation.<suffix>` 的 Windows `appId`；协议产品 ID 仍固定。正式 CLI 没有允许脏工作区、替换产品 ID、HTTP 或跳过验签的开关。测试包与正式资料隔离，测试账目只写开发／测试库。

工具链依据 [Electron 45.0.0 官方发行记录](https://releases.electronjs.org/release/v45.0.0)、[electron-builder 26.15.3 固定发行](https://github.com/electron-userland/electron-builder/releases/tag/electron-builder%4026.15.3) 及该版本本地 NSIS 模板核对；进程检测返回码依据 [NSIS nsProcess 文档](https://nsis.sourceforge.io/NsProcess_plugin)。升级依赖时须重验安装／卸载的正常退出保护，不能直接依赖新版网站默认文档。
