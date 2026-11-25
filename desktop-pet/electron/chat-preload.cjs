const { contextBridge, ipcRenderer } = require("electron");

/**
 * 对话窗口专用的受限预加载桥。
 * 仅允许对话窗口将后端智能体返回的动作/表情/移动指令安全转发给桌宠主窗口，不暴露原始 ipcRenderer。
 */
contextBridge.exposeInMainWorld("__chatWindowBridge", {
  dispatchPetAction: (action) => ipcRenderer.invoke("pet:dispatch-agent-action", action),
});
