const messages = {
  "zh-CN": {
    loading: "正在连接家庭账本…", failed: "暂时无法连接账本，请检查网络后重试。", retry: "重试", save: "保存文件",
    permissions: "设备权限", microphone: "允许 BillBoard 在本次运行中使用麦克风进行语音记账？", camera: "允许 BillBoard 在本次运行中使用摄像头识别家庭码？",
    allow: "允许", deny: "暂不允许", closeTitle: "还有未完成的操作", close: "退出 BillBoard 将中断当前操作。请先保存内容，或等待处理完成。", keep: "继续使用", exit: "仍要退出",
    installTitle: "安装客户端更新", install: "更新将关闭 BillBoard。确认已保存内容并立即安装？", confirm: "重启并安装", cancel: "取消",
    startup: "BillBoard 无法启动，请检查私有客户端配置或重新安装可信安装包。", fileFailed: "文件未能保存，请检查目标位置并重试。",
  },
  "en-US": {
    loading: "Connecting to your household…", failed: "Unable to connect. Check your connection and try again.", retry: "Retry", save: "Save file",
    permissions: "Device permission", microphone: "Allow BillBoard to use your microphone for voice entries during this run?", camera: "Allow BillBoard to use your camera to scan a household code during this run?",
    allow: "Allow", deny: "Not now", closeTitle: "An operation is unfinished", close: "Closing BillBoard will interrupt current work. Save your changes or wait for processing to finish.", keep: "Keep using BillBoard", exit: "Exit anyway",
    installTitle: "Install client update", install: "The update will close BillBoard. Have you saved your work and want to install now?", confirm: "Restart and install", cancel: "Cancel",
    startup: "BillBoard could not start. Check the private client configuration or reinstall a trusted installer.", fileFailed: "The file could not be saved. Check the selected location and retry.",
  },
};

export function getDesktopMessages(locale) { return messages[locale === "en-US" ? "en-US" : "zh-CN"]; }
