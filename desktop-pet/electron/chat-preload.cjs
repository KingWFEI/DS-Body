const { contextBridge, ipcRenderer } = require("electron");

/**
 * 对话窗口专用的受限预加载桥。
 * 支持：
 * 1. 将后端返回的动作/表情/移动指令转发给 3D 桌宠主窗口；
 * 2. 在模型右上角同步弹出回答气泡；
 * 3. 接收主窗口通过语音输入产生的对话记录，保持语音与文字历史实时同步。
 */
contextBridge.exposeInMainWorld("__chatWindowBridge", {
  dispatchPetAction: (action) => ipcRenderer.invoke("pet:dispatch-agent-action", action),
  showSpeechBubble: (payload) => ipcRenderer.invoke("pet:show-speech-bubble", payload),
  onVoiceChatSynced: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, entry) => callback(entry);
    ipcRenderer.on("pet:chat-sync", listener);
    return () => ipcRenderer.removeListener("pet:chat-sync", listener);
  },
});
