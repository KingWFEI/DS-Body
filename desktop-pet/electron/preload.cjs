const { contextBridge, ipcRenderer } = require("electron");

// 这是 window.character 外部控制接口使用的内部 IPC 桥；不传出原始 ipcRenderer。
contextBridge.exposeInMainWorld("__desktopPetBridge", {
  // 在指定的 Windows 逻辑坐标启动一次移动。
  moveToScreen: (x, y, options) => ipcRenderer.invoke("pet:move-to-screen", x, y, options),
  // 按预设位置移动；选项与 moveToScreen 共用同一套运动策略。
  moveToPreset: (preset, options) => ipcRenderer.invoke("pet:move-to-preset", preset, options),
  // 取消当前移动任务。
  stopMovement: () => ipcRenderer.invoke("pet:stop-movement"),
  // 由渲染进程 requestAnimationFrame 按显示器原生刷新率（如 144Hz/280Hz VSync）推进窗口平滑位移。
  tickMovement: () => ipcRenderer.send("pet:vsync-tick"),
  // 请求主进程打开独立的对话窗口。
  openChatWindow: () => ipcRenderer.invoke("pet:open-chat-window"),
  // 请求主进程在模型右上角（靠右边缘时自动翻到左上角）显示回答气泡。
  showSpeechBubble: (payload) => ipcRenderer.invoke("pet:show-speech-bubble", payload),
  // 将主窗口语音对话产生的问答同步给已打开的文字聊天窗口。
  syncVoiceChatToWindow: (entry) => ipcRenderer.send("pet:sync-chat-entry", entry),
  // 仅在布局变化时上报模型与控件矩形；主进程独立处理穿透。
  setInteractionRegions: (regions) => ipcRenderer.send("pet:set-interaction-regions", regions),
  // 根据模型缩放比例同步调整桌宠窗口尺寸。
  setWindowScale: (scale) => ipcRenderer.send("pet:set-window-scale", scale),
  // 订阅主进程发布的真实窗口位置和移动状态；返回函数用于取消订阅。
  onMovementChanged: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, movement) => callback(movement);
    ipcRenderer.on("pet:movement-state", listener);
    return () => ipcRenderer.removeListener("pet:movement-state", listener);
  },
  // 订阅来自独立对话窗口转发的智能体角色控制指令（动作、表情、预设移动）。
  onAgentAction: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, action) => callback(action);
    ipcRenderer.on("pet:agent-action", listener);
    return () => ipcRenderer.removeListener("pet:agent-action", listener);
  },
});
