> 摘要：BillBoard 项目长期架构、约定、流程和功能知识索引。

# BillBoard 项目 Wiki

## 功能与架构

- [家庭、成员与账本](households-and-ledgers.md)：家庭隔离、历史身份、多账本范围与设备偏好、固定任务目标及存量兼容约定。
- [家庭账务加密](household-encryption.md)：可选家庭开关、按请求临时持钥、独立换钥、业务事件保护与跨版本恢复约定。
- [Android 家庭客户端](android-app.md)：在线 WebView、原生权限边界、私有签名分发及更新约定。
- [iPhone 家庭客户端](ios-app.md)：GitHub Ad Hoc 签名、Windows 取包及指定家庭的 Safari 领取。
- [Windows 家庭客户端](windows-app.md)：Electron 在线窗口、用户级安装、独立签名及私有应用内更新约定。
- [客户端诊断功能移除约定](client-diagnostic-reports.md)：诊断功能下线、历史报告删除及旧数据库升级与恢复边界。
- [导入分类 Agent](import-category-agent.md)：WheelMaker Responses 分类建议、人工保存、数据范围与独立容器运行边界。
- [月度与年度 AI 对账](ai-bill-analysis.md)：Astra 重复／退款／报销关联、确定性预览、原子应用、后台状态和 UUID／加密恢复边界。
- [自然语言收支记账](natural-language-accounting.md)：文字与长按语音入口、临时音频与豆包 2.0 转写、Agent 记账两阶段、共享占用、混合收支原子入账及 UUID 恢复边界。
- [招商银行账单导入](import-cmb.md)：官方借记卡 PDF 和带密码 ZIP 的上传、解压、解析及隐私边界。
- [首页收支与结余趋势](home-trends.md)：月度结余、范围内累计、共享授权聚合、图表切换和月度明细口径。
