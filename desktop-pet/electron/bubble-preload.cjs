const { contextBridge, ipcRenderer } = require("electron");

/**
 * 桌宠右上角独立透明气泡窗口的受限预加载桥。
 * 接收主进程推送的气泡内容与左右翻转方向，并在淡出动画结束后通知主进程隐藏窗口。
 */
contextBridge.exposeInMainWorld("__bubbleWindowBridge", {
  onBubbleUpdate: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("pet:bubble-update", listener);
    return () => ipcRenderer.removeListener("pet:bubble-update", listener);
  },
  onBubbleSideChanged: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, side) => callback(side);
    ipcRenderer.on("pet:bubble-side", listener);
    return () => ipcRenderer.removeListener("pet:bubble-side", listener);
  },
  hideBubbleWindow: () => ipcRenderer.send("pet:hide-speech-bubble"),
});
