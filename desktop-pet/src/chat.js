/**
 * 小鲸娘独立对话窗口前端逻辑。
 *
 * 功能说明：
 * 1. 启动时检测 `agent-backend` 健康状态与 DeepSeek 密钥是否已配置，并实时展示在顶部状态栏。
 * 2. 管理用户输入、发送防抖、滚动定位及“清空对话”会话重置。
 * 3. 收到后端回复后，通过 Electron 预加载桥（或浏览器 BroadcastChannel 降级通道）驱动 3D 桌宠同步执行动作、表情和屏幕移动。
 */

// 后端智能体服务地址（可通过环境变量 VITE_AGENT_API_BASE 覆盖，默认本地 8000 端口）
const API_BASE_URL = (import.meta.env.VITE_AGENT_API_BASE || "http://127.0.0.1:8000").replace(/\/+$/, "");

// 当前窗口使用的会话 ID（持久化在 sessionStorage 中，刷新页面保持同一轮会话）
const SESSION_STORAGE_KEY = "ds-body:chat-session-id";
const sessionId = getOrCreateSessionId();

// 浏览器多标签页预览模式下的降级广播通道（Electron 环境下优先走 __chatWindowBridge IPC）
const fallbackChannel =
  !globalThis.__chatWindowBridge && typeof globalThis.BroadcastChannel === "function"
    ? new globalThis.BroadcastChannel("ds-body:agent-action")
    : null;

const messagesEl = document.querySelector("#messages");
const statusEl = document.querySelector("#connectionStatus");
const chatForm = document.querySelector("#chatForm");
const messageInput = document.querySelector("#messageInput");
const sendBtn = document.querySelector("#sendBtn");
const clearBtn = document.querySelector("#clearBtn");

let isSending = false;

/** 获取或生成当前窗口的唯一会话 ID。 */
function getOrCreateSessionId() {
  try {
    const cached = sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (cached) return cached;
    const created = `pet-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    sessionStorage.setItem(SESSION_STORAGE_KEY, created);
    return created;
  } catch {
    return "default";
  }
}

/** 更新顶部连接状态指示器样式与文案。 */
function updateStatusBadge(mode, text) {
  statusEl.className = `status-badge status-${mode}`;
  statusEl.textContent = text;
}

/** 检查后端服务连通性以及是否已填入 DeepSeek 密钥。 */
async function checkBackendHealth() {
  try {
    const response = await fetch(`${API_BASE_URL}/health`, { method: "GET" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();

    if (data.api_key_configured) {
      updateStatusBadge("online", `已连接 DeepSeek (${data.model})`);
    } else {
      updateStatusBadge("demo", "演示模式 · 待在 .env 填入 DeepSeek 密钥");
    }
    return data;
  } catch {
    updateStatusBadge("offline", "后端未连接 · 请启动 agent-backend (8000)");
    return null;
  }
}

/** 将滚动条平滑置于消息列表底部。 */
function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

/** 格式化智能体触发的动作标签说明，方便直观看到角色联动。 */
function formatActionLabel(action) {
  if (!action || typeof action !== "object") return "";
  const parts = [];
  if (action.motion) parts.push(`动作: ${action.motion}`);
  if (action.expression) parts.push(`表情: ${action.expression}`);
  if (action.move_preset) parts.push(`移动: ${action.move_preset}`);
  return parts.length > 0 ? `✨ ${parts.join(" · ")}` : "";
}

/** 向消息列表追加一条聊天气泡（使用 textContent 防止 XSS 注入）。 */
function appendChatMessage({ role, text, action = null, isTyping = false }) {
  const group = document.createElement("div");
  group.className = `message-group ${role === "user" ? "user" : "pet"}`;

  const bubble = document.createElement("div");
  bubble.className = `message ${role === "user" ? "user-message" : "pet-message"}`;
  if (isTyping) bubble.classList.add("typing-message");
  bubble.textContent = text;
  group.appendChild(bubble);

  const actionText = formatActionLabel(action);
  if (actionText) {
    const tag = document.createElement("span");
    tag.className = "action-tag";
    tag.textContent = actionText;
    group.appendChild(tag);
  }

  messagesEl.appendChild(group);
  scrollToBottom();
  return { group, bubble };
}

/** 向消息列表追加一条居中的系统提示。 */
function appendSystemNote(text) {
  const note = document.createElement("div");
  note.className = "system-note";
  note.textContent = text;
  messagesEl.appendChild(note);
  scrollToBottom();
}

/** 将后端返回的动作/表情/移动指令转发给 3D 桌宠窗口。 */
async function forwardPetAction(action) {
  if (!action || typeof action !== "object") return;
  try {
    if (typeof globalThis.__chatWindowBridge?.dispatchPetAction === "function") {
      await globalThis.__chatWindowBridge.dispatchPetAction(action);
    } else if (fallbackChannel) {
      fallbackChannel.postMessage(action);
    }
  } catch (error) {
    console.warn("转发桌宠动作指令失败：", error);
  }
}

/** 设置输入区启用/禁用状态，防止并发重复发送。 */
function setSendingState(sending) {
  isSending = sending;
  messageInput.disabled = sending;
  sendBtn.disabled = sending;
  if (!sending) {
    messageInput.focus();
  }
}

/** 发送用户消息并处理后端回复。 */
async function handleSendMessage(event) {
  event.preventDefault();
  if (isSending) return;

  const text = messageInput.value.trim();
  if (!text) return;

  messageInput.value = "";
  appendChatMessage({ role: "user", text });
  setSendingState(true);

  const typingItem = appendChatMessage({
    role: "pet",
    text: "小鲸娘正在思考中…",
    isTyping: true,
  });

  try {
    const response = await fetch(`${API_BASE_URL}/api/v1/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: text,
        session_id: sessionId,
      }),
    });

    if (!response.ok) {
      throw new Error(`服务端响应异常 (HTTP ${response.status})`);
    }

    const data = await response.json();
    typingItem.group.remove();

    appendChatMessage({
      role: "pet",
      text: data.reply || "唔，我好像没想好怎么回答～",
      action: data.action,
    });

    // 更新顶部模式状态（例如用户在运行中刚填好密钥重启后端，这里会自动切换为在线状态）
    if (data.using_mock) {
      updateStatusBadge("demo", "演示模式 · 待在 .env 填入 DeepSeek 密钥");
    } else {
      updateStatusBadge("online", "已连接 DeepSeek");
    }

    // 驱动 3D 桌宠同步做出动作、表情或移动
    if (data.action) {
      await forwardPetAction(data.action);
    }
  } catch (error) {
    typingItem.group.remove();
    updateStatusBadge("offline", "后端未连接 · 请启动 agent-backend (8000)");
    appendChatMessage({
      role: "pet",
      text: `连接后端智能体失败（${error.message}）。\n请确认已在 agent-backend 目录启动服务：\nuv run uvicorn app.main:app --reload --port 8000`,
    });
  } finally {
    setSendingState(false);
  }
}

/** 清空界面消息记录并通知后端清除该会话上下文。 */
async function handleClearChat() {
  if (isSending) return;
  messagesEl.innerHTML = "";
  appendChatMessage({
    role: "pet",
    text: "对话记忆已清空啦，我们重新开始聊吧～🐳",
  });

  try {
    await fetch(`${API_BASE_URL}/api/v1/chat/clear`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId }),
    });
  } catch {
    // 后端未启动时仅清空本地界面即可，无需报错打扰用户
  }
}

/** 初始化对话窗口欢迎语与事件绑定。 */
function initChatWindow() {
  appendChatMessage({
    role: "pet",
    text: "你好呀！我是小鲸娘 🐳\n现在可以直接发消息和我聊天啦（比如试试对我说“跳支舞”或“去左边看看”）！",
  });
  appendSystemNote("提示：在 agent-backend/.env 填入 DEEPSEEK_API_KEY 即可开启大模型对话");

  chatForm.addEventListener("submit", handleSendMessage);
  clearBtn.addEventListener("click", handleClearChat);

  void checkBackendHealth();
  messageInput.focus();
}

initChatWindow();
