const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("BillBoardHost", {
  retry: () => ipcRenderer.send("bb:retry"),
  subscribe(callback) {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, value) => { if (value && typeof value === "object") callback(value); };
    ipcRenderer.on("bb:host", listener);
    return () => ipcRenderer.removeListener("bb:host", listener);
  },
});
