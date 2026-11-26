const { contextBridge, ipcRenderer } = require("electron");

/**
 * 屏幕侧边折叠悬浮按钮窗口的受限预加载桥。
 * 接收贴靠侧（left / right）更新外观圆角朝向，并在点击时通知主进程恢复桌宠原样。
 */
contextBridge.exposeInMainWorld("__dockWindowBridge", {
  onDockSideChanged: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, side) => callback(side);
    ipcRenderer.on("pet:dock-side", listener);
    return () => ipcRenderer.removeListener("pet:dock-side", listener);
  },
  restorePet: () => ipcRenderer.invoke("pet:restore-from-dock"),
});
