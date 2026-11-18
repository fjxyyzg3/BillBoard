# 家庭账本加密与独立恢复

本功能按家庭选择开启，既有家庭升级后保持未加密。开启后当前账务视图保存密文；客户端临时上传家庭码供服务端处理，因此这是静态存储保护，不能描述为开发者在服务运行期间也无法读取数据的端到端加密。

## 模式、换钥与历史材料

- 当前有效负责人可开启、关闭或独立换钥；有效成员可导入并使用现有码。独立换钥保持已加密状态，无须先关闭。
- 首次／再次开启及每次换钥发布前，家庭须独立保存并回读验证当前码与 `BBP1` 密文恢复包。恢复包只含各周期／版本的包封密钥，不含历代主码，不要求个人恢复密码。
- 当前码与包含完整历史包封密钥的较新恢复包可打开旧周期快照。旧在线库中的 `BBR1` 包、本机缓存、账号密码和登录 Cookie 均不能代替独立恢复包。
- 关闭后，保留最近有效码及相应恢复包以恢复旧密文备份。再次开启建立新周期并带入仍被保留恢复点依赖的历史包封密钥；缺失材料时停止，不丢弃旧备份或猜测归属。
- 操作按原 UUID 查询唯一终态。超时、断连、应用重开或重新登录均不表示旧尝试已取消；新会话只能查询并由当前负责人明确终止，不能续用旧会话的发布权限。

## 工具默认只检查

在仓库根目录执行：

```powershell
node --import tsx ops/encryption/verify-recovery.mts --help
node --import tsx ops/encryption/verify-recovery.mts --snapshot <私有财务快照包.json> --manifest-digest <可信清单中的SHA256> --recovery-package <独立BBP1密文恢复包>
```

默认入口只校验，不连接或写入数据库，不恢复账号或会话。加密源要求当前可用码和独立恢复包；未加密源的只读校验无需家庭码。`manifest-digest` 必须来自独立核实的恢复点清单，不能临时从同一份未知文件计算后当作可信依据。

家庭码仅在终端隐藏输入，或由有界临时 stdin 输入；不得拼入命令、shell 历史、环境变量、密钥文件、URL、日志或聊天记录。密文恢复包与快照文件可按私有备份规则保存，家庭码由家庭自行保管。工具只输出计数、比较字段数及通过／失败，不输出原始行、分组金额、账号、码或连接串。JavaScript 字符串和垃圾回收无法提供所有内存副本立即擦除的证明。

合成演练入口：

```powershell
node --import tsx ops/encryption/verify-recovery.mts --synthetic
```

该入口只接受 loopback 的 `_dev`／`_test` 管理连接和 PostgreSQL 17，并要求本地角色具备 `CREATE DATABASE` 权限。测试创建两个随机独立数据库，原样执行仓库全部迁移、建立合成源与最新授权基础，在删除自建在线源数据库、清空旧码和本机 ring 后，仅用当前码及独立恢复包恢复到财务空目标；逐字段和上海月份／家庭／账本／成员／收支／软删除分组比较。历史迁移含显式 `public` 语句，因此使用数据库隔离，不能仅替换连接串中的 schema。所有删表／删库操作限已校验且由本次创建的随机隔离数据库，不对开发库 `public` 或真实备份执行清空；删库前断开自有连接，不使用 `FORCE` 终止其他连接。中断后若遗留数据库，须先核实创建归属及 worker 已停止，再按具体名称受控清理；不得按前缀批量删除未知数据库。

合成测试通过只证明这些合成恢复路径，不表示真实生产备份、实际外部日志或 Android 真机已验收。

## 财务恢复库与最新检查点

`src/lib/encryption/recovery.ts` 提供以下离线维护接口，不接入普通应用路由：

1. `captureFinancialSnapshot` 在一致快照中收集所有 `protectedModels` 的完整标量字段，包含软删除交易、pending／completed 草稿、映射、退款关系、原 UUID／输入摘要／结果和 AppEvent 业务 payload。快照不包含 User、HouseholdMember、AppSession、邀请或登录 Token 的复制接口。
2. `verifyFinancialSnapshot` 核对独立可信清单摘要、物理快照、所需周期／版本、实际 AEAD 解密、完整字段及分组证据。加密源的内容／分组证据同样由家庭密钥保护；恢复包缺失、错家庭、错用途或历史版本不足均拒绝。
3. `inspectRecoveryFoundation` 读取目标已有授权元数据摘要及当前保护配置。目标必须预先装入从最新可信来源核验的家庭、账号状态、历史成员、撤销／过期会话及分类，不得直接从旧财务快照重建授权。
4. `restoreFinancialSnapshot` 要求目标已有经核验且明确稳定的 `ENCRYPTED` 或 `UNENCRYPTED` 配置、所有财务表为空且无资源执行租约。调用方须提供最新授权摘要、核验时间、每个模型明确的已确认删除 ID 清单和交易软删除检查点；不能用旧备份或自行生成的空清单充当最新事实。目标模式始终来自该当前配置，恢复库不会从快照复制或修改模式标记。

恢复在同一事务中复核目标检查点、历史引用及所需材料，并按当前目标模式写入、回读逐字段和分组比较；任一不符整体回滚。已加密目标必须验证当前码、独立恢复包和在线 ring 一致，再用当前 ring 加密全部财务行；旧未加密快照也不能沿用旧模式造成降级。

新财务包使用 v3 固定实体集合，包含 `BillAnalysisReport`、`BillAnalysisRequest` 与 `BillReconciliationApplication`，最新删除检查点也必须是 v3 并明确新增实体。旧 v1／v2 包分别按各自原固定集合和原 digest/proof 验证，再在内部补空新增表；不重算或改写旧包来伪造真实性，不把缺表新版降级成旧版。捕获／恢复拒绝仍在执行的扫描请求或报告活动指针；应用回执只能是稳定终态，拒绝执行载荷和凭据。原 AppSession 仅保留历史绑定，不能从恢复包重建会话、续跑任务或自动应用修改。

旧加密快照恢复到已明确选择未加密的目标，仍须用当前或关闭期间最近有效码打开独立 `BBP1` 恢复包，实际认证解密全部源及清单证据，并与目标保留的周期、版本和恢复包摘要核对；不依赖在线 `BBR1` ring，也不能因目标未加密而绕过材料检查。通过后仅按原值写入获准明文，密文及修订列为空。源和目标均未加密时，`material` 可以省略，无须提供家庭码、恢复包或虚构密钥配置。上述跨模式恢复均使用同一 `restoreFinancialSnapshot` 维护接口。

已确认删除 ID 若仍出现在快照中，或旧记录会撤销较新的软删除，整次恢复拒绝并保留原材料。库只写财务表，保持已有账号状态、成员角色／离开时间、AppSession 到期／撤销及家庭当前模式，不复活旧授权。恢复现场仍须与最新删除／撤销记录逐项核实，工具无法替代对检查点来源与完整性的人工确认。

## 转换屏障与实际执行占用

开启／关闭先建立家庭转换屏障，阻止新写入与任务，待已受理任务真正结束或安全终止后转换。批次、发布及最终回执均复核原 AppSession、负责人、模式代次和操作期限；只查询旧回执不会重新授予提交权限。

`ResourceLease.expiresAt` 只表示结果与租约已过期，不能证明解析器、供应商请求或私有文件清理已经停止。实际受理同事务建立 `ResourceExecution`；容量统计保留过期但仍有 execution 的工作，其他家庭的新受理不得提前回收它。真实任务及清理 settle 后才原子释放 execution 和 lease。

进程崩溃可能留下保守占用。先停止全部相关 web／任务 worker，确认没有解析子进程、供应商请求或清理仍在运行，盘点 token 对应家庭／任务与待处理私有文件，再按已核实清单删除 execution／lease。不得只凭 TTL、重新登录或切换账本解除占用，不得清空其他仍运行任务的记录。

AI 对账沿用账单分析独立的本地执行者/启动代次和受控回收：正常执行已清理或确认原进程停止后，先封禁旧任务保存、清除匹配的报告活动指针，再释放其 execution/lease；旧报告正文保持。Windows 正式启动监督会核对退休 web 容器的完整 ID、Compose 身份及停止/删除事实，只有可信宿主监督才能提供 stopped-runtime proof。其他任务不套用此回收入口，详细步骤见[分析执行者回收](home-network-checklist.md#analysis-runtime-cleanup)。

加密语音在读取正文前建立延期扣额的上传占用；`chargedAt` 为空表示尚未正式受理。完整音频、家庭码、原身份、本人同意及 UUID 验证通过后，在同一受理事务中一次扣除全部窗口并设置 `chargedAt`；缺码、错码或非法输入不扣处理额度。延期占用仍参与全局／家庭／成员并发统计，取消须等上传流实际停止后释放。普通 WAV 保持原有扣额时点，已经扣过的有效租约不重复扣除。

两个家庭模式的导出临时文件均从写入首字节开始使用任务独立随机密钥保护，领取时认证解密，结束后清零可控密钥／缓冲。临时密钥不进入家庭持久化配置，进程崩溃后遗留文件无法依靠服务器配置重新打开。Excel 成品32 MiB、十万行、生成60秒及下载110秒限制保持。

Next Server Actions 和 proxy body 均明确限制为25 MiB，以容纳既有20 MiB账单及有界multipart／密钥元数据；实际文件校验仍为20 MiB，不以默认1 MiB action或10 MiB proxy缓冲静默收紧入口。修改框架版本或前置服务后须重新验证真实HTTP上传。

## 正式物理替换与旧副本清单

可选开关执行的逻辑转换不等于旧物理明文已清除。数据库旧行版本、WAL、原卷、备份、恢复副本、导出及外部供应商历史保留必须分别盘点。关闭加密生成的明文、明文暂存及相应 WAL 也在盘点范围内；失败或取消不能把这些副本视为自动消失。

正式替换按以下顺序执行：

1. 确认具体家庭授权、恢复点保留与删除范围，列出全部源卷、WAL、快照、导出及外部副本，准备最新授权／撤销／停用／确认删除检查点。未知副本单独记录，不宣称已清除。
2. 在私有隔离环境以 PostgreSQL 17 完成实际恢复演练；恢复包须独立于在线库和客户端缓存可取得。验证每个保留恢复点所需历史版本，逐表逐字段、引用、UUID／结果和分组摘要一致，不能只看 `pg_restore` 成功或行数相等。
3. 全实例停写并收敛所有写入者及实际执行中的任务，取得最终一致快照和私有备份。家庭锁不能替代实例维护停写。
4. 恢复到已核实为空的干净 PostgreSQL 17 新卷，先建立最新可信授权基础，再按当前家庭保护方式恢复财务；已加密家庭只写密文及允许元数据，未加密家庭保留获准明文。生产不执行 seed。
5. 验证新库、新备份实际恢复、全部原字段与统计，以及同一已验证版本的私有 smoke、当前身份／撤销状态，然后切换实例并恢复写入。验证失败保持目标隔离，保留源与备份。
6. 按具体授权清单处理已有可验证密文替代的旧明文副本；普通文件删除不能证明介质不可恢复。外部日志、供应商侧保留及不可核验副本分别说明限制。

新实例一旦接受新写入，回退必须保全并核验最新账目，优先向前修复。不得用旧快照直接覆盖新增记录、恢复旧会话或复活已确认删除的数据；保留原 UUID 和已提交结果，不能靠重新导入重建交易。

真实 HTTPS 入口、转发日志不含音频能力 URL／查询串／家庭码、私有临时目录权限、Android Keystore／QR 权限和真实生产备份恢复须按各自实际环境另行验证。不得将合成演练、离线 Android unit 或本地浏览器结果写成真实生产／真机证据。

## Android debug 真机验证

`HouseholdKeyDeviceTest` 仅操作 `com.billboard.app.debug` 的随机合成身份，复用本地响应夹具，不连接家庭服务。先构建并核验 APK 的 debug 包名及可调试标志，再安装到已授权的专用 Android 10+ 测试设备；构建脚本固定使用 `https://billboard.example`。类的预检会在任何 Keystore 或 Activity 操作前再次断言实际 debug 包及编译进 APK 的合成 origin。不要用正式包或改成生产地址，也不要运行会选择全部 instrumentation／更新安装测试的 `android:test:device`。

```powershell
npm run android:check
$androidSdk = '<本机Android SDK目录>'
$deviceSerial = '<已核验的测试设备序列号>'
$adb = Join-Path $androidSdk 'platform-tools/adb.exe'
$aapt = Join-Path $androidSdk 'build-tools/36.0.0/aapt2.exe'
& $aapt dump badging .\android\app\build\outputs\apk\debug\app-debug.apk | Select-String '^package:|application-debuggable'
& $adb -s $deviceSerial install -r -d .\android\app\build\outputs\apk\debug\app-debug.apk
& $adb -s $deviceSerial install -r .\android\app\build\outputs\apk\androidTest\debug\app-debug-androidTest.apk
& $adb -s $deviceSerial shell am instrument -w -r -e class 'com.billboard.app.HouseholdKeyDeviceTest#verifiesDebugPackageAndSyntheticOrigin' com.billboard.app.debug.test/androidx.test.runner.AndroidJUnitRunner
& $adb -s $deviceSerial shell am instrument -w -r -e class com.billboard.app.HouseholdKeyDeviceTest com.billboard.app.debug.test/androidx.test.runner.AndroidJUnitRunner
```

预检须为 `OK (1 test)`，再运行完整指定类，记录设备 Android／WebView 版本及每项结果。实际测试涵盖非导出 Android Keystore 密钥、私有密文包跨 store 实例、身份隔离及删除后旧包不可恢复、主框架桥在 Activity 重建／重开后读回，以及同源子框架、opaque 和外来源拒绝；只清理本次合成身份。编译和 JVM 单测不能替代这些设备执行结果。

完整前端的扫码／粘贴、同身份会话到期后的原 UUID／草稿、显式退出及切换账号清理仍须在私有合成测试环境手工核验：先拒绝相机权限并确认仍可粘贴，再按需授权扫码；退出后旧身份不能自动解锁，正常关闭重开可恢复同身份。没有可用测试设备、完整前端夹具或未执行的项目均记录为未验证，不能写为真机通过。
