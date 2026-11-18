const { contextBridge, ipcRenderer } = require("electron");

if (process.isMainFrame) {
  let listener = null;
  let ready = false;
  let generation = null;
  const initialCommands = [];
  ipcRenderer.on("bb:ready", (_event, state) => {
    if (!state || !Number.isSafeInteger(state.generation) || typeof state.discardQueue !== "boolean") return;
    generation = state.generation;
    ready = true;
    if (state.discardQueue) initialCommands.length = 0;
    for (const value of initialCommands.splice(0)) ipcRenderer.send("bb:command", value, generation);
    ipcRenderer.send("bb:command", JSON.stringify({ command: "status" }), generation);
  });
  ipcRenderer.on("bb:event", (_event, value) => {
    if (listener && typeof value === "string" && value.length <= 65536) listener({ data: value });
  });
  contextBridge.exposeInMainWorld("BillBoardDesktop", {
    postMessage(value) {
      if (typeof value !== "string" || value.length > 8192) return;
      if (ready) ipcRenderer.send("bb:command", value, generation);
      else if (initialCommands.length < 16) initialCommands.push(value);
    },
    subscribe(callback) {
      if (typeof callback !== "function") return () => {};
      listener = callback;
      return () => { if (listener === callback) listener = null; };
    },
  });
}
